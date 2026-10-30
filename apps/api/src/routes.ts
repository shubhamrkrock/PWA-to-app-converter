/**
 * REST API v1 (PRD §13). Every user route verifies the Supabase session and reads through the
 * user's own token so Postgres RLS enforces tenancy; writes that need the service role happen
 * only after ownership has been proven by such a read. Internal routes (/internal/*) are for
 * build workers and accept only a GitHub Actions OIDC token (claim) or a job ticket.
 */

import {
  canTransition,
  isTerminal,
  redact,
  validateConfig,
  type AppConfiguration,
  type BuildStatus,
  type AnalysisReport,
} from '@git2app/shared';
import { Db, eq, inList } from './db.ts';
import type { Deps, DispatchMessage } from './env.ts';
import { GithubApp, actionsJwks, verifyActionsToken } from './github.ts';
import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  json,
  notFound,
  readJson,
  Router,
  tooMany,
  unauthorized,
  uuidParam,
} from './http.ts';
import {
  bytesToB64,
  b64ToBytes,
  openCredential,
  sealCredential,
  sha256Hex,
  signToken,
  verifyGithubSignature,
  verifySupabaseJwt,
  verifyToken,
  type Jwk,
} from './crypto.ts';
import { limitsFor, monthStart } from './quotas.ts';

// ------------------------------------------------------------------ context

export interface Ctx {
  deps: Deps;
  gh: GithubApp;
  service: Db;
}

interface User {
  id: string;
  token: string;
  db: Db;
}

let supabaseJwks: { at: number; keys: Jwk[] } | null = null;
export function _resetSupabaseJwksForTests(): void {
  supabaseJwks = null;
}

async function requireUser(req: Request, ctx: Ctx): Promise<User> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw unauthorized();
  const { env, fetch: f, now } = ctx.deps;
  if (!supabaseJwks || now() - supabaseJwks.at > 10 * 60_000) {
    const res = await f(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) throw new HttpError(502, 'auth_keys', 'Could not load sign-in keys');
    supabaseJwks = { at: now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  }
  const claims = await verifySupabaseJwt(token, supabaseJwks.keys, now());
  if (!claims) throw unauthorized('Session expired or invalid. Sign in again.');
  return { id: claims.sub, token, db: new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, token, f) };
}

async function audit(ctx: Ctx, userId: string | null, action: string, subject: string, detail: Record<string, unknown> = {}): Promise<void> {
  await ctx.service.insert('audit_events', { user_id: userId, action, subject, detail });
}

// ------------------------------------------------------------------ row types

interface ProjectRow {
  id: string;
  user_id: string;
  installation_id: number;
  repository_id: number;
  repository_name: string;
  repository_url: string;
  branch: string;
  project_root: string;
  output_dir: string | null;
  hosted_origin: string | null;
  auto_build: boolean;
}

interface BuildRow {
  id: string;
  project_id: string;
  user_id: string;
  configuration_id: string | null;
  commit_sha: string;
  platform: 'android' | 'ios';
  packaging_strategy: 'twa' | 'capacitor';
  variant: 'debug' | 'release';
  status: BuildStatus;
  worker_id: string | null;
  claimed_at: string | null;
  build_metadata: Record<string, unknown>;
}

interface ConfigRow {
  id: string;
  project_id: string;
  user_id: string;
  app_name: string;
  package_id: string;
  bundle_id: string;
  version: string;
  build_number: number;
  icon_url: string | null;
  splash_url: string | null;
  permissions: AppConfiguration['permissions'];
  android_config: Record<string, unknown>;
  ios_config: Record<string, unknown>;
}

const SHA = /^[0-9a-f]{40}$/;

function configFromRow(r: ConfigRow): AppConfiguration {
  return {
    appName: r.app_name,
    packageId: r.package_id,
    bundleId: r.bundle_id,
    version: r.version,
    buildNumber: r.build_number,
    iconPath: r.icon_url,
    splashPath: r.splash_url,
    themeColor: (r.android_config.themeColor as string | undefined) ?? null,
    backgroundColor: (r.android_config.backgroundColor as string | undefined) ?? null,
    orientation: ((r.android_config.orientation as string | undefined) ?? 'default') as AppConfiguration['orientation'],
    permissions: r.permissions ?? [],
    permissionText: (r.ios_config.permissionText as AppConfiguration['permissionText']) ?? {},
    urlScheme: (r.ios_config.urlScheme as string | undefined) ?? null,
    privacyPolicyUrl: (r.ios_config.privacyPolicyUrl as string | undefined) ?? null,
  };
}

async function ownProject(user: User, id: string): Promise<ProjectRow> {
  const p = await user.db.one<ProjectRow>('projects', { id: eq(uuidParam(id)), select: '*' });
  if (!p) throw notFound('Project not found');
  return p;
}

async function ownInstallation(user: User, installationId: number): Promise<void> {
  const row = await user.db.one('github_installations', { installation_id: eq(installationId), select: 'id' });
  if (!row) throw forbidden('That GitHub installation is not connected to your account');
}

// ------------------------------------------------------------------ router

