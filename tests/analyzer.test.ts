import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyze, MemRepoSource, FsRepoSource } from '../packages/analyzer/src/index.ts';
import { FIXTURES } from './fixtures.ts';

const run = (name: string, opts = {}) => analyze(new MemRepoSource(FIXTURES[name]!), opts);
const codes = (r: Awaited<ReturnType<typeof analyze>>) => r.findings.map((f) => f.code);

test('1. React + Vite PWA: detected, installable, Capacitor on both, output dist', async () => {
  const r = await run('react-vite-pwa');
  assert.equal(r.framework, 'vite');
  assert.equal(r.pwa.isInstallablePwa, true);
  assert.equal(r.build.outputDir, 'dist');
  assert.equal(r.recommendedAndroidStrategy, 'capacitor');
  assert.equal(r.recommendedIosStrategy, 'capacitor');
});

test('1b. React + Vite PWA with a hosted HTTPS origin and no native needs: Android TWA, iOS Capacitor', async () => {
  const r = await run('react-vite-pwa', { hostedOrigin: 'https://demo.example.com' });
  assert.equal(r.recommendedAndroidStrategy, 'twa');
  assert.equal(r.recommendedIosStrategy, 'capacitor'); // independent per platform
  assert.ok(codes(r).includes('APPLE_MIN_FUNCTIONALITY'));
});

test('2. React + Vite non-PWA: not installable, custom outDir read from config', async () => {
  const r = await run('react-vite-nonpwa');
  assert.equal(r.pwa.isInstallablePwa, false);
  assert.equal(r.build.outputDir, 'web-out');
  assert.ok(codes(r).includes('NO_MANIFEST'));
});

test('3. Vue PWA: vue, pnpm, service worker from vite-plugin-pwa', async () => {
  const r = await run('vue-pwa');
  assert.equal(r.framework, 'vue');
  assert.equal(r.build.packageManager, 'pnpm');
  assert.equal(r.pwa.serviceWorker.registered, true);
});

test('4. Angular PWA: angular, outputPath from angular.json', async () => {
  const r = await run('angular-pwa');
  assert.equal(r.framework, 'angular');
  assert.equal(r.build.outputDir, 'dist/app/browser');
  assert.equal(r.pwa.manifest.present, true);
});

test('5. Vanilla JS PWA without package.json: static, no build step', async () => {
  const r = await run('vanilla-pwa');
  assert.equal(r.framework, 'static');
  assert.equal(r.build.buildCommand, null);
  assert.equal(r.build.outputDir, '.');
  assert.equal(r.pwa.isInstallablePwa, true);
});

test('6. Next.js static export is packageable', async () => {
  const r = await run('next-static');
  assert.equal(r.framework, 'next');
  assert.equal(r.renderMode, 'static-export');
  assert.notEqual(r.recommendedIosStrategy, 'unsupported');
});

test('7. Next.js server app is reported unsupported, never a false success', async () => {
  const r = await run('next-server');
  assert.equal(r.renderMode, 'server-rendered');
  assert.equal(r.recommendedAndroidStrategy, 'unsupported');
  assert.equal(r.recommendedIosStrategy, 'unsupported');
  assert.ok(codes(r).includes('NEEDS_SERVER'));
  assert.match(r.summary, /Not packageable/);
  assert.equal(r.scores.android, 0);
});

test('8. Offline PWA: service worker found, offline likely', async () => {
  const r = await run('offline-pwa');
  assert.equal(r.pwa.offlineLikely, true);
});

test('9. Camera PWA: camera detected, Android pushed to Capacitor even with an origin', async () => {
  const r = await run('camera-pwa', { hostedOrigin: 'https://demo.example.com' });
  assert.ok(codes(r).includes('NATIVE_CAMERA'));
  assert.equal(r.recommendedAndroidStrategy, 'capacitor');
});

test('10. Push PWA: notifications detected', async () => {
  const r = await run('push-pwa');
  assert.ok(codes(r).includes('NATIVE_NOTIFICATIONS'));
});

test('11. Missing manifest lowers the PWA score and says why', async () => {
  const r = await run('no-manifest');
  assert.ok(r.scores.pwa <= 55);
  assert.ok(codes(r).includes('NO_MANIFEST'));
});

test('12. Invalid build config: no build script and broken manifest are reported', async () => {
  const r = await run('invalid-build');
  assert.ok(codes(r).includes('NO_BUILD_SCRIPT'));
  assert.ok(codes(r).includes('NO_LOCKFILE'));
  assert.equal(r.pwa.manifest.hasName, false);
});

test('Monorepo: analyzes apps/web and finds the root lockfile', async () => {
  const r = await run('monorepo', { projectRoot: 'apps/web' });
  assert.equal(r.projectRoot, 'apps/web');
  assert.equal(r.framework, 'vite');
  assert.equal(r.build.lockfile, 'pnpm-lock.yaml');
  assert.equal(r.pwa.isInstallablePwa, true);
});

test('projectRoot with .. is refused', async () => {
  await assert.rejects(() => run('monorepo', { projectRoot: '../etc' }), /may not contain/);
});

test('Every score deduction is explained: a perfect PWA loses iOS points only for the Apple wrapper warning', async () => {
  const r = await run('react-vite-pwa');
  const warn = r.findings.filter((f) => f.level === 'warning' || f.level === 'blocker').map((f) => f.code);
  assert.deepEqual(warn, ['APPLE_MIN_FUNCTIONALITY']);
  assert.equal(r.scores.pwa, 100);
  assert.equal(r.scores.android, 100);
  assert.equal(r.scores.ios, 85);
});

test('projectRoot that is absolute is refused', async () => {
  await assert.rejects(() => run('monorepo', { projectRoot: '/etc' }), /absolute/);
});

test('FsRepoSource refuses paths outside the root', async () => {
  const src = new FsRepoSource(resolve('tests'));
  assert.equal(await src.readText('../../../../etc/passwd'), null);
});

const XPEN = resolve('../Xpenstack');
test('Real repo: Xpenstack is a Vite PWA built into "pages", Capacitor on both platforms', { skip: !existsSync(`${XPEN}/package.json`) }, async () => {
  const r = await analyze(new FsRepoSource(XPEN), { hostedOrigin: 'https://app.xpenstack.com' });
  assert.equal(r.framework, 'vite');
  assert.equal(r.build.outputDir, 'pages');
  assert.equal(r.pwa.isInstallablePwa, true);
  assert.equal(r.recommendedAndroidStrategy, 'capacitor');
  assert.equal(r.recommendedIosStrategy, 'capacitor');
  assert.ok(codes(r).includes('NATIVE_NOTIFICATIONS'));
});

test('manifest under src/ or a favicon-generator site.webmanifest is found', async () => {
  for (const path of ['src/manifest.webmanifest', 'public/site.webmanifest']) {
    const r = await analyze(new MemRepoSource({ 'package.json': '{"scripts":{"build":"vite build"}}', [path]: '{"name":"A","icons":[{"src":"i.png","sizes":"512x512"}]}' }));
    assert.equal(r.pwa.manifest.accessiblePath, path);
  }
});

test('the end-to-end fixture app is an installable PWA built into dist', async () => {
  const r = await analyze(new FsRepoSource(resolve('tests/fixtures/e2e-pwa')));
  assert.equal(r.pwa.isInstallablePwa, true);
  assert.equal(r.build.outputDir, 'dist');
  assert.equal(r.recommendedAndroidStrategy, 'capacitor');
});
