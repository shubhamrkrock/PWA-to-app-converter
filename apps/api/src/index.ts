/**
 * Worker entry: HTTP API + queue consumer that dispatches jobs to build workers. The Worker
 * coordinates only; it never compiles, clones or executes repository code (PRD §11.1).
 */

import { Db } from './db.ts';
import type { Deps, DispatchMessage, Env } from './env.ts';
import { GithubApp } from './github.ts';
import { HttpError, json } from './http.ts';
import { buildRouter, type Ctx } from './routes.ts';
import { eq } from './db.ts';

const router = buildRouter();

export function makeCtx(deps: Deps): Ctx {
  const { env } = deps;
  return {
    deps,
    gh: new GithubApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, deps.fetch, deps.now),
    workers:
      env.WORKERS_APP_ID && env.WORKERS_APP_PRIVATE_KEY
        ? new GithubApp(env.WORKERS_APP_ID, env.WORKERS_APP_PRIVATE_KEY, deps.fetch, deps.now)
        : new GithubApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, deps.fetch, deps.now),
    service: new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE_KEY, deps.fetch),
  };
}

function cors(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (origin && origin === env.WEB_ORIGIN) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'false',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  }
  return { vary: 'origin' };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const ctx = makeCtx(deps);
  const url = new URL(req.url);
  const extra = { ...cors(deps.env, req), ...SECURITY_HEADERS };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
  let res: Response;
  try {
    const m = router.match(req.method, url.pathname);
    if (m === null) res = json({ error: 'not_found' }, 404);
    else if (m === 'method') res = json({ error: 'method_not_allowed' }, 405);
    else res = await m.handler(req, m.params, ctx);
  } catch (e) {
    if (e instanceof HttpError) res = json({ error: e.code, message: e.message }, e.status);
    else {
      // Unexpected errors: log the shape server-side, never the details to the client.
      console.error('unhandled', e instanceof Error ? e.name : typeof e);
      res = json({ error: 'internal', message: 'Something went wrong. Try again.' }, 500);
    }
  }
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** Queue consumer: one workflow_dispatch per job. Throwing makes the Queue retry with backoff. */
export async function dispatch(msg: DispatchMessage, deps: Deps): Promise<'dispatched' | 'skipped'> {
  const ctx = makeCtx(deps);
  const { env } = deps;
  const table = msg.kind === 'analyze' ? 'analysis_jobs' : 'builds';
  const row = await ctx.service.one<{ status: string; claimed_at: string | null }>(table, { id: eq(msg.jobId), select: 'status,claimed_at' });
  if (!row || row.status !== 'QUEUED' || row.claimed_at) return 'skipped'; // cancelled or already running
  const workflow = msg.kind === 'build' && msg.platform === 'ios' ? 'g2a-ios.yml' : 'g2a-job.yml';
  await ctx.workers.dispatchWorkflow(env.WORKERS_INSTALLATION_ID, env.WORKERS_REPO, workflow, env.WORKERS_REF, {
    job_id: msg.jobId,
    job_kind: msg.kind === 'analyze' ? 'analysis' : 'build',
    api_origin: env.API_ORIGIN,
  });
  return 'dispatched';
}

interface QueueBatch {
  messages: Array<{ body: DispatchMessage; ack(): void; retry(): void }>;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, { env, fetch: fetch.bind(globalThis), now: Date.now });
  },
  async queue(batch: QueueBatch, env: Env): Promise<void> {
    const deps = { env, fetch: fetch.bind(globalThis), now: Date.now };
    for (const m of batch.messages) {
      try {
        await dispatch(m.body, deps);
        m.ack();
      } catch {
        m.retry();
      }
    }
  },
};