export function buildRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  const V = '/api/v1';

  // ---------------- GitHub connection
  r.on('GET', `${V}/github/install-url`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    const state = await signToken(ctx.deps.env.STATE_SECRET, { u: user.id, exp: Math.floor(ctx.deps.now() / 1000) + 600 });
    return json({ url: `https://github.com/apps/${ctx.deps.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}` });
  });

  // GitHub redirects here after install with ?installation_id&code&state. We prove the person
  // who installed is the signed-in user: the OAuth code yields their GitHub token, and that
  // token must be able to see the installation. The user token is used once and dropped.
  r.on('GET', `${V}/github/callback`, async (req, _p, ctx) => {
    const { env } = ctx.deps;
    const url = new URL(req.url);
    const state = await verifyToken<{ u: string; exp: number }>(env.STATE_SECRET, url.searchParams.get('state') ?? '', ctx.deps.now());
    const installationId = Number(url.searchParams.get('installation_id'));
    const code = url.searchParams.get('code');
    if (!state || !Number.isSafeInteger(installationId) || installationId <= 0 || !code) {
      return Response.redirect(`${env.WEB_ORIGIN}/integrations?github=failed`, 302);
    }
    const userToken = await ctx.gh.exchangeUserCode(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, code);
    const visible = await ctx.gh.userInstallationIds(userToken);
    if (!visible.includes(installationId)) return Response.redirect(`${env.WEB_ORIGIN}/integrations?github=forbidden`, 302);
    const inst = await ctx.gh.getInstallation(installationId);
    await ctx.service.insert(
      'github_installations',
      { user_id: state.u, installation_id: installationId, account_name: inst.account.login, account_type: inst.account.type === 'Organization' ? 'Organization' : 'User' },
      { ignoreDuplicates: true },
    );
    await audit(ctx, state.u, 'github.connected', String(installationId), { account: inst.account.login });
    return Response.redirect(`${env.WEB_ORIGIN}/integrations?github=connected`, 302);
  });

  r.on('GET', `${V}/github/installations`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    return json(await user.db.select('github_installations', { select: 'installation_id,account_name,account_type,created_at', order: 'created_at.asc' }));
  });

  r.on('DELETE', `${V}/github/installations/:installationId`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const id = Number(p.installationId);
    if (!Number.isSafeInteger(id)) throw badRequest('installationId must be a number');
    await ownInstallation(user, id);
    await ctx.service.delete('github_installations', { user_id: eq(user.id), installation_id: eq(id) });
    await ctx.service.update('projects', { user_id: eq(user.id), installation_id: eq(id) }, { auto_build: false });
    await audit(ctx, user.id, 'github.disconnected', String(id));
    // Uninstalling the App on GitHub is the user's action (it may serve other accounts); we
    // stop using it immediately and tell the UI where to finish revoking.
    return json({ disconnected: true, revokeAt: `https://github.com/settings/installations/${id}` });
  });

  r.on('GET', `${V}/github/repositories`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    const insts = await user.db.select<{ installation_id: number }>('github_installations', { select: 'installation_id' });
    const out = [];
    for (const i of insts) {
      for (const repo of await ctx.gh.listRepos(i.installation_id)) {
        out.push({
          installationId: i.installation_id,
          id: repo.id,
          name: repo.name,
          owner: repo.owner.login,
          fullName: repo.full_name,
          description: repo.description,
          defaultBranch: repo.default_branch,
          updatedAt: repo.pushed_at ?? repo.updated_at,
          language: repo.language,
          visibility: repo.private ? 'private' : 'public',
          url: repo.html_url,
        });
      }
    }
    return json(out);
  });

  r.on('GET', `${V}/github/repositories/:id/branches`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const repoId = Number(p.id);
    const installationId = Number(new URL(req.url).searchParams.get('installation_id'));
    if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(installationId)) throw badRequest('Repository and installation ids are required');
    await ownInstallation(user, installationId);
    const branches = await ctx.gh.listBranches(installationId, repoId);
    return json(branches.map((b) => ({ name: b.name, sha: b.commit.sha })));
  });

  // ---------------- Projects
  r.on('POST', `${V}/projects`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    const b = await readJson<{ installationId: number; repositoryId: number; branch?: string; projectRoot?: string; outputDir?: string | null; hostedOrigin?: string | null; autoBuild?: boolean }>(req);
    if (!Number.isSafeInteger(b.installationId) || !Number.isSafeInteger(b.repositoryId)) throw badRequest('installationId and repositoryId are required');
    const root = (b.projectRoot ?? '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (root.split('/').includes('..')) throw badRequest('Project root must stay inside the repository');
    if (b.outputDir && (b.outputDir.split('/').includes('..') || b.outputDir.startsWith('/'))) throw badRequest('Output folder must stay inside the project');
    if (b.hostedOrigin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(b.hostedOrigin)) throw badRequest('Hosted origin must be like https://app.example.com');
    await ownInstallation(user, b.installationId);

    const profile = await user.db.one<{ subscription_plan: string }>('profiles', { id: eq(user.id), select: 'subscription_plan' });
    const limits = limitsFor(profile?.subscription_plan);
    const existing = await user.db.select('projects', { select: 'id', limit: String(limits.projects + 1) });
    if (existing.length >= limits.projects) throw tooMany(`Your plan allows ${limits.projects} project(s).`);
    if (b.autoBuild && !limits.autoBuilds) throw forbidden('Automatic builds are not in your plan.');

    const repo = await ctx.gh.getRepo(b.installationId, b.repositoryId); // proves the App can see it
    const [row] = await user.db.insert<ProjectRow>('projects', {
      user_id: user.id,
      installation_id: b.installationId,
      repository_id: repo.id,
      repository_name: repo.full_name,
      repository_url: repo.html_url,
      branch: b.branch || repo.default_branch,
      project_root: root,
      output_dir: b.outputDir ?? null,
      hosted_origin: b.hostedOrigin ?? null,
      auto_build: !!b.autoBuild,
    });
    await audit(ctx, user.id, 'project.created', row!.id, { repo: repo.full_name });
    return json(row, 201);
  });

  r.on('GET', `${V}/projects`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    return json(await user.db.select('projects', { select: '*', order: 'created_at.desc' }));
  });

  r.on('GET', `${V}/projects/:id`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    return json(await ownProject(user, p.id!));
  });

  r.on('DELETE', `${V}/projects/:id`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const builds = await user.db.select<{ id: string }>('builds', { project_id: eq(project.id), select: 'id' });
    for (const b of builds) await deletePrefix(ctx, `u/${user.id}/b/${b.id}/`);
    await user.db.delete('projects', { id: eq(project.id) });
    await audit(ctx, user.id, 'project.deleted', project.id, { repo: project.repository_name, artifactsDeleted: builds.length });
    return json({ deleted: true });
  });

  // ---------------- Analysis
  r.on('POST', `${V}/projects/:id/analyze`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const body = req.headers.get('content-length') && req.headers.get('content-length') !== '0' ? await readJson<{ commitSha?: string }>(req) : {};
    const sha = body.commitSha ?? (await ctx.gh.branchHead(project.installation_id, project.repository_id, project.branch));
    if (!SHA.test(sha)) throw badRequest('commitSha must be a full 40-character SHA');
    const [job] = await ctx.service.insert<{ id: string }>('analysis_jobs', { project_id: project.id, user_id: user.id, commit_sha: sha });
    await ctx.deps.env.DISPATCH_QUEUE.send({ jobId: job!.id, kind: 'analyze', platform: null });
    return json({ analysisJobId: job!.id, commitSha: sha, status: 'QUEUED' }, 202);
  });

  r.on('GET', `${V}/projects/:id/analysis`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const latest = await user.db.one('project_analyses', { project_id: eq(project.id), select: '*', order: 'created_at.desc' });
    const pending = await user.db.one('analysis_jobs', { project_id: eq(project.id), select: 'id,status,commit_sha,error_message,created_at', order: 'created_at.desc' });
    return json({ analysis: latest, job: pending });
  });

  // ---------------- Configuration
  r.on('POST', `${V}/projects/:id/configuration`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const input = await readJson<Partial<AppConfiguration>>(req);
    const v = validateConfig(input);
    if (!v.ok) return json({ error: 'invalid_configuration', fields: v.errors }, 422);
    const c = v.config;
    const [row] = await user.db.insert<ConfigRow>('app_configurations', {
      project_id: project.id,
      user_id: user.id,
      app_name: c.appName,
      package_id: c.packageId,
      bundle_id: c.bundleId,
      version: c.version,
      build_number: c.buildNumber,
      icon_url: c.iconPath,
      splash_url: c.splashPath,
      permissions: c.permissions,
      android_config: { themeColor: c.themeColor, backgroundColor: c.backgroundColor, orientation: c.orientation },
      ios_config: { privacyPolicyUrl: c.privacyPolicyUrl, permissionText: c.permissionText ?? {}, urlScheme: c.urlScheme ?? null },
    });
    return json({ id: row!.id, ...c }, 201);
  });

  r.on('GET', `${V}/projects/:id/configuration`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const row = await user.db.one<ConfigRow>('app_configurations', { project_id: eq(project.id), select: '*', order: 'created_at.desc' });
    return json(row ? { id: row.id, ...configFromRow(row) } : null);
  });

  // ---------------- Builds
  r.on('POST', `${V}/projects/:id/builds`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const project = await ownProject(user, p.id!);
    const b = await readJson<{
      platforms: Array<'android' | 'ios'>;
      commit_sha?: string;
      android_strategy?: 'twa' | 'capacitor';
      ios_strategy?: 'capacitor';
      configuration_id: string;
      generate_debug?: boolean;
      generate_release?: boolean;
      signing?: { android?: string; ios?: string };
    }>(req);
    return json(await createBuilds(ctx, user, project, b, 'manual'), 201);
  });

  r.on('GET', `${V}/builds`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    const url = new URL(req.url);
    const q: Record<string, string> = { select: 'id,project_id,platform,packaging_strategy,variant,status,commit_sha,created_at,started_at,completed_at,error_message', order: 'created_at.desc', limit: '50' };
    const pid = url.searchParams.get('project_id');
    if (pid) q.project_id = eq(uuidParam(pid, 'project_id'));
    return json(await user.db.select('builds', q));
  });

  r.on('GET', `${V}/builds/:id`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const row = await user.db.one('builds', { id: eq(uuidParam(p.id)), select: '*' });
    if (!row) throw notFound('Build not found');
    return json(row);
  });

  r.on('POST', `${V}/builds/:id/cancel`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const b = await user.db.one<BuildRow>('builds', { id: eq(uuidParam(p.id)), select: '*' });
    if (!b) throw notFound('Build not found');
    if (isTerminal(b.status)) throw conflict(`Build already finished (${b.status})`);
    await ctx.service.update('builds', { id: eq(b.id) }, { status: 'CANCELLED', completed_at: new Date(ctx.deps.now()).toISOString() });
    if (b.worker_id) {
      try {
        await ctx.gh.cancelRun(ctx.deps.env.WORKERS_INSTALLATION_ID, ctx.deps.env.WORKERS_REPO, b.worker_id);
      } catch {
        // The run may have just ended; the job ticket is refused for a cancelled build anyway.
      }
    }
    await audit(ctx, user.id, 'build.cancelled', b.id);
    return json({ id: b.id, status: 'CANCELLED' });
  });

  r.on('POST', `${V}/builds/:id/retry`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const b = await user.db.one<BuildRow>('builds', { id: eq(uuidParam(p.id)), select: '*' });
    if (!b) throw notFound('Build not found');
    if (!(b.status.startsWith('FAILED_') || b.status === 'CANCELLED')) throw conflict('Only failed or cancelled builds can be retried');
    const project = await ownProject(user, b.project_id);
    if (!b.configuration_id) throw conflict('The configuration for this build was deleted; start a new build');
    const signing = (b.build_metadata.signing as { android?: string; ios?: string } | undefined) ?? {};
    const res = await createBuilds(
      ctx,
      user,
      project,
      {
        platforms: [b.platform],
        commit_sha: b.commit_sha,
        ...(b.platform === 'android' ? { android_strategy: b.packaging_strategy } : { ios_strategy: 'capacitor' as const }),
        configuration_id: b.configuration_id,
        generate_debug: b.variant === 'debug',
        generate_release: b.variant === 'release',
        signing,
      },
      'retry',
      b.id,
    );
    return json(res, 201);
  });

  r.on('GET', `${V}/builds/:id/logs`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const b = await user.db.one<BuildRow>('builds', { id: eq(uuidParam(p.id)), select: 'id,user_id' });
    if (!b) throw notFound('Build not found');
    const listed = await ctx.deps.env.ARTIFACTS.list({ prefix: `u/${user.id}/b/${b.id}/logs/` });
    const keys = listed.objects.map((o) => o.key).sort();
    let text = '';
    for (const k of keys) {
      const obj = await ctx.deps.env.ARTIFACTS.get(k);
      if (obj) text += await new Response(obj.body).text();
      if (text.length > 5_000_000) {
        text += '\n[log truncated at 5 MB; download the log artifact for the rest]\n';
        break;
      }
    }
    return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  });

  r.on('GET', `${V}/builds/:id/artifacts`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const id = uuidParam(p.id);
    return json(await user.db.select('build_artifacts', { build_id: eq(id), select: 'id,artifact_type,file_size,checksum,validated,expires_at,created_at' }));
  });

  // ---------------- Downloads
  r.on('POST', `${V}/artifacts/:id/download-url`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const a = await user.db.one<{ id: string; build_id: string; storage_key: string; validated: boolean; expires_at: string; artifact_type: string }>('build_artifacts', {
      id: eq(uuidParam(p.id)),
      select: 'id,build_id,storage_key,validated,expires_at,artifact_type',
    });
    if (!a) throw notFound('Artifact not found');
    if (Date.parse(a.expires_at) < ctx.deps.now()) throw new HttpError(410, 'expired', 'This artifact has expired. Rebuild to get a new one.');
    // Packages are offered only after validation (PRD principle 13). Logs and reports are always downloadable.
    if (['apk', 'aab', 'ipa', 'ios-simulator-app'].includes(a.artifact_type) && !a.validated) throw conflict('This package has not passed validation');
    const token = await signToken(ctx.deps.env.STATE_SECRET, { a: a.id, k: a.storage_key, exp: Math.floor(ctx.deps.now() / 1000) + 600 });
    await audit(ctx, user.id, 'artifact.download_url', a.id);
    return json({ url: `${ctx.deps.env.API_ORIGIN}${V}/dl/${token}`, expiresIn: 600 });
  });

  r.on('GET', `${V}/dl/:token`, async (_req, p, ctx) => {
    const t = await verifyToken<{ a: string; k: string; exp: number }>(ctx.deps.env.STATE_SECRET, p.token!, ctx.deps.now());
    if (!t) throw forbidden('This download link is invalid or has expired');
    const obj = await ctx.deps.env.ARTIFACTS.get(t.k);
    if (!obj) throw notFound('File not found');
    const name = t.k.split('/').pop()!.replace(/[^\w.-]/g, '_');
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  // ---------------- Signing credentials (vault)
  r.on('GET', `${V}/signing-credentials`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    return json(await user.db.select('signing_credentials_meta', { select: '*', order: 'created_at.desc' }));
  });

  r.on('POST', `${V}/signing-credentials`, async (req, _p, ctx) => {
    const user = await requireUser(req, ctx);
    const profile = await user.db.one<{ subscription_plan: string }>('profiles', { id: eq(user.id), select: 'subscription_plan' });
    if (!limitsFor(profile?.subscription_plan).signingVault) throw forbidden('The signing vault is not in your plan.');
    const b = await readJson<{ platform: 'android' | 'ios'; type: string; label?: string; payload: Record<string, string> }>(req, 512 * 1024);
    const shape = CREDENTIAL_SHAPES[b.type];
    if (!shape || shape.platform !== b.platform) throw badRequest('Unknown credential type for that platform');
    for (const f of shape.fields) if (typeof b.payload?.[f] !== 'string' || !b.payload[f]) throw badRequest(`Missing ${f}`);
    const clean = Object.fromEntries(shape.fields.map((f) => [f, b.payload[f]!]));
    const id = crypto.randomUUID();
    const sealed = await sealCredential(ctx.deps.env.CREDENTIALS_MASTER_KEY, new TextEncoder().encode(JSON.stringify(clean)), `${user.id}:${id}`);
    await ctx.service.insert('signing_credentials', {
      id,
      user_id: user.id,
      platform: b.platform,
      credential_type: b.type,
      label: (b.label ?? '').slice(0, 80),
      encrypted_payload: `\\x${[...sealed].map((x) => x.toString(16).padStart(2, '0')).join('')}`,
      key_reference: ctx.deps.env.CREDENTIALS_KEY_REF,
    });
    await audit(ctx, user.id, 'credential.stored', id, { type: b.type });
    return json({ id, platform: b.platform, type: b.type }, 201);
  });

  r.on('DELETE', `${V}/signing-credentials/:id`, async (req, p, ctx) => {
    const user = await requireUser(req, ctx);
    const id = uuidParam(p.id);
    const meta = await user.db.one('signing_credentials_meta', { id: eq(id), select: 'id' });
    if (!meta) throw notFound('Credential not found');
    await ctx.service.delete('signing_credentials', { id: eq(id), user_id: eq(user.id) });
    await audit(ctx, user.id, 'credential.deleted', id);
    return json({ deleted: true });
  });

  // ---------------- GitHub webhooks (PRD §14)
  r.on('POST', `${V}/github/webhooks`, async (req, _p, ctx) => {
    const raw = await req.text();
    if (raw.length > 5_000_000) throw badRequest('Payload too large');
    const ok = await verifyGithubSignature(ctx.deps.env.GITHUB_WEBHOOK_SECRET, raw, req.headers.get('x-hub-signature-256'));
    if (!ok) throw unauthorized('Bad signature');
    const event = req.headers.get('x-github-event') ?? '';
    const delivery = req.headers.get('x-github-delivery') ?? '';
    const payload = JSON.parse(raw) as Record<string, any>;
    if (event === 'push') return json(await onPush(ctx, payload, delivery));
    if (event === 'installation' && payload.action === 'deleted') {
      const id = Number(payload.installation?.id);
      await ctx.service.update('projects', { installation_id: eq(id) }, { auto_build: false });
      await ctx.service.delete('github_installations', { installation_id: eq(id) });
      await audit(ctx, null, 'github.uninstalled', String(id));
    }
    if (event === 'installation_repositories' && payload.action === 'removed') {
      const ids = (payload.repositories_removed ?? []).map((x: { id: number }) => x.id).filter(Number.isSafeInteger);
      if (ids.length) await ctx.service.update('projects', { repository_id: inList(ids), installation_id: eq(Number(payload.installation?.id)) }, { auto_build: false });
    }
    return json({ ok: true });
  });

  // ---------------- Internal: build workers
  // 1) Claim: the worker proves it is a dispatched run of our job workflow (OIDC) and gets a
  //    ticket scoped to that one job. A job is claimable once.
  r.on('POST', `${V}/internal/jobs/:kind/:id/claim`, async (req, p, ctx) => {
    const { env, now } = ctx.deps;
    const kind = p.kind === 'analysis' ? 'analysis' : p.kind === 'build' ? 'build' : null;
    if (!kind) throw notFound();
    const id = uuidParam(p.id);
    const oidc = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const jwks = await actionsJwks(ctx.deps.fetch, now());
    const claims = await verifyActionsToken(oidc, { audience: env.API_ORIGIN, workersRepo: env.WORKERS_REPO, workersRef: env.WORKERS_REF, jwks, now: now() });
    if (!claims) throw unauthorized('Worker identity could not be verified');
    const wf = String(claims.workflow_ref);
    const isIosRunner = wf.includes('/g2a-ios.yml@');
    const nowIso = new Date(now()).toISOString();

    if (kind === 'analysis') {
      if (isIosRunner) throw forbidden('Analysis runs on the Linux job workflow');
      const rows = await ctx.service.update<{ id: string }>('analysis_jobs', { id: eq(id), status: eq('QUEUED'), claimed_at: 'is.null' }, { status: 'RUNNING', run_id: claims.run_id, claimed_at: nowIso });
      if (!rows.length) throw conflict('Job already claimed or not queued');
    } else {
      const b = await ctx.service.one<BuildRow>('builds', { id: eq(id), select: 'id,platform,status,claimed_at' });
      if (!b) throw notFound('Build not found');
      // Principle 4, enforced server-side: an iOS build is only handed to the macOS workflow,
      // and an Android build only to the Linux one.
      if ((b.platform === 'ios') !== isIosRunner) throw forbidden('This build must run on its own platform workflow');
      const rows = await ctx.service.update<{ id: string }>('builds', { id: eq(id), status: eq('QUEUED'), claimed_at: 'is.null' }, { worker_id: claims.run_id, claimed_at: nowIso, started_at: nowIso });
      if (!rows.length) throw conflict('Build already claimed or not queued');
    }
    const ttl = kind === 'build' ? 3 * 3600 : 1800;
    const ticket = await signToken(env.TICKET_SECRET, { j: id, k: kind, r: claims.run_id, exp: Math.floor(now() / 1000) + ttl });
    return json({ ticket });
  });

  // 2) Spec: what to build. Clone token is per-repo, read-only, ~1h. Signing material only for
  //    release builds, decrypted here, sent over TLS to the claimed run only.
  r.on('GET', `${V}/internal/jobs/:kind/:id/spec`, async (req, p, ctx) => {
    const t = await requireTicket(req, ctx, p);
    if (t.k === 'analysis') {
      const job = await ctx.service.one<{ project_id: string; commit_sha: string; status: string }>('analysis_jobs', { id: eq(t.j), select: 'project_id,commit_sha,status' });
      if (!job || job.status !== 'RUNNING') throw conflict('Job is not running');
      const project = (await ctx.service.one<ProjectRow>('projects', { id: eq(job.project_id), select: '*' }))!;
      return json({
        kind: 'analysis',
        jobId: t.j,
        repo: await repoSpec(ctx, project, job.commit_sha),
        hostedOrigin: project.hosted_origin,
      });
    }
    const b = await ctx.service.one<BuildRow>('builds', { id: eq(t.j), select: '*' });
    if (!b || isTerminal(b.status)) throw conflict('Build is not active');
    const project = (await ctx.service.one<ProjectRow>('projects', { id: eq(b.project_id), select: '*' }))!;
    const cfg = b.configuration_id ? await ctx.service.one<ConfigRow>('app_configurations', { id: eq(b.configuration_id), select: '*' }) : null;
    if (!cfg) throw conflict('Configuration missing');
    return json({
      kind: 'build',
      jobId: b.id,
      platform: b.platform,
      strategy: b.packaging_strategy,
      variant: b.variant,
      repo: await repoSpec(ctx, project, b.commit_sha),
      build: { outputDir: project.output_dir, hostedOrigin: project.hosted_origin },
      config: configFromRow(cfg),
      // Signing material is never in the spec: the job that runs the app's own code (install,
      // web build, compile) must not be able to reach it. A separate signing job fetches it.
      needsSigning: b.variant === 'release',
      status: b.status,
    });
  });

  // 2b) Signing material, for release builds only. Callable only by the signing job: a run of
  //     the same workflow run that claimed the build, in the g2a-signing environment (a fresh VM
  //     that never runs repository code), while the build is at the SIGNING stage.
  r.on('POST', `${V}/internal/jobs/build/:id/signing`, async (req, p, ctx) => {
    const { env, now } = ctx.deps;
    const id = uuidParam(p.id);
    const oidc = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const jwks = await actionsJwks(ctx.deps.fetch, now());
    const claims = await verifyActionsToken(oidc, { audience: env.API_ORIGIN, workersRepo: env.WORKERS_REPO, workersRef: env.WORKERS_REF, jwks, now: now() });
    if (!claims) throw unauthorized('Worker identity could not be verified');
    if (claims.environment !== 'g2a-signing') throw forbidden('Signing material is only released to the signing job');
    const b = await ctx.service.one<BuildRow>('builds', { id: eq(id), select: '*' });
    if (!b) throw notFound('Build not found');
    if (b.worker_id !== claims.run_id) throw forbidden('This run did not claim the build');
    if (b.status !== 'SIGNING' || b.variant !== 'release') throw conflict('Build is not waiting for signing');
    const credId = (b.build_metadata.signing as Record<string, string> | undefined)?.[b.platform];
    if (!credId) throw conflict('Release build has no signing credential');
    const signing = await openCredentialRow(ctx, b.user_id, credId);
    const ticket = await signToken(env.TICKET_SECRET, { j: b.id, k: 'build', r: claims.run_id, exp: Math.floor(now() / 1000) + 3600 });
    await audit(ctx, b.user_id, 'credential.released_to_signer', credId, { build: b.id, run: claims.run_id });
    return json({ signing, ticket });
  });

  // 3) Status: forward-only through the shared state machine.
  r.on('POST', `${V}/internal/jobs/:kind/:id/status`, async (req, p, ctx) => {
    const t = await requireTicket(req, ctx, p);
    const body = await readJson<{ status: string; message?: string }>(req);
    const nowIso = new Date(ctx.deps.now()).toISOString();
    if (t.k === 'analysis') {
      if (!['COMPLETED', 'FAILED'].includes(body.status)) throw badRequest('Analysis status must be COMPLETED or FAILED');
      await ctx.service.update('analysis_jobs', { id: eq(t.j), status: eq('RUNNING') }, { status: body.status, error_message: body.message ? redact(body.message).slice(0, 4000) : null });
      return json({ ok: true });
    }
    const b = await ctx.service.one<BuildRow>('builds', { id: eq(t.j), select: 'id,status' });
    if (!b) throw notFound();
    const to = body.status as BuildStatus;
    if (!canTransition(b.status, to)) throw conflict(`Illegal transition ${b.status} -> ${body.status}`);
    const patch: Record<string, unknown> = { status: to, build_stage: to };
    if (isTerminal(to)) patch.completed_at = nowIso;
    if (body.message) patch.error_message = redact(body.message).slice(0, 4000);
    // Conditional on the status we read, so two racing updates cannot both apply.
    const rows = await ctx.service.update('builds', { id: eq(b.id), status: eq(b.status) }, patch);
    if (!rows.length) throw conflict('Build changed concurrently; retry');
    return json({ ok: true, status: to });
  });

  // 4) Logs: append-only chunks, redacted again here as defence in depth.
  r.on('POST', `${V}/internal/jobs/:kind/:id/logs`, async (req, p, ctx) => {
    const t = await requireTicket(req, ctx, p);
    const seq = Number(req.headers.get('x-seq'));
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > 99_999) throw badRequest('x-seq must be 0..99999');
    const text = await req.text();
    if (text.length > 512 * 1024) throw badRequest('Log chunk too large');
    const owner = await jobOwner(ctx, t);
    await ctx.deps.env.ARTIFACTS.put(`u/${owner}/b/${t.j}/logs/${String(seq).padStart(5, '0')}.log`, redact(text), { httpMetadata: { contentType: 'text/plain' } });
    return json({ ok: true });
  });

  // 5) Artifacts: checksum verified on arrival; "validated" only if the worker's validation
  //    stage passed and the build is in VALIDATION.
  r.on('PUT', `${V}/internal/jobs/:kind/:id/artifacts/:type`, async (req, p, ctx) => {
    const t = await requireTicket(req, ctx, p);
    if (t.k !== 'build') throw badRequest('Only builds upload artifacts');
    const type = p.type!;
    if (!['apk', 'aab', 'ipa', 'ios-simulator-app', 'android-project', 'ios-project', 'report'].includes(type)) throw badRequest('Unknown artifact type');
    const b = await ctx.service.one<BuildRow>('builds', { id: eq(t.j), select: 'id,user_id,status,platform' });
    if (!b || isTerminal(b.status)) throw conflict('Build is not active');
    if ((type === 'ipa' || type === 'ios-simulator-app') && b.platform !== 'ios') throw badRequest('IPA and simulator apps only from iOS builds');
    if ((type === 'apk' || type === 'aab') && b.platform !== 'android') throw badRequest('APK/AAB only from Android builds');
    const declared = (req.headers.get('x-sha256') ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(declared)) throw badRequest('x-sha256 header required');
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.length === 0) throw badRequest('Empty artifact');
    const actual = await sha256Hex(data);
    if (actual !== declared) throw badRequest('Checksum mismatch; upload corrupted');
    const name = (new URL(req.url).searchParams.get('name') ?? type).replace(/[^\w.-]/g, '_').slice(0, 100);
    const key = `u/${b.user_id}/b/${b.id}/${type}-${name}`;
    await ctx.deps.env.ARTIFACTS.put(key, data);
    const validated = req.headers.get('x-validated') === 'true' && b.status === 'VALIDATION';
    const [row] = await ctx.service.insert<{ id: string }>('build_artifacts', {
      build_id: b.id,
      user_id: b.user_id,
      artifact_type: type,
      storage_key: key,
      file_size: data.length,
      checksum: actual,
      validated,
    });
    return json({ id: row!.id, checksum: actual, validated }, 201);
  });

  // 6) Analysis result.
  r.on('POST', `${V}/internal/jobs/:kind/:id/analysis`, async (req, p, ctx) => {
    const t = await requireTicket(req, ctx, p);
    if (t.k !== 'analysis') throw badRequest('Not an analysis job');
    const job = await ctx.service.one<{ id: string; project_id: string; user_id: string; commit_sha: string; status: string }>('analysis_jobs', { id: eq(t.j), select: '*' });
    if (!job || job.status !== 'RUNNING') throw conflict('Job is not running');
    const report = await readJson<AnalysisReport>(req, 1024 * 1024);
    if (report?.schemaVersion !== 1 || typeof report.framework !== 'string') throw badRequest('Report is not a Git2App analysis report');
    const score = Math.round((report.scores.android + report.scores.ios + report.scores.pwa) / 3);
    const [a] = await ctx.service.insert<{ id: string }>('project_analyses', {
      project_id: job.project_id,
      user_id: job.user_id,
      commit_sha: job.commit_sha,
      framework_detected: report.framework,
      pwa_detected: report.pwa.isInstallablePwa,
      compatibility_score: score,
      recommended_android_strategy: report.recommendedAndroidStrategy,
      recommended_ios_strategy: report.recommendedIosStrategy,
      analysis_report: report,
    });
    await ctx.service.update('projects', { id: eq(job.project_id) }, {
      framework: report.framework,
      package_manager: report.build.packageManager,
      output_dir: report.build.outputDir,
      updated_at: new Date(ctx.deps.now()).toISOString(),
    });
    await ctx.service.update('analysis_jobs', { id: eq(job.id) }, { status: 'COMPLETED', analysis_id: a!.id });
    return json({ analysisId: a!.id }, 201);
  });

  return r;
}

