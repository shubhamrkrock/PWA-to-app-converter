import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfiguration } from '../packages/shared/src/index.ts';
import { validateConfig } from '../packages/shared/src/validate.ts';
import {
  capacitorPlan,
  patchAppBuildGradle,
  patchAndroidManifest,
  patchPbxproj,
  patchInfoPlist,
  entitlements,
  twaManifest,
  assetLinks,
  PatchError,
} from '../packages/generator/src/index.ts';

const fx = (p: string) => readFileSync(new URL(`./fixtures/cap8/${p}`, import.meta.url), 'utf8');

const base: AppConfiguration = {
  appName: 'Xpenstack',
  packageId: 'com.xpenstack.app',
  bundleId: 'com.xpenstack.app',
  version: '1.2.3',
  buildNumber: 17,
  iconPath: null,
  splashPath: null,
  themeColor: '#0F172A',
  backgroundColor: '#F8FAFC',
  orientation: 'default',
  permissions: [],
  privacyPolicyUrl: 'https://xpenstack.com/privacy',
};

const plistValid = (xml: string) => {
  // xmllint ships with libxml2 on the CI images; skip the structural check if absent.
  try {
    const d = mkdtempSync(join(tmpdir(), 'plist-'));
    writeFileSync(join(d, 'Info.plist'), xml);
    execFileSync('xmllint', ['--noout', join(d, 'Info.plist')], { stdio: 'pipe' });
    return true;
  } catch (e: any) {
    if (e.code === 'ENOENT') return true;
    throw new Error(String(e.stderr ?? e));
  }
};

test('android gradle: version name and code are set', () => {
  const out = patchAppBuildGradle(fx('android/build.gradle.txt'), base);
  assert.match(out, /versionCode 17\b/);
  assert.match(out, /versionName "1\.2\.3"/);
});

test('android manifest: only INTERNET when no permissions are enabled', () => {
  const out = patchAndroidManifest(fx('android/AndroidManifest.xml'), base);
  assert.equal((out.match(/uses-permission/g) ?? []).length, 1);
  assert.match(out, /android\.permission\.INTERNET/);
});

