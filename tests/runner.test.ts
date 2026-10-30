import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfiguration } from '../packages/shared/src/index.ts';
import { checkApkFacts, parseBadging } from '../packages/runner/src/android.ts';
import { checkProfile, parseProfile, signingEntitlements } from '../packages/runner/src/ios.ts';
import { chooseIcon, isSvg, pngSize } from '../packages/runner/src/icons.ts';
import { sandboxEnv } from '../packages/runner/src/exec.ts';
import { inside, installCommand, builtManifest } from '../packages/runner/src/workspace.ts';
import { Logger } from '../packages/runner/src/log.ts';

const cfg: AppConfiguration = {
  appName: 'Xpenstack',
  packageId: 'com.xpenstack.app',
  bundleId: 'com.xpenstack.app',
  version: '1.2.0',
  buildNumber: 7,
  iconPath: null as any,
  splashPath: null as any,
  themeColor: '#F8FAFC',
  backgroundColor: '#F8FAFC',
  orientation: 'portrait',
  permissions: ['camera', 'notifications'],
  privacyPolicyUrl: 'https://xpenstack.com/privacy',
};

// A minimal PNG header: signature, IHDR length and type, width, height.
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48"/></svg>';

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'g2a-test-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

const BADGING = `package: name='com.xpenstack.app' versionCode='7' versionName='1.2.0' platformBuildVersionName='16'
sdkVersion:'24'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.CAMERA'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.WAKE_LOCK'
uses-permission: name='com.xpenstack.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
application-label:'Xpenstack'`;

test('parseBadging reads id, versions, SDKs and permissions', () => {
  const f = parseBadging(BADGING);
  assert.equal(f.packageId, 'com.xpenstack.app');
  assert.equal(f.versionCode, 7);
  assert.equal(f.versionName, '1.2.0');
  assert.equal(f.minSdk, 24);
  assert.equal(f.targetSdk, 36);
  assert.equal(f.permissions.length, 5);
  assert.throws(() => parseBadging('garbage'), /Could not read the APK manifest/);
});

test('checkApkFacts passes a matching APK and ignores benign library permissions', () => {
  const expected = ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'];
  assert.deepEqual(checkApkFacts(parseBadging(BADGING), cfg, expected, 35), []);
});