// ------------------------------------------------------------------ helpers

const CREDENTIAL_SHAPES: Record<string, { platform: 'android' | 'ios'; fields: string[] }> = {
  'android-keystore': { platform: 'android', fields: ['keystoreB64', 'storePassword', 'keyAlias', 'keyPassword'] },
  'ios-certificate': { platform: 'ios', fields: ['p12B64', 'p12Password', 'profileB64', 'teamId'] },
  'asc-api-key': { platform: 'ios', fields: ['keyId', 'issuerId', 'p8'] },
};

interface Ticket {
  j: string;
  k: 'analysis' | 'build';
  r: string;
  exp: number;
}

async function requireTicket(req: Request, ctx: Ctx, p: Record<string, string>): Promise<Ticket> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const t = await verifyToken<Ticket>(ctx.deps.env.TICKET_SECRET, raw, ctx.deps.now());
  if (!t) throw unauthorized('Invalid or expired job ticket');
  // The ticket is bound to exactly one job; the URL must name that job.
  if (t.j !== p.id || t.k !== p.kind) throw forbidden('Ticket is for another job');
  if (t.k === 'build') {
    const b = await ctx.service.one<{ worker_id: string | null; status: string }>('builds', { id: eq(t.j), select: 'worker_id,status' });
    if (!b || b.worker_id !== t.r) throw forbidden('Ticket does not match the claiming run');
    if (b.status === 'CANCELLED') throw new HttpError(410, 'cancelled', 'Build was cancelled');
  }
  return t;
}

