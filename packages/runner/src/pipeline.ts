/**
 * The build pipeline (PRD §6.2, §7.3, §10). One function per job kind. Each stage reports its
 * state before it starts; a failure reports the stage's own failure state with a message that
 * says what went wrong and what to do (principle 11). A build never "succeeds" by skipping a
 * stage (principle 9), and packages are offered only after validation (principle 13).
 */

import { access, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { failureFor, type AnalysisReport, type BuildStage, type BuildStatus } from '@git2app/shared';
import { analyze, FsRepoSource } from '@git2app/analyzer';
import { androidPermissionsFor, TOOLCHAIN } from '@git2app/generator';
import { run, handToSandbox, takeFromSandbox } from './exec.ts';
import type { Logger } from './log.ts';
import type { AnalysisSpec, BuildSpec, Reporter } from './reporter.ts';
import { buildWeb, builtManifest, checkWebOutput, cloneAtCommit, inside, installDependencies, StageError } from './workspace.ts';
import { chooseIcon, type IconSource } from './icons.ts';
import { createCapacitorProject, createTwaProject } from './native.ts';
import { apkFacts, checkAabStructure, checkApkFacts, gradleBuild, signAndroid, verifyApkSignature, type AndroidKey, type AndroidOutputs } from './android.ts';
import { checkAppBundle, signIpa, simulatorBuild, unsignedArchive, type IosKey } from './ios.ts';

export interface PipelineCtx {
  reporter: Reporter;
  logger: Logger;
  workRoot: string; // empty, writable
  /** For local runs: copy this folder instead of cloning. */
  localSource?: string;
}

export interface BuildResult {
  outcome: 'completed' | 'awaiting-signing' | 'failed' | 'cancelled';
  stage: BuildStatus;
  report: Record<string, unknown>;
}

class Stages {
  current: BuildStage = 'QUEUED';
  private readonly ctx: PipelineCtx;
  constructor(ctx: PipelineCtx) {
    this.ctx = ctx;
  }
  async enter(s: BuildStage): Promise<void> {
    this.current = s;
    this.ctx.logger.stage = s;
    this.ctx.logger.line(`--- ${s} ---`);
    await this.ctx.reporter.status(s);
  }
}

function message(e: unknown): string {
  if (e instanceof StageError) return `${e.message}. ${e.hint}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function zipDir(parent: string, name: string, out: string, excludes: string[]): Promise<string> {
  await run('zip', ['-qry', out, name, ...excludes.flatMap((x) => ['-x', x])], { cwd: parent });
  return out;
}

async function getSource(spec: { repo: BuildSpec['repo'] }, ctx: PipelineCtx, dest: string): Promise<void> {
  if (ctx.localSource) {
    ctx.logger.line(`Using local source ${ctx.localSource}`);
    await cp(ctx.localSource, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
    return;
  }
  await cloneAtCommit(spec.repo, dest, ctx.logger);
}

// ------------------------------------------------------------------ analysis job

export async function runAnalysis(spec: AnalysisSpec, ctx: PipelineCtx): Promise<AnalysisReport | null> {
  const src = join(ctx.workRoot, 'src');
  try {
    await getSource(spec, ctx, src);
    // Analysis reads files only; it never installs or runs the repository's code.
    const report = await analyze(new FsRepoSource(src), { projectRoot: spec.repo.projectRoot, hostedOrigin: spec.hostedOrigin });
    ctx.logger.line(report.summary);
    await ctx.reporter.analysis(report);
    return report;
  } catch (e) {
    await ctx.reporter.analysisStatus('FAILED', message(e)).catch(() => {});
    return null;
  }
}

// ------------------------------------------------------------------ build job (untrusted phase)

export async function runBuild(spec: BuildSpec, ctx: PipelineCtx): Promise<BuildResult> {
  const st = new Stages(ctx);
  const report: Record<string, unknown> = { jobId: spec.jobId, platform: spec.platform, strategy: spec.strategy, variant: spec.variant, commitSha: spec.repo.commitSha, toolchain: TOOLCHAIN.id, startedAt: new Date().toISOString() };
  const src = join(ctx.workRoot, 'src');
  const nativeDir = join(ctx.workRoot, 'native');
  const handoff = join(ctx.workRoot, 'handoff');
  try {
    // ANALYZING: re-check at this exact commit; never build something the analysis rules out.
    await st.enter('ANALYZING');
    await getSource(spec, ctx, src);
    const analysis = await analyze(new FsRepoSource(src), { projectRoot: spec.repo.projectRoot, hostedOrigin: spec.build.hostedOrigin });
    report.analysis = { framework: analysis.framework, renderMode: analysis.renderMode, scores: analysis.scores, findings: analysis.findings };
    ctx.logger.line(analysis.summary);
    const rec = spec.platform === 'android' ? analysis.recommendedAndroidStrategy : analysis.recommendedIosStrategy;
    if (rec === 'unsupported') throw new StageError(analysis.summary, 'Fix the blockers in the compatibility report, then build again.');
    const projectDir = inside(src, spec.repo.projectRoot);
    const outputDir = spec.build.outputDir ?? analysis.build.outputDir;
    if (!outputDir) throw new StageError('The build output folder is unknown', 'Set the output folder in the project settings.');

    await st.enter('DEPENDENCY_INSTALLATION');
    await handToSandbox(ctx.workRoot);
    if (analysis.build.buildCommand) await installDependencies(projectDir, analysis.build, ctx.logger);
    else ctx.logger.line('Static site: no dependencies to install.');

    await st.enter('WEB_BUILD');
    await buildWeb(projectDir, analysis.build, ctx.logger);
    const web = await checkWebOutput(projectDir, outputDir);
    ctx.logger.line(`Web output: ${web.files} files, ${(web.bytes / 1048576).toFixed(1)} MB in ${outputDir}`);
    const manifest = await builtManifest(web.dir);

    await st.enter('NATIVE_CONFIGURATION');
    let notes: string[];
    if (spec.strategy === 'twa') {
      if (spec.platform !== 'android') throw new StageError('Trusted Web Activity is Android only', 'Use Capacitor for iOS.');
      if (!spec.build.hostedOrigin) throw new StageError('A Trusted Web Activity needs the hosted https origin', 'Set it in the project settings.');
      notes = (await createTwaProject({ nativeDir, config: spec.config, hostedOrigin: spec.build.hostedOrigin, manifest, logger: ctx.logger })).notes;
    } else {
      const uploaded = spec.config.iconPath && !/^https?:/.test(spec.config.iconPath) ? inside(src, spec.config.iconPath) : null;
      const icon = await chooseIcon(await iconSources(web.dir, manifest, projectDir, analysis.pwa.manifest.accessiblePath), uploaded).catch((e) => {
        throw new StageError(e.message.replace(/\.$/, ''), 'Upload a square PNG icon of at least 1024×1024 in Branding.');
      });
      ctx.logger.line(`Icon source: ${icon.file.slice(src.length + 1)} (${icon.kind === 'svg' ? `SVG, rendered at ${icon.size}×${icon.size}` : `${icon.size}×${icon.size}`})`);
      if (icon.size < 1024) {
        if (spec.platform === 'ios' && spec.variant === 'release') throw new StageError(`The icon is ${icon.size}×${icon.size}; the App Store needs 1024×1024`, 'Upload a 1024×1024 PNG icon in Branding.');
        notes = [`The icon source is ${icon.size}×${icon.size}. Upload a 1024×1024 icon before a store release.`];
        ctx.logger.line(`WARNING: ${notes[0]}`);
      } else notes = [];
      notes.push(...(await createCapacitorProject({ nativeDir, webOutDir: web.dir, platform: spec.platform, variant: spec.variant, config: spec.config, icon, logger: ctx.logger })).notes);
    }
    report.notes = notes;

    await st.enter('PLATFORM_COMPILATION');
    let androidOut: AndroidOutputs | null = null;
    let iosApp: string | null = null;
    if (spec.platform === 'android') androidOut = await gradleBuild(join(nativeDir, 'android'), spec.variant, ctx.logger);
    else iosApp = spec.variant === 'debug' ? await simulatorBuild(nativeDir, ctx.logger) : await unsignedArchive(nativeDir, ctx.logger);
    // Untrusted code is finished: stop its processes and take the files back before packaging.
    await takeFromSandbox(ctx.workRoot);

    const projZip = join(ctx.workRoot, `${spec.platform}-project.zip`);
    const projName = spec.platform === 'android' ? 'android' : 'ios';
    await zipDir(nativeDir, projName, projZip, [`${projName}/app/build/*`, `${projName}/build/*`, `${projName}/.gradle/*`, `${projName}/App/build/*`, '*/DerivedData/*']);
    await ctx.reporter.upload(spec.platform === 'android' ? 'android-project' : 'ios-project', projZip, false);

    // SIGNING: debug builds are debug-signed by the toolchain; release builds go to the signing job.
    await st.enter('SIGNING');
    if (spec.variant === 'release') {
      await mkdir(handoff, { recursive: true });
      if (androidOut?.apk) await cp(androidOut.apk, join(handoff, 'app-release-unsigned.apk'));
      if (androidOut?.aab) await cp(androidOut.aab, join(handoff, 'app-release.aab'));
      if (iosApp) await cp(iosApp, join(handoff, 'App.app'), { recursive: true, verbatimSymlinks: true });
      await writeFile(join(handoff, 'handoff.json'), JSON.stringify({ jobId: spec.jobId, platform: spec.platform, report }, null, 2));
      ctx.logger.line('Unsigned outputs handed to the signing job.');
      return { outcome: 'awaiting-signing', stage: 'SIGNING', report };
    }

    await st.enter('VALIDATION');
    if (spec.platform === 'android') {
      const apk = androidOut?.apk;
      if (!apk) throw new StageError('Gradle finished but produced no APK', 'See the Gradle output in the log.');
      const facts = await apkFacts(apk, ctx.logger);
      const problems = checkApkFacts(facts, spec.config, androidPermissionsFor(spec.config.permissions), TOOLCHAIN.androidTargetSdk);
      if (spec.strategy === 'twa') problems.splice(0, problems.length, ...problems.filter((p) => !p.startsWith('Unexpected permissions')));
      if (problems.length) throw new StageError(problems.join('. '), 'This is a Git2App problem if your settings are right; report it with the build id.');
      await verifyApkSignature(apk, ctx.logger);
      report.validation = { apk: facts };
      await ctx.reporter.upload('apk', apk, true);
    } else {
      const app = iosApp!;
      const problems = await checkAppBundle(app, spec.config);
      if (problems.length) throw new StageError(problems.join('. '), 'Report this with the build id.');
      const zip = join(ctx.workRoot, 'App-simulator.zip');
      await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { cwd: ctx.workRoot });
      report.validation = { simulatorApp: 'ok' };
      await ctx.reporter.upload('ios-simulator-app', zip, true);
    }
    await finishReport(ctx, report);
    await st.enter('COMPLETED');
    return { outcome: 'completed', stage: 'COMPLETED', report };
  } catch (e: any) {
    if (e?.cancelled) return { outcome: 'cancelled', stage: 'CANCELLED', report };
    const msg = message(e);
    ctx.logger.line(`FAILED at ${st.current}: ${msg}`);
    report.error = { stage: st.current, message: msg };
    await finishReport(ctx, report).catch(() => {});
    const fail = st.current === 'QUEUED' ? 'FAILED_ANALYSIS' : failureFor(st.current);
    await ctx.reporter.status(fail, msg).catch(() => {});
    return { outcome: 'failed', stage: fail, report };
  } finally {
    await takeFromSandbox(ctx.workRoot).catch(() => {});
    await ctx.logger.flush();
  }
}

async function finishReport(ctx: PipelineCtx, report: Record<string, unknown>): Promise<void> {
  report.finishedAt = new Date().toISOString();
  const f = join(ctx.workRoot, 'build-report.json');
  await writeFile(f, JSON.stringify(report, null, 2));
  await ctx.reporter.upload('report', f, true);
}

// ------------------------------------------------------------------ signing job (trusted phase)

export async function runSigning(opts: {
  ctx: PipelineCtx;
  handoffDir: string;
  spec: BuildSpec;
  signing: Record<string, string>;
}): Promise<BuildResult> {
  const { ctx, spec } = opts;
  const st = new Stages(ctx);
  st.current = 'SIGNING';
  ctx.logger.stage = 'SIGNING';
  const handoff = JSON.parse(await readFile(join(opts.handoffDir, 'handoff.json'), 'utf8')) as { jobId: string; report: Record<string, unknown> };
  if (handoff.jobId !== spec.jobId) throw new Error('Handoff belongs to another build');
  const report = handoff.report;
  const keyDir = join(ctx.workRoot, 'keys');
  try {
    if (spec.platform === 'android') {
      const unsigned: AndroidOutputs = {
        apk: await exists(join(opts.handoffDir, 'app-release-unsigned.apk')),
        aab: await exists(join(opts.handoffDir, 'app-release.aab')),
      };
      const signed = await signAndroid(unsigned, opts.signing as unknown as AndroidKey, keyDir, ctx.logger);
      await st.enter('VALIDATION');
      if (!signed.aab) throw new StageError('No AAB was produced', 'See the build log.');
      await checkAabStructure(signed.aab);
      if (signed.apk) {
        const facts = await apkFacts(signed.apk, ctx.logger);
        const problems = checkApkFacts(facts, spec.config, androidPermissionsFor(spec.config.permissions), TOOLCHAIN.androidTargetSdk);
        if (spec.strategy === 'twa') problems.splice(0, problems.length, ...problems.filter((p) => !p.startsWith('Unexpected permissions')));
        if (problems.length) throw new StageError(problems.join('. '), 'Report this with the build id.');
        await verifyApkSignature(signed.apk, ctx.logger);
        report.validation = { apk: facts, aab: 'signed and verified' };
        await ctx.reporter.upload('apk', signed.apk, true);
      }
      await ctx.reporter.upload('aab', signed.aab, true);
    } else {
      const ipa = await signIpa(join(opts.handoffDir, 'App.app'), spec.config, opts.signing as unknown as IosKey, keyDir, ctx.logger);
      await st.enter('VALIDATION');
      const unz = join(ctx.workRoot, 'ipa-check');
      await run('unzip', ['-q', ipa, '-d', unz], { cwd: ctx.workRoot });
      const problems = await checkAppBundle(join(unz, 'Payload/App.app'), spec.config);
      if (problems.length) throw new StageError(problems.join('. '), 'Report this with the build id.');
      await run('codesign', ['--verify', '--deep', '--strict', join(unz, 'Payload/App.app')], { cwd: '/', logger: ctx.logger });
      report.validation = { ipa: 'signed, verified, identity and versions match' };
      await ctx.reporter.upload('ipa', ipa, true);
    }
    report.storeNote = 'A signed package is ready to upload. Store approval is decided by Apple and Google, not by this build.';
    await finishReport(ctx, report);
    await st.enter('COMPLETED');
    return { outcome: 'completed', stage: 'COMPLETED', report };
  } catch (e: any) {
    if (e?.cancelled) return { outcome: 'cancelled', stage: 'CANCELLED', report };
    const msg = message(e);
    ctx.logger.line(`FAILED at ${st.current}: ${msg}`);
    const fail = failureFor(st.current);
    await ctx.reporter.status(fail, msg).catch(() => {});
    return { outcome: 'failed', stage: fail, report };
  } finally {
    await rm(keyDir, { recursive: true, force: true });
    await ctx.logger.flush();
  }
}

async function exists(p: string): Promise<string | null> {
  try {
    await access(p);
    return p;
  } catch {
    return null;
  }
}

/**
 * Where icons may be: the built output first, then the source project's manifest (whose "/"
 * maps to public/ or static/ when it lives there, else to the project folder) and its index.html.
 */
async function iconSources(webDir: string, built: { path: string; json: any } | null, projectDir: string, sourceManifest: string | null): Promise<IconSource[]> {
  const text = (p: string) => readFile(p, 'utf8').catch(() => null);
  const sources: IconSource[] = [{ root: webDir, manifest: built, html: await text(join(webDir, 'index.html')) }];
  let manifest: { path: string; json: any } | null = null;
  if (sourceManifest) {
    const p = inside(projectDir, sourceManifest);
    try {
      manifest = { path: p, json: JSON.parse((await text(p)) ?? '') };
    } catch {}
  }
  const pub = /^(public|static)\//.exec(sourceManifest ?? '')?.[1];
  if (pub) sources.push({ root: join(projectDir, pub), manifest });
  sources.push({ root: projectDir, manifest: pub ? null : manifest, html: await text(join(projectDir, 'index.html')) });
  if (!pub) sources.push({ root: join(projectDir, 'public'), manifest: null });
  return sources;
}
