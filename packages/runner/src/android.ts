/**
 * Android compile, validation and signing (PRD §6). Compiling runs in the sandbox (Gradle runs
 * the project's build scripts). Signing happens only in the separate signing job, with passwords
 * passed through the environment of the signing tool, never on its command line.
 */

import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfiguration } from '@git2app/shared';
import { run } from './exec.ts';
import type { Logger } from './log.ts';
import { StageError } from './workspace.ts';

export interface AndroidOutputs {
  apk: string | null;
  aab: string | null;
}

async function findFile(dir: string, ext: string): Promise<string | null> {
  try {
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && e.name.endsWith(ext)) return join(e.parentPath ?? (e as any).path, e.name);
    }
  } catch {}
  return null;
}

export async function gradleBuild(androidDir: string, variant: 'debug' | 'release', logger: Logger): Promise<AndroidOutputs> {
  await chmod(join(androidDir, 'gradlew'), 0o755).catch(() => {});
  // Release builds are unsigned here; the signing job signs them.
  const tasks = variant === 'debug' ? ['assembleDebug'] : ['assembleRelease', 'bundleRelease'];
  try {
    await run('./gradlew', [...tasks, '--no-daemon', '--stacktrace', '-Dorg.gradle.jvmargs=-Xmx3g'], { cwd: androidDir, sandbox: true, logger, timeoutMs: 45 * 60_000 });
  } catch (e: any) {
    const tail = String(e.tail ?? '');
    const hint = /SDK location not found|ANDROID_HOME/.test(tail)
      ? 'The Android SDK was not found on the build worker.'
      : /Could not resolve|Could not GET/.test(tail)
        ? 'Gradle could not download a dependency. Retry; if it persists, a plugin version may be wrong.'
        : 'See the first "What went wrong" block in the log.';
    throw new StageError('Gradle compilation failed', hint);
  }
  const outDir = join(androidDir, 'app/build/outputs');
  return {
    apk: await findFile(join(outDir, 'apk', variant), '.apk'),
    aab: variant === 'release' ? await findFile(join(outDir, 'bundle', 'release'), '.aab') : null,
  };
}

function buildTool(name: string): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const v = process.env.G2A_BUILD_TOOLS;
  if (!sdk || !v) return name; // on PATH
  return join(sdk, 'build-tools', v, name);
}

export interface ApkFacts {
  packageId: string;
  versionCode: number;
  versionName: string;
  minSdk: number | null;
  targetSdk: number | null;
  permissions: string[];
}

/** Parse `aapt2 dump badging` output. */
export function parseBadging(text: string): ApkFacts {
  const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(text);
  if (!pkg) throw new StageError('Could not read the APK manifest', 'The APK may be corrupt.');
  const min = /(?:minSdkVersion|sdkVersion):'(\d+)'/.exec(text);
  const target = /targetSdkVersion:'(\d+)'/.exec(text);
  const permissions = [...text.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]!).sort();
  return { packageId: pkg[1]!, versionCode: Number(pkg[2]), versionName: pkg[3]!, minSdk: min ? Number(min[1]) : null, targetSdk: target ? Number(target[1]) : null, permissions };
}

/**
 * Check an APK is what we were asked to build: id, versions, and no permission the user did not
 * enable (plugins sometimes add some; those must be reported, not shipped silently).
 */
export function checkApkFacts(f: ApkFacts, cfg: AppConfiguration, expectedPermissions: string[], minTargetSdk: number): string[] {
  const problems: string[] = [];
  if (f.packageId !== cfg.packageId) problems.push(`Package id is ${f.packageId}, expected ${cfg.packageId}`);
  if (f.versionCode !== cfg.buildNumber) problems.push(`versionCode is ${f.versionCode}, expected ${cfg.buildNumber}`);
  if (f.versionName !== cfg.version) problems.push(`versionName is ${f.versionName}, expected ${cfg.version}`);
  if (f.targetSdk !== null && f.targetSdk < minTargetSdk) problems.push(`targetSdk ${f.targetSdk} is below the required ${minTargetSdk}`);
  // Merged-manifest extras that libraries add and that are harmless (no user-facing prompt).
  const benign = new Set(['android.permission.ACCESS_NETWORK_STATE', 'android.permission.WAKE_LOCK', 'com.google.android.c2dm.permission.RECEIVE', 'android.permission.VIBRATE']);
  const extra = f.permissions.filter((p) => !expectedPermissions.includes(p) && !benign.has(p) && !p.endsWith('.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'));
  if (extra.length) problems.push(`Unexpected permissions in the APK: ${extra.join(', ')}`);
  return problems;
}