async function jobOwner(ctx: Ctx, t: Ticket): Promise<string> {
  const table = t.k === 'build' ? 'builds' : 'analysis_jobs';
  const row = await ctx.service.one<{ user_id: string }>(table, { id: eq(t.j), select: 'user_id' });
  if (!row) throw notFound();
  return row.user_id;
}

async function repoSpec(ctx: Ctx, project: ProjectRow, sha: string) {
  return {
    fullName: project.repository_name,
    cloneUrl: `https://github.com/${project.repository_name}.git`,
    commitSha: sha,
    projectRoot: project.project_root,
    cloneToken: await ctx.gh.cloneToken(project.installation_id, project.repository_id),
  };
}

async function openCredentialRow(ctx: Ctx, userId: string, credId: string): Promise<Record<string, string>> {
  const row = await ctx.service.one<{ id: string; encrypted_payload: string }>('signing_credentials', { id: eq(credId), user_id: eq(userId), select: 'id,encrypted_payload' });
  if (!row) throw conflict('Signing credential not found');
  const hexStr = row.encrypted_payload.replace(/^\\x/, '');
  const bytes = new Uint8Array(hexStr.match(/../g)!.map((h) => parseInt(h, 16)));
  const plain = await openCredential(ctx.deps.env.CREDENTIALS_MASTER_KEY, bytes, `${userId}:${row.id}`);
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

async function deletePrefix(ctx: Ctx, prefix: string): Promise<void> {
  const listed = await ctx.deps.env.ARTIFACTS.list({ prefix });
  if (listed.objects.length) await ctx.deps.env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
}

interface CreateBuildBody {
  platforms: Array<'android' | 'ios'>;
  commit_sha?: string;
  android_strategy?: 'twa' | 'capacitor';
  ios_strategy?: 'capacitor';
  configuration_id: string;
  generate_debug?: boolean;
  generate_release?: boolean;
  signing?: { android?: string; ios?: string };
}

/** Shared by manual builds, retries and webhook auto-builds. */
export async function createBuilds(
  ctx: Ctx,
  user: { id: string; db: Db },
  project: ProjectRow,
  b: CreateBuildBody,
  trigger: 'manual' | 'retry' | 'push',
  retryOf?: string,
  idempotencyPrefix?: string,
) {
  const platforms = [...new Set(b.platforms ?? [])];
  if (!platforms.length || platforms.some((x) => x !== 'android' && x !== 'ios')) throw badRequest('platforms must be android and/or ios');
  const variants = [b.generate_debug !== false ? 'debug' : null, b.generate_release ? 'release' : null].filter(Boolean) as Array<'debug' | 'release'>;
  if (!variants.length) throw badRequest('Choose a debug and/or release build');

  const cfg = await user.db.one<ConfigRow>('app_configurations', { id: eq(uuidParam(b.configuration_id, 'configuration_id')), project_id: eq(project.id), select: 'id' });
  if (!cfg) throw badRequest('Configuration not found for this project');

  const sha = b.commit_sha ?? (await ctx.gh.branchHead(project.installation_id, project.repository_id, project.branch));
  if (!SHA.test(sha)) throw badRequest('commit_sha must be a full 40-character SHA');

  const analysis = await user.db.one<{ recommended_android_strategy: string; recommended_ios_strategy: string }>('project_analyses', {
    project_id: eq(project.id),
    select: 'recommended_android_strategy,recommended_ios_strategy',
    order: 'created_at.desc',
  });
  if (!analysis) throw conflict('Analyze the project before building');

  const profile = await user.db.one<{ subscription_plan: string }>('profiles', { id: eq(user.id), select: 'subscription_plan' });
  const limits = limitsFor(profile?.subscription_plan);
  if (trigger === 'push' && !limits.autoBuilds) throw forbidden('Automatic builds are not in your plan.');

  const strategyFor = (pl: 'android' | 'ios'): 'twa' | 'capacitor' => {
    const rec = pl === 'android' ? analysis.recommended_android_strategy : analysis.recommended_ios_strategy;
    const chosen = pl === 'android' ? (b.android_strategy ?? rec) : (b.ios_strategy ?? rec);
    if (chosen === 'unsupported' || (rec === 'unsupported' && chosen !== 'capacitor')) {
      throw conflict(`The analysis found this project cannot be packaged for ${pl} as-is. See the compatibility report.`);
    }
    if (pl === 'ios' && chosen !== 'capacitor') throw badRequest('iOS builds use Capacitor');
    if (chosen === 'twa' && !project.hosted_origin) throw badRequest('A Trusted Web Activity needs the hosted https origin set on the project');
    if (chosen !== 'twa' && chosen !== 'capacitor') throw badRequest('Unknown strategy');
    return chosen;
  };

  // Signing: release builds need the vault and a credential the user owns for that platform.
  const signing: Record<string, string> = {};
  if (variants.includes('release')) {
    if (!limits.signingVault) throw forbidden('Signed release builds need the signing vault, which is not in your plan.');
    for (const pl of platforms) {
      const id = b.signing?.[pl];
      if (!id) throw badRequest(`A ${pl} signing credential is required for a release build`);
      const meta = await user.db.one<{ platform: string; credential_type: string }>('signing_credentials_meta', { id: eq(uuidParam(id, 'signing id')), select: 'platform,credential_type' });
      if (!meta || meta.platform !== pl || !['android-keystore', 'ios-certificate'].includes(meta.credential_type)) throw badRequest(`Signing credential for ${pl} not found`);
      signing[pl] = id;
    }
  }

  // Quotas: monthly per platform, and concurrent builds.
  const since = monthStart(ctx.deps.now());
  for (const pl of platforms) {
    const cap = pl === 'ios' ? limits.iosBuildsPerMonth : limits.androidBuildsPerMonth;
    const used = await ctx.service.select('builds', { user_id: eq(user.id), platform: eq(pl), created_at: `gte.${since}`, select: 'id', limit: String(cap + 1) });
    if (used.length + variants.length > cap) throw tooMany(`Monthly ${pl} build limit reached (${cap}).`);
  }
  const live = await ctx.service.select<{ status: string }>('builds', { user_id: eq(user.id), select: 'status', status: 'not.in.(COMPLETED,CANCELLED,FAILED_ANALYSIS,FAILED_DEPENDENCIES,FAILED_WEB_BUILD,FAILED_NATIVE_CONFIGURATION,FAILED_COMPILATION,FAILED_SIGNING,FAILED_VALIDATION)', limit: '20' });
  if (live.length + platforms.length * variants.length > limits.concurrentBuilds + 1) throw tooMany('Too many builds running. Wait for one to finish.');

  const created: Array<{ id: string; platform: string; variant: string; strategy: string }> = [];
  for (const pl of platforms) {
    const strategy = strategyFor(pl);
    for (const variant of variants) {
      const row = {
        project_id: project.id,
        user_id: user.id,
        configuration_id: cfg.id,
        commit_sha: sha,
        platform: pl,
        packaging_strategy: strategy,
        variant,
        status: 'QUEUED',
        idempotency_key: idempotencyPrefix ? `${idempotencyPrefix}:${pl}:${variant}` : null,
        build_metadata: { trigger, ...(retryOf ? { retryOf } : {}), ...(Object.keys(signing).length ? { signing } : {}) },
      };
      const inserted = await ctx.service.insert<{ id: string }>('builds', row, { ignoreDuplicates: !!idempotencyPrefix });
      if (!inserted.length) continue; // duplicate webhook delivery: already queued
      const id = inserted[0]!.id;
      const msg: DispatchMessage = { jobId: id, kind: 'build', platform: pl };
      await ctx.deps.env.DISPATCH_QUEUE.send(msg);
      created.push({ id, platform: pl, variant, strategy });
    }
  }
  await ctx.service.insert('audit_events', { user_id: user.id, action: `build.${trigger}`, subject: project.id, detail: { sha, builds: created.map((c) => c.id) } });
  return { commitSha: sha, builds: created };
}

async function onPush(ctx: Ctx, payload: Record<string, any>, delivery: string) {
  if (payload.deleted || !SHA.test(String(payload.after ?? ''))) return { skipped: 'branch deleted or no commit' };
  const ref = String(payload.ref ?? '');
  if (!ref.startsWith('refs/heads/')) return { skipped: 'not a branch push' };
  const branch = ref.slice('refs/heads/'.length);
  const repoId = Number(payload.repository?.id);
  const installationId = Number(payload.installation?.id);
  if (!/^[0-9a-f-]{36}$/.test(delivery)) return { skipped: 'missing delivery id' };
  const projects = await ctx.service.select<ProjectRow>('projects', {
    repository_id: eq(repoId),
    installation_id: eq(installationId),
    branch: eq(branch),
    auto_build: 'is.true',
    select: '*',
  });
  const results = [];
  for (const project of projects) {
    // Act with the owner's identity for reads via the service client, scoped by user_id.
    const owner = { id: project.user_id, db: scopedServiceDb(ctx, project.user_id) };
    const cfg = await owner.db.one<{ id: string }>('app_configurations', { project_id: eq(project.id), select: 'id', order: 'created_at.desc' });
    const analysis = await owner.db.one<{ recommended_android_strategy: string; recommended_ios_strategy: string }>('project_analyses', { project_id: eq(project.id), select: 'recommended_android_strategy,recommended_ios_strategy', order: 'created_at.desc' });
    if (!cfg || !analysis) {
      results.push({ project: project.id, skipped: 'not configured or analyzed' });
      continue;
    }
    const platforms = (['android', 'ios'] as const).filter((pl) => (pl === 'android' ? analysis.recommended_android_strategy : analysis.recommended_ios_strategy) !== 'unsupported');
    try {
      // Push builds are debug only: a commit never auto-produces a release or reaches a store (PRD §14).
      const r = await createBuilds(ctx, owner, project, { platforms: [...platforms], commit_sha: payload.after, configuration_id: cfg.id, generate_debug: true, generate_release: false }, 'push', undefined, `push:${delivery}:${project.id}`);
      results.push({ project: project.id, builds: r.builds.length });
    } catch (e) {
      results.push({ project: project.id, skipped: e instanceof HttpError ? e.message : 'error' });
    }
  }
  return { results };
}

/**
 * Service-role reads for webhook processing, always filtered by the project owner's user_id so
 * the webhook path cannot cross tenants even though RLS is bypassed.
 */
function scopedServiceDb(ctx: Ctx, userId: string): Db {
  const svc = ctx.service;
  const scoped = Object.create(svc) as Db;
  scoped.one = <T>(table: string, q: Record<string, string>) => (table === 'profiles' ? svc.one<T>(table, { ...q, id: eq(userId) }) : svc.one<T>(table, { ...q, user_id: eq(userId) }));
  scoped.select = <T>(table: string, q: Record<string, string>) => (table === 'profiles' ? svc.select<T>(table, { ...q, id: eq(userId) }) : svc.select<T>(table, { ...q, user_id: eq(userId) }));
  return scoped;
}

export { bytesToB64, b64ToBytes };
