/**
 * iOS compile, validation and signing (PRD §7). Only ever on macOS (principle 4: the runner
 * refuses to start an iOS step anywhere else). The build job compiles without any signing
 * identity; the signing job (fresh macOS VM, never runs repository code) signs the archived app
 * with the user's certificate and provisioning profile and packages the IPA.
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppConfiguration } from '@git2app/shared';
import { run } from './exec.ts';
import type { Logger } from './log.ts';
import { StageError } from './workspace.ts';

export function assertMac(): void {
  if (process.platform !== 'darwin') throw new StageError('iOS builds run only on macOS workers', 'This is a platform safeguard; the job was sent to the wrong worker.');
}

const PROJECT = 'ios/App/App.xcodeproj';

/** Debug: a simulator build (no signing, runs in the iOS Simulator). */
export async function simulatorBuild(nativeDir: string, logger: Logger): Promise<string> {
  assertMac();
  const derived = join(nativeDir, 'build-sim');
  try {
    await run(
      'xcodebuild',
      ['-project', PROJECT, '-scheme', 'App', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build'],
      { cwd: nativeDir, sandbox: true, logger, timeoutMs: 60 * 60_000 },
    );
  } catch {
    throw new StageError('Xcode build failed', 'See the first "error:" line in the log.');
  }
  return join(derived, 'Build/Products/Debug-iphonesimulator/App.app');
}

/** Release: an unsigned device archive, signed later by the signing job. */
export async function unsignedArchive(nativeDir: string, logger: Logger): Promise<string> {
  assertMac();
  const archive = join(nativeDir, 'build', 'App.xcarchive');
  try {
    await run(
      'xcodebuild',
      ['-project', PROJECT, '-scheme', 'App', '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-archivePath', archive, 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'archive'],
      { cwd: nativeDir, sandbox: true, logger, timeoutMs: 60 * 60_000 },
    );
  } catch {
    throw new StageError('Xcode archive failed', 'See the first "error:" line in the log.');
  }
  return join(archive, 'Products/Applications/App.app');
}

async function plistValue(plist: string, key: string): Promise<string> {
  return (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { cwd: '/' })).trim();
}

/** The built app must carry the configured identity and versions. */
export async function checkAppBundle(app: string, cfg: AppConfiguration): Promise<string[]> {
  const info = join(app, 'Info.plist');
  const problems: string[] = [];
  const id = await plistValue(info, 'CFBundleIdentifier');
  const ver = await plistValue(info, 'CFBundleShortVersionString');
  const build = await plistValue(info, 'CFBundleVersion');
  if (id !== cfg.bundleId) problems.push(`Bundle id is ${id}, expected ${cfg.bundleId}`);
  if (ver !== cfg.version) problems.push(`Version is ${ver}, expected ${cfg.version}`);
  if (build !== String(cfg.buildNumber)) problems.push(`Build number is ${build}, expected ${cfg.buildNumber}`);
  return problems;
}

export interface IosKey {
  p12B64: string;
  p12Password: string;
  profileB64: string;
  teamId: string;
}

export interface ProfileFacts {
  teamId: string;
  appId: string; // e.g. TEAMID.com.example.app or TEAMID.*
  expires: Date;
  hasPush: boolean;
  isDistribution: boolean;
}

/** What a provisioning profile allows, from its decoded plist (`security cms -D`). */
export function parseProfile(plistXml: string): ProfileFacts {
  const str = (k: string) => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(plistXml)?.[1];
  const teamId = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plistXml)?.[1];
  const appId = str('application-identifier');
  const exp = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(plistXml)?.[1];
  if (!teamId || !appId || !exp) throw new StageError('The provisioning profile could not be read', 'Upload the .mobileprovision file downloaded from the Apple Developer site.');
  const getTaskAllow = /<key>get-task-allow<\/key>\s*<true\/>/.test(plistXml);
  const hasDevices = /<key>ProvisionedDevices<\/key>/.test(plistXml);
  return { teamId, appId, expires: new Date(exp), hasPush: /<key>aps-environment<\/key>/.test(plistXml), isDistribution: !getTaskAllow && !hasDevices };
}

/** A profile fits when its app id matches the bundle id exactly or by wildcard, and it is valid. */
export function checkProfile(p: ProfileFacts, bundleId: string, teamId: string, needsPush: boolean, now = new Date()): string[] {
  const problems: string[] = [];
  if (p.teamId !== teamId) problems.push(`Profile team ${p.teamId} does not match team ${teamId}`);
  const want = `${p.teamId}.${bundleId}`;
  const ok = p.appId === want || (p.appId.endsWith('.*') && want.startsWith(p.appId.slice(0, -1)));
  if (!ok) problems.push(`Profile is for ${p.appId}, not ${want}`);
  if (p.expires.getTime() < now.getTime()) problems.push(`Profile expired on ${p.expires.toISOString().slice(0, 10)}`);
  if (!p.isDistribution) problems.push('Profile is a development profile; App Store builds need an App Store distribution profile');
  if (needsPush && !p.hasPush) problems.push('The app uses push notifications but the profile has no Push Notifications capability');
  return problems;
}