test('android manifest: exactly the enabled permissions, camera optional, portrait, url scheme', () => {
  const out = patchAndroidManifest(fx('android/AndroidManifest.xml'), { ...base, permissions: ['camera', 'notifications'], orientation: 'portrait', urlScheme: 'xpenstack' });
  const perms = [...out.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(perms, ['android.permission.CAMERA', 'android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS']);
  assert.match(out, /android\.hardware\.camera" android:required="false"/);
  assert.match(out, /android:screenOrientation="portrait"/);
  assert.match(out, /<data android:scheme="xpenstack" \/>/);
  assert.doesNotMatch(out, /LOCATION|RECORD_AUDIO/);
  // the launcher intent filter is untouched
  assert.match(out, /android\.intent\.category\.LAUNCHER/);
});

test('ios pbxproj: version, build number and bundle id in every configuration', () => {
  const out = patchPbxproj(fx('ios/project.pbxproj'), { ...base, bundleId: 'com.xpenstack.ios' });
  assert.equal((out.match(/MARKETING_VERSION = 1\.2\.3;/g) ?? []).length, 2);
  assert.equal((out.match(/CURRENT_PROJECT_VERSION = 17;/g) ?? []).length, 2);
  assert.equal((out.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.xpenstack\.ios;/g) ?? []).length, 2);
});

test('ios Info.plist: usage text for each enabled permission, escaped, still valid XML', () => {
  const out = patchInfoPlist(fx('ios/Info.plist'), {
    ...base,
    permissions: ['camera', 'photos', 'notifications'],
    permissionText: { camera: 'Xpenstack photographs receipts so you don\'t type them <ever> & again.' },
    urlScheme: 'xpenstack',
  });
  assert.match(out, /<key>NSCameraUsageDescription<\/key>\s*<string>Xpenstack photographs receipts so you don&apos;t type them &lt;ever&gt; &amp; again\.<\/string>/);
  assert.match(out, /NSPhotoLibraryUsageDescription/);
  assert.match(out, /NSPhotoLibraryAddUsageDescription/);
  assert.match(out, /<string>remote-notification<\/string>/);
  assert.match(out, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>xpenstack<\/string>/);
  assert.doesNotMatch(out, /NSLocationWhenInUseUsageDescription|NSMicrophoneUsageDescription/);
  assert.ok(plistValid(out));
});

test('ios Info.plist: portrait locks both iPhone and iPad orientation lists', () => {
  const out = patchInfoPlist(fx('ios/Info.plist'), { ...base, orientation: 'portrait' });
  assert.doesNotMatch(out, /Landscape/);
  assert.equal((out.match(/UIInterfaceOrientationPortrait</g) ?? []).length, 2);
  assert.ok(plistValid(out));
});

test('ios: no permissions means no usage keys at all', () => {
  const out = patchInfoPlist(fx('ios/Info.plist'), base);
  assert.doesNotMatch(out, /UsageDescription/);
});

test('ios entitlements: push only when notifications are on; production for release', () => {
  assert.equal(entitlements(base, 'release'), null);
  assert.match(entitlements({ permissions: ['notifications'] }, 'release')!, /<string>production<\/string>/);
  assert.match(entitlements({ permissions: ['notifications'] }, 'debug')!, /<string>development<\/string>/);
});

test('patches fail loudly when the template changes', () => {
  assert.throws(() => patchAppBuildGradle('android { }', base), PatchError);
  assert.throws(() => patchAndroidManifest('<manifest></manifest>', base), PatchError);
  assert.throws(() => patchPbxproj('nothing here', base), PatchError);
});

test('capacitor plan: webDir is the detected folder, plugins only for enabled permissions, versions pinned', () => {
  const plan = capacitorPlan({ ...base, permissions: ['notifications', 'camera'] }, 'pages');
  assert.equal(plan.capacitorConfig.webDir, 'pages');
  assert.equal(plan.capacitorConfig.appId, 'com.xpenstack.app');
  assert.ok(plan.packages['@capacitor/push-notifications']);
  assert.equal(plan.packages['@capacitor/camera'], undefined); // camera works through the WebView
  for (const v of Object.values(plan.packages)) assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.ok(plan.notes.some((n) => /Web Push does not work/.test(n)));
  assert.ok(plan.notes.some((n) => /camera explanation uses default text/.test(n)));
  assert.throws(() => capacitorPlan(base, '../outside'));
});

test('twa manifest and asset links', () => {
  const m = twaManifest({ config: base, hostedOrigin: 'https://app.xpenstack.com', startUrl: 'index.html', webManifestUrl: 'https://app.xpenstack.com/manifest.webmanifest', iconUrl: 'https://app.xpenstack.com/icons/icon-512.png', maskableIconUrl: null, enableNotifications: false });
  assert.equal(m.host, 'app.xpenstack.com');
  assert.equal(m.startUrl, '/index.html');
  assert.equal(m.appVersionCode, 17);
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
  const links = JSON.parse(assetLinks('com.xpenstack.app', [fp]));
  assert.equal(links[0].target.package_name, 'com.xpenstack.app');
  assert.equal(links[0].target.sha256_cert_fingerprints[0], fp.toUpperCase());
  assert.throws(() => assetLinks('com.x.y', ['nope']));
  assert.throws(() => assetLinks('com.x.y', []));
});

test('config validation: url scheme and permission text rules', () => {
  const ok = validateConfig({ ...base, urlScheme: 'xpenstack', permissionText: { camera: 'Photograph your receipts to read them.' } });
  assert.equal(ok.ok, true);
  const bad = validateConfig({ ...base, urlScheme: 'https', permissionText: { camera: 'short' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ['permissionText', 'urlScheme']);
});