export async function apkFacts(apk: string, logger: Logger): Promise<ApkFacts> {
  const out = await run(buildTool('aapt2'), ['dump', 'badging', apk], { cwd: '/', logger: undefined });
  logger.line(`aapt2: ${out.split('\n')[0]}`);
  return parseBadging(out);
}

export async function verifyApkSignature(apk: string, logger: Logger): Promise<void> {
  try {
    await run(buildTool('apksigner'), ['verify', '--min-sdk-version', '24', apk], { cwd: '/', logger });
  } catch {
    throw new StageError('APK signature did not verify', 'Retry the build; if it persists, re-upload the signing key.');
  }
}

/** An AAB is a zip with a base module manifest and bundle config. */
export async function checkAabStructure(aab: string): Promise<void> {
  const list = await run('unzip', ['-Z1', aab], { cwd: '/' });
  for (const need of ['BundleConfig.pb', 'base/manifest/AndroidManifest.xml']) {
    if (!list.split('\n').includes(need)) throw new StageError(`The AAB is missing ${need}`, 'The bundle is malformed; retry the build.');
  }
  if (!list.split('\n').some((l) => l.startsWith('base/dex/'))) throw new StageError('The AAB has no code', 'The bundle is malformed; retry the build.');
}

export interface AndroidKey {
  keystoreB64: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

/** Sign release outputs inside the signing job. The keystore is written 0600 and deleted after. */
export async function signAndroid(outputs: AndroidOutputs, key: AndroidKey, workDir: string, logger: Logger): Promise<AndroidOutputs> {
  for (const s of [key.storePassword, key.keyPassword, key.keystoreB64]) logger.addSecret(s);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const ks = join(workDir, 'upload.jks');
  await writeFile(ks, Buffer.from(key.keystoreB64, 'base64'), { mode: 0o600 });
  const env = { G2A_KS_PASS: key.storePassword, G2A_KEY_PASS: key.keyPassword };
  const signed: AndroidOutputs = { apk: null, aab: null };
  try {
    if (outputs.apk) {
      const aligned = join(workDir, 'app-release-aligned.apk');
      const out = join(workDir, 'app-release.apk');
      await run(buildTool('zipalign'), ['-P', '16', '-f', '4', outputs.apk, aligned], { cwd: workDir, logger });
      await run(buildTool('apksigner'), ['sign', '--ks', ks, '--ks-key-alias', key.keyAlias, '--ks-pass', 'env:G2A_KS_PASS', '--key-pass', 'env:G2A_KEY_PASS', '--out', out, aligned], { cwd: workDir, env, logger });
      signed.apk = out;
    }
    if (outputs.aab) {
      const out = join(workDir, 'app-release.aab');
      await run('cp', [outputs.aab, out], { cwd: workDir });
      await run('jarsigner', ['-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', '-keystore', ks, '-storepass:env', 'G2A_KS_PASS', '-keypass:env', 'G2A_KEY_PASS', out, key.keyAlias], { cwd: workDir, env, logger });
      await run('jarsigner', ['-verify', '-strict', out], { cwd: workDir, logger }).catch(() => {
        throw new StageError('The signed AAB did not verify', 'Check the key alias and passwords of the upload key.');
      });
      signed.aab = out;
    }
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError('Signing failed', 'Check the keystore, key alias and both passwords of the signing credential.');
  } finally {
    await rm(ks, { force: true });
  }
  return signed;
}

export async function fileSize(p: string): Promise<number> {
  return (await stat(p)).size;
}
