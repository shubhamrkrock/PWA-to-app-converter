import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, dispatch } from '../apps/api/src/index.ts';
import { _resetSupabaseJwksForTests } from '../apps/api/src/routes.ts';
import { _resetJwksCacheForTests } from '../apps/api/src/github.ts';
import { hex, hmacSha256, sha256Hex } from '../apps/api/src/crypto.ts';
import { makeWorld, ALICE, BOB, SHA1, signJwt, type World } from './helpers/fake-backend.ts';

async function setup() {
  _resetSupabaseJwksForTests();
  _resetJwksCacheForTests();
  const w = await makeWorld();
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined = opts.raw;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const res = await handle(new Request(`https://api.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), { env: w.env, fetch: w.fetch, now: w.now });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  };
  return { w, call };
}

/** Alice: plan, installation, project, analysis, configuration. Returns ids. */
async function seedAlice(w: World, plan = 'developer') {
  w.db.tables.profiles!.push({ id: ALICE, subscription_plan: plan }, { id: BOB, subscription_plan: 'developer' });
  w.db.tables.github_installations!.push({ id: crypto.randomUUID(), user_id: ALICE, installation_id: 7, account_name: 'alice', account_type: 'User' });
  const projectId = crypto.randomUUID();
  w.db.tables.projects!.push({ id: projectId, user_id: ALICE, installation_id: 7, repository_id: 42, repository_name: 'shubhamrkrock/Xpenstack', repository_url: 'https://github.com/shubhamrkrock/Xpenstack', branch: 'dev', project_root: '', output_dir: 'pages', hosted_origin: 'https://app.xpenstack.com', auto_build: true });
  w.db.tables.project_analyses!.push({ id: crypto.randomUUID(), project_id: projectId, user_id: ALICE, commit_sha: SHA1, recommended_android_strategy: 'capacitor', recommended_ios_strategy: 'capacitor', created_at: '2026-10-30T00:00:00Z' });
  const configId = crypto.randomUUID();
  w.db.tables.app_configurations!.push({ id: configId, project_id: projectId, user_id: ALICE, app_name: 'Xpenstack', package_id: 'com.xpenstack.app', bundle_id: 'com.xpenstack.app', version: '1.0.0', build_number: 1, icon_url: null, splash_url: null, permissions: ['notifications'], android_config: {}, ios_config: {}, created_at: '2026-10-30T00:00:00Z' });
  return { projectId, configId };
}

// ------------------------------------------------------------------ authentication

test('auth: no token, garbage token, wrong audience, expired and alg=none are all 401', async () => {
  const { w, call } = await setup();
  assert.equal((await call('GET', '/api/v1/projects')).status, 401);
  assert.equal((await call('GET', '/api/v1/projects', { token: 'a.b.c' })).status, 401);
  assert.equal((await call('GET', '/api/v1/projects', { token: await w.tokenFor(ALICE, { aud: 'anon' }) })).status, 401);
  assert.equal((await call('GET', '/api/v1/projects', { token: await w.tokenFor(ALICE, { exp: 1 }) })).status, 401);
  const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sub: ALICE, aud: 'authenticated', exp: 9e9 }))}.`;
  assert.equal((await call('GET', '/api/v1/projects', { token: none })).status, 401);
});

test('auth: a token signed by a different key is refused', async () => {
  const { w, call } = await setup();
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const forged = await signJwt(other.privateKey, 'ES256', 'sb1', { sub: ALICE, aud: 'authenticated', exp: Math.floor(w.now() / 1000) + 60 });
  assert.equal((await call('GET', '/api/v1/projects', { token: forged })).status, 401);
});

// ------------------------------------------------------------------ tenant isolation (AC-15)

test('isolation: Bob cannot see, delete, analyze or build Alice\'s project', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const bob = await w.tokenFor(BOB);
  assert.equal((await call('GET', `/api/v1/projects/${projectId}`, { token: bob })).status, 404);
  assert.deepEqual((await call('GET', '/api/v1/projects', { token: bob })).data, []);
  assert.equal((await call('DELETE', `/api/v1/projects/${projectId}`, { token: bob })).status, 404);
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/analyze`, { token: bob })).status, 404);
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: bob, body: { platforms: ['android'], configuration_id: configId } })).status, 404);
  assert.equal(w.db.tables.projects!.length, 1);
});

test('isolation: Bob cannot cancel Alice\'s build or get a download link for her artifact', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  const made = await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], configuration_id: configId } });
  assert.equal(made.status, 201);
  const buildId = made.data.builds[0].id;
  w.db.tables.build_artifacts!.push({ id: crypto.randomUUID(), build_id: buildId, user_id: ALICE, artifact_type: 'apk', storage_key: 'k', validated: true, expires_at: '2099-01-01T00:00:00Z' });
  const bob = await w.tokenFor(BOB);
  assert.equal((await call('POST', `/api/v1/builds/${buildId}/cancel`, { token: bob })).status, 404);
  assert.equal((await call('GET', `/api/v1/builds/${buildId}/logs`, { token: bob })).status, 404);
  const art = w.db.tables.build_artifacts![0]!.id;
  assert.equal((await call('POST', `/api/v1/artifacts/${art}/download-url`, { token: bob })).status, 404);
});

test('isolation: a project cannot be created on an installation you did not connect', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  const bob = await w.tokenFor(BOB);
  const r = await call('POST', '/api/v1/projects', { token: bob, body: { installationId: 7, repositoryId: 42 } });
  assert.equal(r.status, 403);
});

// ------------------------------------------------------------------ GitHub connect

test('github callback: installs only when the signed-in user\'s GitHub account can see the installation', async () => {
  const { w, call } = await setup();
  const alice = await w.tokenFor(ALICE);
  const { data } = await call('GET', '/api/v1/github/install-url', { token: alice });
  const state = new URL(data.url).searchParams.get('state')!;
  w.ghUserInstallations['user-token-good'] = [55];
  const denied = await call('GET', `/api/v1/github/callback?installation_id=77&code=good&state=${encodeURIComponent(state)}`);
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get('location')!, /forbidden/);
  assert.equal(w.db.tables.github_installations!.length, 0);
  const ok = await call('GET', `/api/v1/github/callback?installation_id=55&code=good&state=${encodeURIComponent(state)}`);
  assert.match(ok.headers.get('location')!, /connected/);
  assert.equal(w.db.tables.github_installations![0]!.user_id, ALICE);
  const forged = await call('GET', `/api/v1/github/callback?installation_id=55&code=good&state=${encodeURIComponent(state + 'x')}`);
  assert.match(forged.headers.get('location')!, /failed/);
});

test('repositories: lists repos of connected installations with PRD fields', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  const r = await call('GET', '/api/v1/github/repositories', { token: await w.tokenFor(ALICE) });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ['defaultBranch', 'description', 'fullName', 'id', 'installationId', 'language', 'name', 'owner', 'updatedAt', 'url', 'visibility'].sort());
});

// ------------------------------------------------------------------ projects and configuration

test('projects: free plan allows one project; traversal roots and http origins are refused', async () => {
  const { w, call } = await setup();
  await seedAlice(w, 'free');
  const alice = await w.tokenFor(ALICE);
  assert.equal((await call('POST', '/api/v1/projects', { token: alice, body: { installationId: 7, repositoryId: 43, projectRoot: 'apps/../../x' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/projects', { token: alice, body: { installationId: 7, repositoryId: 43, hostedOrigin: 'http://x.com' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/projects', { token: alice, body: { installationId: 7, repositoryId: 43 } })).status, 429);
});

test('configuration: invalid fields come back per field; valid config is stored', async () => {
  const { w, call } = await setup();
  const { projectId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  const bad = await call('POST', `/api/v1/projects/${projectId}/configuration`, { token: alice, body: { appName: '', packageId: 'com.class.app', version: '1.0', themeColor: 'red' } });
  assert.equal(bad.status, 422);
  // com.class.app is fine for iOS but "class" is a Java keyword, so only the Android id fails
  assert.deepEqual(Object.keys(bad.data.fields).sort(), ['appName', 'packageId', 'themeColor', 'version'].sort());
  const ok = await call('POST', `/api/v1/projects/${projectId}/configuration`, { token: alice, body: { appName: 'Xpenstack', packageId: 'com.xpenstack.app', permissions: ['notifications', 'camera', 'camera'] } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.data.permissions, ['camera', 'notifications']);
});

// ------------------------------------------------------------------ builds

test('builds: queues one job per platform and variant, dispatches iOS to the macOS workflow', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const r = await call('POST', `/api/v1/projects/${projectId}/builds`, { token: await w.tokenFor(ALICE), body: { platforms: ['android', 'ios'], configuration_id: configId } });
  assert.equal(r.status, 201);
  assert.equal(r.data.commitSha, SHA1);
  assert.equal(w.queue.sent.length, 2);
  for (const m of w.queue.sent) assert.equal(await dispatch(m, { env: w.env, fetch: w.fetch, now: w.now }), 'dispatched');
  const dispatched = w.ghCalls.filter((c) => c.path.includes('/dispatches'));
  assert.ok(dispatched.some((c) => c.path.includes('g2a-ios.yml')));
  assert.ok(dispatched.some((c) => c.path.includes('g2a-job.yml')));
  // inputs carry ids only: nothing secret goes into workflow inputs
  for (const c of dispatched) assert.deepEqual(Object.keys(c.body.inputs).sort(), ['api_origin', 'job_id', 'job_kind']);
});

test('builds: refused when analysis says unsupported, when not analyzed, and for TWA without an origin', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  w.db.tables.project_analyses![0]!.recommended_ios_strategy = 'unsupported';
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['ios'], configuration_id: configId } })).status, 409);
  w.db.tables.projects![0]!.hosted_origin = null;
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], android_strategy: 'twa', configuration_id: configId } })).status, 400);
  w.db.tables.project_analyses = [];
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], configuration_id: configId } })).status, 409);
});

test('builds: free plan cannot make signed release builds; iOS monthly cap is enforced', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w, 'free');
  const alice = await w.tokenFor(ALICE);
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], configuration_id: configId, generate_release: true } })).status, 403);
  for (let i = 0; i < 3; i++) w.db.tables.builds!.push({ id: crypto.randomUUID(), user_id: ALICE, platform: 'ios', status: 'COMPLETED', created_at: new Date(w.now()).toISOString() });
  assert.equal((await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['ios'], configuration_id: configId } })).status, 429);
});

test('cancel and retry: cancel stops a live build; only failed or cancelled builds retry', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  const made = await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], configuration_id: configId } });
  const id = made.data.builds[0].id;
  assert.equal((await call('POST', `/api/v1/builds/${id}/retry`, { token: alice })).status, 409);
  assert.equal((await call('POST', `/api/v1/builds/${id}/cancel`, { token: alice })).data.status, 'CANCELLED');
  assert.equal((await call('POST', `/api/v1/builds/${id}/cancel`, { token: alice })).status, 409);
  const retry = await call('POST', `/api/v1/builds/${id}/retry`, { token: alice });
  assert.equal(retry.status, 201);
  assert.notEqual(retry.data.builds[0].id, id);
  // the queue skips a cancelled build instead of dispatching it
  assert.equal(await dispatch({ jobId: id, kind: 'build', platform: 'android' }, { env: w.env, fetch: w.fetch, now: w.now }), 'skipped');
});

// ------------------------------------------------------------------ webhooks (PRD §14)

async function signedPush(w: World, delivery: string, payload: object) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${hex(await hmacSha256(w.env.GITHUB_WEBHOOK_SECRET, raw))}`;
  return { raw, headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': delivery, 'content-type': 'application/json' } };
}

test('webhook: bad signature is refused; a push builds debug only, once per delivery', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  const payload = { ref: 'refs/heads/dev', after: 'b'.repeat(40), repository: { id: 42 }, installation: { id: 7 } };
  const bad = await call('POST', '/api/v1/github/webhooks', { raw: JSON.stringify(payload), headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'push' } });
  assert.equal(bad.status, 401);
  const d = crypto.randomUUID();
  const s = await signedPush(w, d, payload);
  assert.equal((await call('POST', '/api/v1/github/webhooks', { raw: s.raw, headers: s.headers })).status, 200);
  assert.equal(w.db.tables.builds!.length, 2); // android + ios, debug
  assert.ok(w.db.tables.builds!.every((b) => b.variant === 'debug' && b.commit_sha === 'b'.repeat(40)));
  await call('POST', '/api/v1/github/webhooks', { raw: s.raw, headers: s.headers }); // redelivery
  assert.equal(w.db.tables.builds!.length, 2);
  assert.equal(w.queue.sent.length, 2);
});

