/** The dashboard's pure logic: routes, build progress, the settings form, the API client, file checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrefFor, parseRoute, type Route } from '../apps/web/src/lib/routes.ts';
import { failedStage, formatBytes, isFinished, steps, toneOf } from '../apps/web/src/lib/status.ts';
import { defaultForm, formErrors, formFromConfig, payloadFromForm, suggestId } from '../apps/web/src/lib/config-form.ts';
import { ApiError, makeApi } from '../apps/web/src/lib/api.ts';
import { bytesToBase64, fileToBase64, looksLike } from '../apps/web/src/lib/files.ts';
import type { AppConfiguration } from '@git2app/shared';

const ID = '0b6f3b4e-8a51-4d8e-9a7e-2a1b3c4d5e6f';

test('routes: every route survives href -> parse', () => {
  const routes: Route[] = [
    { name: 'projects' },
    { name: 'new-project' },
    { name: 'project', id: ID, tab: 'overview' },
    { name: 'project', id: ID, tab: 'settings' },
    { name: 'project', id: ID, tab: 'builds' },
    { name: 'build', id: ID },
    { name: 'integrations', github: null },
    { name: 'keys' },
  ];
  for (const r of routes) assert.deepEqual(parseRoute(hrefFor(r)), r);
});

test('routes: root, trailing slash, query result and unknown paths', () => {
  assert.deepEqual(parseRoute('/'), { name: 'projects' });
  assert.deepEqual(parseRoute('/keys/'), { name: 'keys' });
  assert.deepEqual(parseRoute('/integrations', '?github=connected'), { name: 'integrations', github: 'connected' });
  assert.deepEqual(parseRoute(`/projects/${ID}/secrets`), { name: 'not-found' });
  assert.deepEqual(parseRoute('/projects/not-a-uuid'), { name: 'not-found' });
  assert.deepEqual(parseRoute('/builds/../etc'), { name: 'not-found' });
});

test('status: tones and finished states', () => {
  assert.equal(toneOf('COMPLETED'), 'done');
  assert.equal(toneOf('FAILED_WEB_BUILD'), 'failed');
  assert.equal(toneOf('CANCELLED'), 'muted');
  assert.equal(toneOf('WEB_BUILD'), 'running');
  assert.equal(isFinished('QUEUED'), false);
  assert.equal(isFinished('FAILED_SIGNING'), true);
  assert.equal(failedStage('FAILED_COMPILATION'), 'PLATFORM_COMPILATION');
  assert.equal(failedStage('COMPLETED'), null);
});

test('status: steps hide signing for test builds and mark where a build failed', () => {
  assert.ok(!steps('QUEUED', 'debug').some((s) => s.stage === 'SIGNING'));
  assert.ok(steps('QUEUED', 'release').some((s) => s.stage === 'SIGNING'));
  const failed = steps('FAILED_WEB_BUILD', 'debug');
  assert.equal(failed.find((s) => s.stage === 'WEB_BUILD')?.state, 'failed');
  assert.equal(failed.find((s) => s.stage === 'DEPENDENCY_INSTALLATION')?.state, 'done');
  assert.equal(failed.find((s) => s.stage === 'COMPLETED')?.state, 'todo');
  assert.ok(steps('COMPLETED', 'release').every((s) => s.state === 'done'));
  assert.equal(steps('PLATFORM_COMPILATION', 'debug').find((s) => s.stage === 'PLATFORM_COMPILATION')?.state, 'current');
});

test('status: formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.match(formatBytes(5 * 1024 * 1024), /^5(\.0)? MB$/);
});

test('settings form: suggested ids are valid store ids', () => {
  assert.equal(suggestId('shubhamrkrock/Xpenstack'), 'com.shubhamrkrock.xpenstack');
  assert.equal(suggestId('9lives/my-app'), 'com.app9lives.myapp');
});

test('settings form: defaults pass validation and the payload round-trips', () => {
  const f = defaultForm('shubhamrkrock/Xpenstack', { themeColor: '#0F766E', backgroundColor: 'red' });
  assert.equal(f.appName, 'Xpenstack');
  assert.equal(f.themeColor, '#0F766E');
  assert.equal(f.backgroundColor, '#FFFFFF');
  assert.deepEqual(formErrors(f), {});
  const payload = payloadFromForm(f);
  assert.equal(payload.bundleId, payload.packageId);
  assert.deepEqual(formFromConfig(payload as AppConfiguration), f);
});

test('settings form: errors show on the field the person typed in', () => {
  const f = { ...defaultForm('a/b'), packageId: 'Not An Id', buildNumber: 'x' };
  const errs = formErrors(f);
  assert.ok(errs.packageId);
  assert.ok(errs.buildNumber);
  assert.ok(!errs.bundleId, 'with the same id on iPhone, the bundle error lands on packageId');
});

test('settings form: permission text only for chosen permissions', () => {
  const f = { ...defaultForm('a/b'), permissions: ['camera' as const], permissionText: { camera: ' Scan receipts ', location: 'unused' } };
  assert.deepEqual(payloadFromForm(f).permissionText, { camera: 'Scan receipts' });
});

test('api client: sends the token, and turns API errors into plain messages', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/bad')) return new Response(JSON.stringify({ error: 'invalid_configuration', fields: { appName: 'Too long' } }), { status: 422 });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as typeof fetch;
  const api = makeApi('https://api.example/', async () => 'tok', fake);
  assert.deepEqual(await api.post('/x', { a: 1 }), { ok: 1 });
  assert.equal(calls[0]!.url, 'https://api.example/api/v1/x');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer tok');
  await assert.rejects(api.get('/bad'), (e: unknown) => e instanceof ApiError && e.status === 422 && e.message === 'Some settings need fixing.' && e.fields?.appName === 'Too long');
  const down = makeApi('https://api.example', async () => null, (async () => { throw new TypeError('offline'); }) as typeof fetch);
  await assert.rejects(down.get('/x'), (e: unknown) => e instanceof ApiError && e.code === 'network');
});

test('files: base64 matches Node, size cap, and file sniffing', async () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  await assert.rejects(fileToBase64(new Blob([new Uint8Array(400 * 1024)])), /KB/);
  assert.equal(looksLike('keystore', Uint8Array.of(0xfe, 0xed, 0xfe, 0xed)), true);
  assert.equal(looksLike('keystore', new TextEncoder().encode('hello')), false);
  assert.equal(looksLike('p12', Uint8Array.of(0x30, 0x82)), true);
  const profile = new Uint8Array([0x30, ...new TextEncoder().encode('xx<?xml?><plist version="1.0">')]);
  assert.equal(looksLike('mobileprovision', profile), true);
  assert.equal(looksLike('mobileprovision', Uint8Array.of(0x30, 0x82)), false);
});
