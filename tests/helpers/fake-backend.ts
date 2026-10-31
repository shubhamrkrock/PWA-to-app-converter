/**
 * Test doubles for the API: real keys (ES256 for Supabase sessions, RS256 for GitHub App and
 * Actions OIDC), an in-memory PostgREST that applies per-user row filtering the way the RLS
 * policies do (the policies themselves are tested on real Postgres by scripts/test-db.sh),
 * a GitHub API fake, an R2 fake and a Queue fake.
 */

import { b64url, type Jwk } from '../../apps/api/src/crypto.ts';
import type { Env, DispatchMessage, R2BucketLike } from '../../apps/api/src/env.ts';

const enc = new TextEncoder();

export async function es256Pair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Jwk;
  jwk.kid = 'sb1';
  jwk.alg = 'ES256';
  return { kp, jwk };
}

export async function rs256Pair(kid = 'rs1') {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Jwk;
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let s = '';
  for (const b of pkcs8) s += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(s).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
  return { kp, jwk, pem };
}

export async function signJwt(key: CryptoKey, alg: 'ES256' | 'RS256', kid: string, claims: Record<string, unknown>): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg, kid, typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const algo = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const sig = await crypto.subtle.sign(algo, key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

// ------------------------------------------------------------------ in-memory PostgREST

type Row = Record<string, any>;

export class FakeDb {
  tables: Record<string, Row[]> = {
    profiles: [],
    github_installations: [],
    projects: [],
    project_analyses: [],
    analysis_jobs: [],
    app_configurations: [],
    builds: [],
    build_artifacts: [],
    signing_credentials: [],
    audit_events: [],
  };

  /** Mirrors the RLS policies: which rows a given user may see in each table. */
  private visible(table: string, uid: string | null): Row[] {
    if (uid === null) return this.tables[table === 'signing_credentials_meta' ? 'signing_credentials' : table] ?? [];
    if (table === 'signing_credentials') throw Object.assign(new Error('permission denied'), { status: 401 });
    if (table === 'signing_credentials_meta') {
      return this.tables.signing_credentials!.filter((r) => r.user_id === uid).map(({ id, platform, credential_type, label, created_at }) => ({ id, platform, credential_type, label, created_at }));
    }
    if (table === 'profiles') return this.tables.profiles!.filter((r) => r.id === uid);
    return (this.tables[table] ?? []).filter((r) => r.user_id === uid);
  }

  private match(row: Row, q: URLSearchParams): boolean {
    for (const [k, v] of q) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const cell = row[k];
      if (v.startsWith('eq.')) {
        if (String(cell) !== v.slice(3)) return false;
      } else if (v === 'is.null') {
        if (cell !== null && cell !== undefined) return false;
      } else if (v === 'is.true') {
        if (cell !== true) return false;
      } else if (v.startsWith('gte.')) {
        if (!(String(cell) >= v.slice(4))) return false;
      } else if (v.startsWith('in.(')) {
        const list = v.slice(4, -1).split(',').map((s) => s.replace(/"/g, ''));
        if (!list.includes(String(cell))) return false;
      } else if (v.startsWith('not.in.(')) {
        const list = v.slice(8, -1).split(',');
        if (list.includes(String(cell))) return false;
      } else throw new Error(`fake db: unsupported filter ${k}=${v}`);
    }
    return true;
  }

  handle(method: string, table: string, q: URLSearchParams, uid: string | null, body: any, prefer: string): Response {
    let rows: Row[];
    try {
      rows = this.visible(table, uid);
    } catch {
      return new Response('denied', { status: 401 });
    }
    const real = this.tables[table];
    if (method === 'GET') {
      let out = rows.filter((r) => this.match(r, q));
      const order = q.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => (a[col!] < b[col!] ? -1 : a[col!] > b[col!] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      const limit = q.get('limit');
      if (limit) out = out.slice(0, Number(limit));
      return Response.json(out);
    }
    if (method === 'POST') {
      if (!real) return new Response('no table', { status: 404 });
      const items = Array.isArray(body) ? body : [body];
      const inserted: Row[] = [];
      for (const item of items) {
        if (uid !== null) {
          // RLS with-check: browsers may insert only their own rows into these tables.
          const allowed = ['projects', 'app_configurations'];
          if (!allowed.includes(table) || item.user_id !== uid) return new Response('rls', { status: 403 });
          if (table === 'app_configurations' && !this.tables.projects!.some((p) => p.id === item.project_id && p.user_id === uid)) return new Response('rls', { status: 403 });
        }
        if (table === 'builds' && item.idempotency_key && real.some((r) => r.idempotency_key === item.idempotency_key)) {
          if (prefer.includes('ignore-duplicates')) continue;
          return new Response('dup', { status: 409 });
        }
        if (table === 'github_installations' && real.some((r) => r.user_id === item.user_id && r.installation_id === item.installation_id)) continue;
        const row = { id: item.id ?? crypto.randomUUID(), created_at: new Date(Date.now() + this.tick++).toISOString(), ...item };
        if (table === 'builds') row.claimed_at ??= null;
        if (table === 'analysis_jobs') row.status ??= 'QUEUED';
        if (table === 'build_artifacts') row.expires_at ??= new Date(Date.now() + 30 * 86400_000).toISOString();
        real.push(row);
        inserted.push(row);
      }
      return Response.json(inserted, { status: 201 });
    }
    if (method === 'PATCH') {
      const hits = rows.filter((r) => this.match(r, q));
      for (const r of hits) Object.assign(r, body);
      return Response.json(hits);
    }
    if (method === 'DELETE') {
      if (!real) return new Response(null, { status: 204 });
      const hits = new Set(rows.filter((r) => this.match(r, q)));
      this.tables[table] = real.filter((r) => !hits.has(r));
      return new Response(null, { status: 204 });
    }
    return new Response('?', { status: 405 });
  }

  private tick = 0;
}

// ------------------------------------------------------------------ R2 + Queue

export class FakeR2 implements R2BucketLike {
  objects = new Map<string, Uint8Array<ArrayBuffer>>();
  async put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string) {
    const bytes: Uint8Array<ArrayBuffer> = typeof value === 'string' ? enc.encode(value) : value instanceof Uint8Array ? new Uint8Array(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v ? { body: new Response(v).body!, size: v.length } : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  }
}

export class FakeQueue {
  sent: DispatchMessage[] = [];
  async send(m: DispatchMessage) {
    this.sent.push(m);
  }
}

// ------------------------------------------------------------------ world

export const ALICE = '00000000-0000-4000-8000-00000000000a';
export const BOB = '00000000-0000-4000-8000-00000000000b';
export const SHA1 = 'a'.repeat(40);

export interface World {
  env: Env;
  db: FakeDb;
  r2: FakeR2;
  queue: FakeQueue;
  fetch: typeof fetch;
  now: () => number;
  tokenFor(uid: string, opts?: { exp?: number; aud?: string }): Promise<string>;
  oidc(claims: Partial<Record<string, unknown>>): Promise<string>;
  ghCalls: Array<{ method: string; path: string; body?: any; iss?: string }>;
  /** GitHub user token -> installations it can see. */
  ghUserInstallations: Record<string, number[]>;
  supabaseKey: CryptoKey;
}

export async function makeWorld(): Promise<World> {
  const sb = await es256Pair();
  const app = await rs256Pair('app');
  const actions = await rs256Pair('gha');
  const db = new FakeDb();
  const r2 = new FakeR2();
  const queue = new FakeQueue();
  const ghCalls: World['ghCalls'] = [];
  const ghUserInstallations: Record<string, number[]> = {};
  let nowMs = Date.parse('2026-10-30T12:00:00Z');

  const env: Env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-test',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_SLUG: 'git2app-test',
    GITHUB_APP_PRIVATE_KEY: app.pem,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csecret',
    GITHUB_WEBHOOK_SECRET: 'whsec-test',
    WORKERS_REPO: 'shubhamrkrock/PWA-to-app-converter',
    WORKERS_REF: 'main',
    WORKERS_INSTALLATION_ID: '999',
    STATE_SECRET: 'state-secret-test-0123456789',
    TICKET_SECRET: 'ticket-secret-test-0123456789',
    CREDENTIALS_MASTER_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    CREDENTIALS_KEY_REF: 'master-v1',
    API_ORIGIN: 'https://api.test',
    WEB_ORIGIN: 'https://web.test',
    ARTIFACTS: r2,
    DISPATCH_QUEUE: queue,
  };

  const userFromBearer = (auth: string | null): string | null | 'invalid' => {
    const tok = (auth ?? '').replace(/^Bearer /, '');
    if (tok === env.SUPABASE_SERVICE_ROLE_KEY) return null;
    try {
      const claims = JSON.parse(atob(tok.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      return claims.sub;
    } catch {
      return 'invalid';
    }
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    const body = bodyText ? JSON.parse(bodyText) : undefined;

    if (url.origin === env.SUPABASE_URL) {
      if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json({ keys: [sb.jwk] });
      const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
      if (m) {
        const uid = userFromBearer(req.headers.get('authorization'));
        if (uid === 'invalid') return new Response('bad jwt', { status: 401 });
        return db.handle(req.method, m[1]!, url.searchParams, uid, body, req.headers.get('prefer') ?? '');
      }
    }
    if (url.origin === 'https://token.actions.githubusercontent.com') return Response.json({ keys: [actions.jwk] });
    if (url.href === 'https://github.com/login/oauth/access_token') {
      return Response.json(body.code === 'bad' ? { error: 'bad_verification_code' } : { access_token: `user-token-${body.code}` });
    }
    if (url.origin === 'https://api.github.com') {
      // Record which App signed the call (the iss claim of an App JWT).
      let iss: string | undefined;
      const auth = req.headers.get('authorization') ?? '';
      if (/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) {
        try {
          iss = String(JSON.parse(atob(auth.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).iss);
        } catch {}
      }
      ghCalls.push({ method: req.method, path: url.pathname + url.search, body, iss });
      const p = url.pathname;
      if (/^\/app\/installations\/\d+\/access_tokens$/.test(p)) return Response.json({ token: `ghs_${'x'.repeat(36)}` }, { status: 201 });
      if (/^\/app\/installations\/(\d+)$/.test(p)) return Response.json({ id: Number(p.split('/')[3]), account: { login: 'acct', type: 'User' } });
      if (p === '/user/installations') {
        const tok = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
        return Response.json({ installations: (ghUserInstallations[tok] ?? []).map((id) => ({ id })) });
      }
      if (p === '/installation/repositories') {
        return Response.json({ repositories: [{ id: 42, name: 'Xpenstack', full_name: 'shubhamrkrock/Xpenstack', owner: { login: 'shubhamrkrock' }, description: 'expenses', default_branch: 'dev', updated_at: '2026-10-30', pushed_at: '2026-10-30', language: 'TypeScript', private: true, html_url: 'https://github.com/shubhamrkrock/Xpenstack' }] });
      }
      const repo = /^\/repositories\/(\d+)$/.exec(p);
      if (repo) {
        if (repo[1] === '404') return new Response('nf', { status: 404 });
        return Response.json({ id: Number(repo[1]), name: 'Xpenstack', full_name: 'shubhamrkrock/Xpenstack', owner: { login: 'shubhamrkrock' }, description: null, default_branch: 'dev', updated_at: '', pushed_at: '', language: 'TypeScript', private: true, html_url: 'https://github.com/shubhamrkrock/Xpenstack' });
      }
      if (/^\/repositories\/\d+\/commits\//.test(p)) return Response.json({ sha: SHA1 });
      if (/^\/repositories\/\d+\/branches$/.test(p)) return Response.json([{ name: 'dev', commit: { sha: SHA1 } }]);
      if (/\/actions\/workflows\/.+\/dispatches$/.test(p)) return new Response(null, { status: 204 });
      if (/\/actions\/runs\/.+\/cancel$/.test(p)) return new Response(null, { status: 202 });
    }
    return new Response(`unmocked ${req.method} ${url.href}`, { status: 599 });
  }) as typeof fetch;

  return {
    env,
    db,
    r2,
    queue,
    fetch: fakeFetch,
    now: () => nowMs,
    ghCalls,
    ghUserInstallations,
    supabaseKey: sb.kp.privateKey,
    tokenFor: (uid, opts = {}) =>
      signJwt(sb.kp.privateKey, 'ES256', 'sb1', { sub: uid, aud: opts.aud ?? 'authenticated', role: 'authenticated', exp: opts.exp ?? Math.floor(nowMs / 1000) + 3600 }),
    oidc: (claims) =>
      signJwt(actions.kp.privateKey, 'RS256', 'gha', {
        iss: 'https://token.actions.githubusercontent.com',
        aud: env.API_ORIGIN,
        repository: env.WORKERS_REPO,
        ref: 'refs/heads/main',
        event_name: 'workflow_dispatch',
        workflow_ref: `${env.WORKERS_REPO}/.github/workflows/g2a-job.yml@refs/heads/main`,
        run_id: '1001',
        exp: Math.floor(nowMs / 1000) + 600,
        ...claims,
      }),
  };
}