test('webhook: pushes to other branches, and projects with auto-build off, do nothing', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  let s = await signedPush(w, crypto.randomUUID(), { ref: 'refs/heads/feature', after: 'c'.repeat(40), repository: { id: 42 }, installation: { id: 7 } });
  await call('POST', '/api/v1/github/webhooks', { raw: s.raw, headers: s.headers });
  w.db.tables.projects![0]!.auto_build = false;
  s = await signedPush(w, crypto.randomUUID(), { ref: 'refs/heads/dev', after: 'c'.repeat(40), repository: { id: 42 }, installation: { id: 7 } });
  await call('POST', '/api/v1/github/webhooks', { raw: s.raw, headers: s.headers });
  assert.equal(w.db.tables.builds!.length, 0);
});

// ------------------------------------------------------------------ build worker protocol

async function queuedBuild(w: World, call: Awaited<ReturnType<typeof setup>>['call'], platform: 'android' | 'ios' = 'android') {
  const { projectId, configId } = await seedAlice(w);
  const r = await call('POST', `/api/v1/projects/${projectId}/builds`, { token: await w.tokenFor(ALICE), body: { platforms: [platform], configuration_id: configId } });
  return r.data.builds[0].id as string;
}

test('worker claim: wrong repo, wrong ref, pull_request runs and forged tokens are refused; a job is claimed once', async () => {
  const { w, call } = await setup();
  const id = await queuedBuild(w, call);
  const path = `/api/v1/internal/jobs/build/${id}/claim`;
  assert.equal((await call('POST', path, { token: await w.oidc({ repository: 'evil/fork' }) })).status, 401);
  assert.equal((await call('POST', path, { token: await w.oidc({ ref: 'refs/heads/feature' }) })).status, 401);
  assert.equal((await call('POST', path, { token: await w.oidc({ event_name: 'pull_request' }) })).status, 401);
  assert.equal((await call('POST', path, { token: await w.oidc({ aud: 'https://other.test' }) })).status, 401);
  const ok = await call('POST', path, { token: await w.oidc({}) });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.ticket);
  assert.equal((await call('POST', path, { token: await w.oidc({ run_id: '2002' }) })).status, 409);
});

