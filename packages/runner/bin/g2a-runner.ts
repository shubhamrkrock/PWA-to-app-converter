#!/usr/bin/env node
/**
 * Build worker entry point.
 *
 *   g2a-runner analysis --job <id> --api <https://api>        (Linux job workflow)
 *   g2a-runner build    --job <id> --api <https://api>        (Linux or macOS job workflow)
 *   g2a-runner sign     --job <id> --api <https://api> --handoff <dir>   (signing job)
 *   g2a-runner local    --source <dir> --platform android|ios --config <file.json> --out <dir> [--root apps/web]
 *
 * Exit code: 0 completed or handed to signing, 1 failed, 3 cancelled.
 */
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateConfig } from '@git2app/shared';
import { Logger } from '../src/log.ts';
import { ApiReporter, LocalReporter, type AnalysisSpec, type BuildSpec } from '../src/reporter.ts';
import { runAnalysis, runBuild, runSigning } from '../src/pipeline.ts';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const need = (n: string) => {
  const v = flag(n);
  if (!v) {
    console.error(`--${n} is required`);
    process.exit(2);
  }
  return v;
};

async function workRoot(): Promise<string> {
  return mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'g2a-'));
}

const exitFor = (o: string) => (o === 'completed' || o === 'awaiting-signing' ? 0 : o === 'cancelled' ? 3 : 1);

async function main(): Promise<number> {
  if (mode === 'analysis') {
    const reporter = await ApiReporter.claim(need('api'), 'analysis', need('job'));
    const logger = new Logger((c) => reporter.log(c));
    logger.addSecret(reporter.ticketValue);
    const spec = await reporter.spec<AnalysisSpec>();
    const r = await runAnalysis(spec, { reporter, logger, workRoot: await workRoot() });
    await logger.close();
    return r ? 0 : 1;
  }
  if (mode === 'build') {
    const reporter = await ApiReporter.claim(need('api'), 'build', need('job'));
    const logger = new Logger((c) => reporter.log(c));
    logger.addSecret(reporter.ticketValue);
    const spec = await reporter.spec<BuildSpec>();
    logger.addSecret(spec.repo.cloneToken);
    const r = await runBuild(spec, { reporter, logger, workRoot: await workRoot() });
    await logger.close();
    // Tell the workflow whether the signing job should run.
    if (process.env.GITHUB_OUTPUT) await import('node:fs').then((fs) => fs.appendFileSync(process.env.GITHUB_OUTPUT!, `needs_signing=${r.outcome === 'awaiting-signing'}\nhandoff=${r.outcome === 'awaiting-signing' ? 'yes' : 'no'}\n`));
    return exitFor(r.outcome);
  }
  if (mode === 'sign') {
    const { reporter, signing } = await ApiReporter.forSigning(need('api'), need('job'));
    const logger = new Logger((c) => reporter.log(c));
    logger.addSecret(reporter.ticketValue);
    for (const v of Object.values(signing)) logger.addSecret(v);
    const spec = await reporter.spec<BuildSpec>();
    logger.addSecret(spec.repo.cloneToken);
    const r = await runSigning({ ctx: { reporter, logger, workRoot: await workRoot() }, handoffDir: resolve(need('handoff')), spec, signing });
    await logger.close();
    return exitFor(r.outcome);
  }
  if (mode === 'local') {
    const source = resolve(need('source'));
    const platform = need('platform') as 'android' | 'ios';
    const v = validateConfig(JSON.parse(await readFile(need('config'), 'utf8')));
    if (!v.ok) {
      console.error('Invalid config:', v.errors);
      return 2;
    }
    let sha = '0'.repeat(40);
    try {
      sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD']).toString().trim();
    } catch {}
    const reporter = new LocalReporter(resolve(need('out')));
    const logger = new Logger((c) => reporter.log(c));
    const spec: BuildSpec = {
      kind: 'build',
      jobId: '00000000-0000-4000-8000-000000000000',
      platform,
      strategy: (flag('strategy') as 'capacitor' | 'twa') ?? 'capacitor',
      variant: 'debug',
      repo: { fullName: 'local', cloneUrl: '', commitSha: sha, projectRoot: flag('root') ?? '', cloneToken: null },
      build: { outputDir: flag('output-dir'), hostedOrigin: flag('origin') },
      config: v.config,
      needsSigning: false,
    };
    const r = await runBuild(spec, { reporter, logger, workRoot: await workRoot(), localSource: source });
    await logger.close();
    console.log(JSON.stringify({ outcome: r.outcome, stage: r.stage, artifacts: reporter.artifacts }, null, 2));
    return exitFor(r.outcome);
  }
  console.error('usage: g2a-runner analysis|build|sign|local ...');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`g2a-runner: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