export function signingEntitlements(teamId: string, bundleId: string, push: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>application-identifier</key><string>${teamId}.${bundleId}</string>`,
    `<key>com.apple.developer.team-identifier</key><string>${teamId}</string>`,
    '<key>get-task-allow</key><false/>',
    `<key>keychain-access-groups</key><array><string>${teamId}.${bundleId}</string></array>`,
    push ? '<key>aps-environment</key><string>production</string>' : '',
    '</dict></plist>',
    '',
  ].join('\n');
}

/**
 * Sign an unsigned .app and package an IPA. A throwaway keychain with a random password holds
 * the certificate for the life of this function only.
 */
export async function signIpa(appPath: string, cfg: AppConfiguration, key: IosKey, workDir: string, logger: Logger): Promise<string> {
  assertMac();
  for (const s of [key.p12Password, key.p12B64, key.profileB64]) logger.addSecret(s);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const kc = join(workDir, `g2a-${randomBytes(4).toString('hex')}.keychain-db`);
  const kcPass = randomBytes(24).toString('hex');
  logger.addSecret(kcPass);
  const p12 = join(workDir, 'cert.p12');
  const profile = join(workDir, 'profile.mobileprovision');
  await writeFile(p12, Buffer.from(key.p12B64, 'base64'), { mode: 0o600 });
  await writeFile(profile, Buffer.from(key.profileB64, 'base64'), { mode: 0o600 });
  const originalKeychains = (await run('security', ['list-keychains', '-d', 'user'], { cwd: '/' })).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  try {
    const decoded = await run('security', ['cms', '-D', '-i', profile], { cwd: '/' });
    const facts = parseProfile(decoded);
    const push = cfg.permissions.includes('notifications');
    const problems = checkProfile(facts, cfg.bundleId, key.teamId, push);
    if (problems.length) throw new StageError(problems.join('. '), 'Create an App Store provisioning profile for this bundle id on developer.apple.com and upload it again.');

    await run('security', ['create-keychain', '-p', kcPass, kc], { cwd: '/' });
    await run('security', ['set-keychain-settings', '-lut', '3600', kc], { cwd: '/' });
    await run('security', ['unlock-keychain', '-p', kcPass, kc], { cwd: '/' });
    await run('security', ['import', p12, '-k', kc, '-P', key.p12Password, '-T', '/usr/bin/codesign'], { cwd: '/' });
    await run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', kcPass, kc], { cwd: '/' });
    await run('security', ['list-keychains', '-d', 'user', '-s', kc, ...originalKeychains], { cwd: '/' });
    const ids = await run('security', ['find-identity', '-v', '-p', 'codesigning', kc], { cwd: '/' });
    const identity = /\)\s+([0-9A-F]{40})\s+"(Apple Distribution|iPhone Distribution)/.exec(ids)?.[1];
    if (!identity) throw new StageError('No distribution certificate in the uploaded .p12', 'Export the Apple Distribution certificate with its private key as a .p12.');

    const work = join(workDir, 'Payload');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const app = join(work, 'App.app');
    await cp(appPath, app, { recursive: true, verbatimSymlinks: true });
    await cp(profile, join(app, 'embedded.mobileprovision'));
    const entPath = join(workDir, 'sign.entitlements');
    await writeFile(entPath, signingEntitlements(key.teamId, cfg.bundleId, push));

    // Inner code first, then the app with its entitlements.
    const fw = join(app, 'Frameworks');
    for (const name of await readdir(fw).catch(() => [] as string[])) {
      if (name.endsWith('.framework') || name.endsWith('.dylib')) {
        await run('codesign', ['--force', '--sign', identity, '--keychain', kc, join(fw, name)], { cwd: '/', logger });
      }
    }
    await run('codesign', ['--force', '--sign', identity, '--keychain', kc, '--entitlements', entPath, app], { cwd: '/', logger });
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { cwd: '/', logger });

    const ipa = join(workDir, `${cfg.appName.replace(/[^\w-]/g, '') || 'App'}.ipa`);
    await run('zip', ['-qry', ipa, 'Payload'], { cwd: workDir });
    return ipa;
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError('iOS signing failed', 'Check the .p12 password, that the certificate is Apple Distribution, and that the profile matches the bundle id.');
  } finally {
    await run('security', ['list-keychains', '-d', 'user', '-s', ...originalKeychains], { cwd: '/' }).catch(() => {});
    await run('security', ['delete-keychain', kc], { cwd: '/' }).catch(() => {});
    await rm(p12, { force: true });
    await rm(profile, { force: true });
  }
}