test('worker claim: an iOS build can only be claimed by the macOS workflow, Android only by Linux', async () => {
  const { w, call } = await setup();
  const iosId = await queuedBuild(w, call, 'ios');
  assert.equal((await call('POST', `/api/v1/internal/jobs/build/${iosId}/claim`, { token: await w.oidc({}) })).status, 403);
  const mac = await w.oidc({ workflow_ref: `${w.env.WORKERS_REPO}/.github/workflows/g2a-ios.yml@refs/heads/main` });
  assert.equal((await call('POST', `/api/v1/internal/jobs/build/${iosId}/claim`, { token: mac })).status, 200);
});

test('worker ticket: bound to one job; full happy path to a validated, downloadable artifact', async () => {
  const { w, call } = await setup();
  const id = await queuedBuild(w, call);
  const other = await queuedBuild(w, call);
  const { data } = await call('POST', `/api/v1/internal/jobs/build/${id}/claim`, { token: await w.oidc({}) });
  const t = data.ticket as string;
  assert.equal((await call('GET', `/api/v1/internal/jobs/build/${other}/spec`, { token: t })).status, 403);

  const spec = await call('GET', `/api/v1/internal/jobs/build/${id}/spec`, { token: t });
  assert.equal(spec.status, 200);
  assert.equal(spec.data.repo.commitSha, SHA1);
  assert.equal(spec.data.signing, null); // debug build gets no signing material
  assert.equal(spec.data.config.packageId, 'com.xpenstack.app');
  // the clone token was narrowed to the one repo, read-only
  const tokenCall = w.ghCalls.filter((c) => c.path.endsWith('/access_tokens')).pop()!;
  assert.deepEqual(tokenCall.body, { repository_ids: [42], permissions: { contents: 'read' } });

  // illegal jump is refused; forward one at a time is allowed
  assert.equal((await call('POST', `/api/v1/internal/jobs/build/${id}/status`, { token: t, body: { status: 'SIGNING' } })).status, 409);
  for (const s of ['ANALYZING', 'DEPENDENCY_INSTALLATION', 'WEB_BUILD', 'NATIVE_CONFIGURATION', 'PLATFORM_COMPILATION', 'SIGNING', 'VALIDATION']) {
    assert.equal((await call('POST', `/api/v1/internal/jobs/build/${id}/status`, { token: t, body: { status: s } })).status, 200, s);
  }

  // logs are redacted on the server too
  await call('POST', `/api/v1/internal/jobs/build/${id}/logs`, { token: t, raw: `cloning with ghs_${'y'.repeat(36)}\n`, headers: { 'x-seq': '0' } });
  const logs = await call('GET', `/api/v1/builds/${id}/logs`, { token: await w.tokenFor(ALICE) });
  assert.doesNotMatch(logs.data, /ghs_y/);
  assert.match(logs.data, /\[REDACTED\]/);

  // upload: checksum must match; iOS-only types refused on Android
  const apk = new TextEncoder().encode('PK fake apk bytes');
  const sum = await sha256Hex(apk);
  assert.equal((await call('PUT', `/api/v1/internal/jobs/build/${id}/artifacts/apk?name=app-debug.apk`, { token: t, raw: apk, headers: { 'x-sha256': 'f'.repeat(64) } })).status, 400);
  assert.equal((await call('PUT', `/api/v1/internal/jobs/build/${id}/artifacts/ipa`, { token: t, raw: apk, headers: { 'x-sha256': sum } })).status, 400);
  const up = await call('PUT', `/api/v1/internal/jobs/build/${id}/artifacts/apk?name=app-debug.apk`, { token: t, raw: apk, headers: { 'x-sha256': sum, 'x-validated': 'true' } });
  assert.equal(up.status, 201);
  assert.equal(up.data.validated, true);
  assert.equal((await call('POST', `/api/v1/internal/jobs/build/${id}/status`, { token: t, body: { status: 'COMPLETED' } })).status, 200);

  // download: short-lived link, works once issued, refused when tampered or expired
  const alice = await w.tokenFor(ALICE);
  const link = await call('POST', `/api/v1/artifacts/${up.data.id}/download-url`, { token: alice });
  assert.equal(link.status, 200);
  const path = new URL(link.data.url).pathname;
  const dl = await call('GET', path);
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'PK fake apk bytes');
  assert.match(dl.headers.get('content-disposition')!, /attachment; filename="apk-app-debug.apk"/);
  assert.equal((await call('GET', path.slice(0, -2) + 'xx')).status, 403);
  const realNow = w.now;
  (w as any).now = () => realNow() + 11 * 60_000;
  const late = await handle(new Request(`https://api.test${path}`), { env: w.env, fetch: w.fetch, now: w.now });
  assert.equal(late.status, 403);
});