test('checkApkFacts reports wrong id, versions, low target SDK and unrequested permissions', () => {
  const bad = parseBadging(BADGING.replace("name='com.xpenstack.app' versionCode='7' versionName='1.2.0'", "name='com.other' versionCode='6' versionName='1.1.0'").replace("targetSdkVersion:'36'", "targetSdkVersion:'33'") + "\nuses-permission: name='android.permission.ACCESS_FINE_LOCATION'");
  const problems = checkApkFacts(bad, cfg, ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'], 35);
  assert.equal(problems.length, 5);
  assert.match(problems.join('\n'), /ACCESS_FINE_LOCATION/);
});

function profile(o: { appId?: string; team?: string; exp?: string; dev?: boolean; push?: boolean } = {}): string {
  return `<?xml version="1.0"?><plist version="1.0"><dict>
<key>ExpirationDate</key><date>${o.exp ?? '2099-01-01T00:00:00Z'}</date>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>${o.appId ?? 'ABCDE12345.com.xpenstack.app'}</string>
${o.push === false ? '' : '<key>aps-environment</key><string>production</string>'}
${o.dev ? '<key>get-task-allow</key><true/>' : '<key>get-task-allow</key><false/>'}
</dict>
${o.dev ? '<key>ProvisionedDevices</key><array><string>00008030</string></array>' : ''}
<key>TeamIdentifier</key><array><string>${o.team ?? 'ABCDE12345'}</string></array>
</dict></plist>`;
}

test('an App Store profile for the bundle id passes', () => {
  const p = parseProfile(profile());
  assert.equal(p.isDistribution, true);
  assert.equal(p.hasPush, true);
  assert.deepEqual(checkProfile(p, 'com.xpenstack.app', 'ABCDE12345', true), []);
});

test('a wildcard profile matches by prefix', () => {
  assert.deepEqual(checkProfile(parseProfile(profile({ appId: 'ABCDE12345.*', push: false })), 'com.xpenstack.app', 'ABCDE12345', false), []);
});

test('profile problems: other app, other team, expired, development, no push', () => {
  const p = parseProfile(profile({ appId: 'ZZZZZ99999.com.other', team: 'ZZZZZ99999', exp: '2020-01-01T00:00:00Z', dev: true, push: false }));
  const problems = checkProfile(p, 'com.xpenstack.app', 'ABCDE12345', true);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.throws(() => parseProfile('<plist/>'), /could not be read/);
});

test('signing entitlements carry production push only when asked', () => {
  assert.match(signingEntitlements('ABCDE12345', 'com.xpenstack.app', true), /aps-environment<\/key><string>production/);
  assert.doesNotMatch(signingEntitlements('ABCDE12345', 'com.xpenstack.app', false), /aps-environment/);
});

test('sandboxEnv passes only the allow-list and drops runner credentials', () => {
  const env = sandboxEnv(
    { PATH: '/usr/bin', GITHUB_TOKEN: 'ghs_x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', SUPABASE_SERVICE_ROLE_KEY: 's', G2A_TICKET: 'k', JAVA_HOME: '/jdk' },
    { VITE_API: 'https://x', GITHUB_TOKEN: 'sneaky', ACTIONS_RUNTIME_TOKEN: 'r', INPUT_JOB_ID: '1' },
    '/home/sb',
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.JAVA_HOME, '/jdk');
  assert.equal(env.HOME, '/home/sb');
  assert.equal(env.VITE_API, 'https://x');
  for (const k of ['GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'G2A_TICKET', 'ACTIONS_RUNTIME_TOKEN', 'INPUT_JOB_ID']) assert.equal(env[k], undefined, k);
});

test('inside() refuses paths that leave the root', () => {
  assert.equal(inside('/w/src', 'a/b'), '/w/src/a/b');
  assert.throws(() => inside('/w/src', '../x'));
  assert.throws(() => inside('/w/src', 'a/../../x'));
  assert.throws(() => inside('/w/src', '/etc/passwd'));
});

test('installCommand uses the lockfile-respecting install of each package manager', () => {
  assert.deepEqual(installCommand('npm', 'package-lock.json'), { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] });
  assert.equal(installCommand('npm', null).args[0], 'install');
  assert.deepEqual(installCommand('pnpm', 'pnpm-lock.yaml').args, ['pnpm', 'install', '--frozen-lockfile']);
  assert.deepEqual(installCommand('yarn', 'yarn.lock').args, ['yarn', 'install', '--immutable']);
});

test('Logger redacts registered secrets, their base64 form and token patterns', async () => {
  let out = '';
  const log = new Logger(async (c) => void (out += c), { echo: false });
  log.addSecret('hunter2-pass');
  log.line('password is hunter2-pass');
  log.line(`b64 ${Buffer.from('hunter2-pass').toString('base64')}`);
  log.line('token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  await log.close();
  assert.doesNotMatch(out, /hunter2-pass/);
  assert.doesNotMatch(out, /aHVudGVyMi1wYXNz/);
  assert.doesNotMatch(out, /ghp_abcdefghij/);
});

test('pngSize and isSvg recognise their formats', () => {
  assert.deepEqual(pngSize(png(512, 512)), { width: 512, height: 512 });
  assert.equal(pngSize(Buffer.from(SVG)), null);
  assert.equal(isSvg(Buffer.from(SVG)), true);
  assert.equal(isSvg(png(1, 1)), false);
});

test('chooseIcon: the built manifest icon is used when it exists', async () => {
  const web = tree({ 'manifest.webmanifest': JSON.stringify({ icons: [{ src: 'icons/a.png' }, { src: 'icons/m.png', purpose: 'maskable' }] }), 'icons/a.png': png(1024, 1024), 'icons/m.png': png(1024, 1024) });
  const m = await builtManifest(web);
  assert.ok(m, 'with no index.html, the root manifest.webmanifest is read');
  const icon = await chooseIcon([{ root: web, manifest: m }], null);
  assert.equal(icon.file, join(web, 'icons/a.png'), 'non-maskable wins at equal size');
  assert.equal(icon.kind, 'png');
});

test('chooseIcon: Vite-style hashed manifest with missing icons falls back to the source project and its SVG', async () => {
  // The Xpenstack case: the built manifest sits under assets/ and points at icons that were never copied.
  const web = tree({ 'index.html': '<link rel="manifest" href="/assets/manifest-x1.webmanifest"><link rel="icon" type="image/svg+xml" href="/assets/logo-h.svg">', 'assets/manifest-x1.webmanifest': JSON.stringify({ icons: [{ src: 'icons/icon-512.png' }] }), 'assets/logo-h.svg': SVG });
  const proj = tree({ 'manifest.webmanifest': JSON.stringify({ icons: [{ src: 'icons/icon-512.png' }, { src: 'icons/mono.png', purpose: 'monochrome' }] }), 'icons/icon-512.png': png(512, 512), 'icons/mono.png': png(2048, 2048) });
  const built = await builtManifest(web);
  assert.ok(built?.path.endsWith('manifest-x1.webmanifest'));
  const sources = [
    { root: web, manifest: built, html: '<link rel="icon" type="image/svg+xml" href="/assets/logo-h.svg">' },
    { root: proj, manifest: { path: join(proj, 'manifest.webmanifest'), json: JSON.parse('{"icons":[{"src":"icons/icon-512.png"},{"src":"icons/mono.png","purpose":"monochrome"}]}') } },
  ];
  const icon = await chooseIcon(sources, null);
  assert.equal(icon.kind, 'svg', 'an SVG beats a 512 PNG; the monochrome 2048 is never an app icon');
  assert.equal(icon.size, 1024);
  // Without the SVG, the 512 PNG from the source manifest is found.
  const png512 = await chooseIcon([{ ...sources[0]!, html: null }, sources[1]!], null);
  assert.equal(png512.file, join(proj, 'icons/icon-512.png'));
  assert.equal(png512.size, 512);
});

test('chooseIcon: a 1024 PNG beats an SVG; an upload beats everything; tiny icons are refused', async () => {
  const web = tree({ 'big.png': png(1024, 1024), 'logo.svg': SVG, 'up.png': png(600, 600), 'small.png': png(192, 192), 'wide.png': png(1024, 512) });
  const src = (icons: string[], html = '') => [{ root: web, manifest: { path: join(web, 'm.json'), json: { icons: icons.map((s) => ({ src: s })) } }, html }];
  assert.equal((await chooseIcon(src(['big.png'], '<link rel="icon" href="/logo.svg" type="image/svg+xml">'), null)).file, join(web, 'big.png'));
  assert.equal((await chooseIcon(src(['big.png']), join(web, 'up.png'))).file, join(web, 'up.png'));
  await assert.rejects(chooseIcon(src(['small.png', 'wide.png']), null), /192×192, too small/);
  await assert.rejects(chooseIcon(src(['missing.png']), null), /No square PNG or SVG icon/);
});

test('chooseIcon never reads outside the source root', async () => {
  const outside = tree({ 'secret.png': png(1024, 1024) });
  const web = tree({ 'm.json': '{}' });
  const rel = join('..', outside.split('/').pop()!, 'secret.png');
  await assert.rejects(chooseIcon([{ root: web, manifest: { path: join(web, 'm.json'), json: { icons: [{ src: rel }, { src: '/../' + rel }] } } }], null), /No square PNG/);
});