test('worker ticket: refused once the build is cancelled', async () => {
  const { w, call } = await setup();
  const id = await queuedBuild(w, call);
  const { data } = await call('POST', `/api/v1/internal/jobs/build/${id}/claim`, { token: await w.oidc({}) });
  await call('POST', `/api/v1/builds/${id}/cancel`, { token: await w.tokenFor(ALICE) });
  assert.equal((await call('GET', `/api/v1/internal/jobs/build/${id}/spec`, { token: data.ticket })).status, 410);
  assert.ok(w.ghCalls.some((c) => c.path.endsWith('/actions/runs/1001/cancel')));
});

test('unvalidated packages are never offered for download', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  const art = { id: crypto.randomUUID(), build_id: crypto.randomUUID(), user_id: ALICE, artifact_type: 'aab', storage_key: 'u/a/x.aab', validated: false, expires_at: '2099-01-01T00:00:00Z' };
  w.db.tables.build_artifacts!.push(art);
  assert.equal((await call('POST', `/api/v1/artifacts/${art.id}/download-url`, { token: await w.tokenFor(ALICE) })).status, 409);
});

// ------------------------------------------------------------------ signing vault

test('vault: credentials are stored encrypted, never returned, and decrypted only into a release build spec', async () => {
  const { w, call } = await setup();
  const { projectId, configId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  const payload = { keystoreB64: 'S0VZU1RPUkU=', storePassword: 'storepass-123', keyAlias: 'upload', keyPassword: 'keypass-456' };
  const stored = await call('POST', '/api/v1/signing-credentials', { token: alice, body: { platform: 'android', type: 'android-keystore', label: 'upload key', payload } });
  assert.equal(stored.status, 201);
  const row = w.db.tables.signing_credentials![0]!;
  assert.doesNotMatch(String(row.encrypted_payload), /storepass|keypass|S0VZU1RPUkU/);
  const list = await call('GET', '/api/v1/signing-credentials', { token: alice });
  assert.deepEqual(Object.keys(list.data[0]).sort(), ['created_at', 'credential_type', 'id', 'label', 'platform']);
  // Bob cannot use Alice's credential id
  const bob = await w.tokenFor(BOB);
  w.db.tables.github_installations!.push({ user_id: BOB, installation_id: 8 });
  // release build with the credential; worker receives it decrypted
  const made = await call('POST', `/api/v1/projects/${projectId}/builds`, { token: alice, body: { platforms: ['android'], configuration_id: configId, generate_debug: false, generate_release: true, signing: { android: stored.data.id } } });
  assert.equal(made.status, 201);
  const id = made.data.builds[0].id;
  const { data } = await call('POST', `/api/v1/internal/jobs/build/${id}/claim`, { token: await w.oidc({}) });
  const spec = await call('GET', `/api/v1/internal/jobs/build/${id}/spec`, { token: data.ticket });
  assert.deepEqual(spec.data.signing, payload);
  assert.equal((await call('DELETE', `/api/v1/signing-credentials/${stored.data.id}`, { token: bob })).status, 404);
});

test('vault: wrong credential type for the platform, and missing fields, are refused', async () => {
  const { w, call } = await setup();
  await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  assert.equal((await call('POST', '/api/v1/signing-credentials', { token: alice, body: { platform: 'ios', type: 'android-keystore', payload: {} } })).status, 400);
  assert.equal((await call('POST', '/api/v1/signing-credentials', { token: alice, body: { platform: 'android', type: 'android-keystore', payload: { keystoreB64: 'x' } } })).status, 400);
});

// ------------------------------------------------------------------ analysis jobs

test('analysis: queued as a worker job; the result is stored and updates the project', async () => {
  const { w, call } = await setup();
  const { projectId } = await seedAlice(w);
  const alice = await w.tokenFor(ALICE);
  const q = await call('POST', `/api/v1/projects/${projectId}/analyze`, { token: alice });
  assert.equal(q.status, 202);
  const jobId = q.data.analysisJobId;
  const { data } = await call('POST', `/api/v1/internal/jobs/analysis/${jobId}/claim`, { token: await w.oidc({}) });
  const report = { schemaVersion: 1, framework: 'vite', pwa: { isInstallablePwa: true }, build: { packageManager: 'npm', outputDir: 'pages' }, scores: { android: 100, ios: 100, pwa: 100 }, recommendedAndroidStrategy: 'capacitor', recommendedIosStrategy: 'capacitor' };
  assert.equal((await call('POST', `/api/v1/internal/jobs/analysis/${jobId}/analysis`, { token: data.ticket, body: report })).status, 201);
  const got = await call('GET', `/api/v1/projects/${projectId}/analysis`, { token: alice });
  assert.equal(got.data.job.status, 'COMPLETED');
  assert.equal(got.data.analysis.framework_detected, 'vite');
});

// ------------------------------------------------------------------ HTTP hygiene

test('http: CORS only for the web origin; unknown routes 404; wrong method 405; errors hide internals', async () => {
  const { w, call } = await setup();
  const pre = await call('OPTIONS', '/api/v1/projects', { headers: { origin: 'https://web.test' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://web.test');
  const evil = await call('OPTIONS', '/api/v1/projects', { headers: { origin: 'https://evil.test' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', '/api/v1/nope')).status, 404);
  assert.equal((await call('PUT', '/api/v1/projects')).status, 405);
  w.db.handle = () => new Response('boom: relation "secret_table" does not exist', { status: 500 }); // force a database failure
  const r = await call('GET', '/api/v1/projects', { token: await w.tokenFor(ALICE) });
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r.data), /secret_table|relation|boom/);
});
