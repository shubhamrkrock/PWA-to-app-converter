/**
 * GitHub App client (PRD §4.2). The App's private key signs a 9-minute JWT; that is exchanged
 * for an installation token that expires within an hour. Tokens are minted per request and
 * never stored (PRD §12.2). Clone tokens are narrowed to one repository and contents:read.
 */

import { importRsaPrivateKey, signRs256Jwt, verifyJwt, type Jwk, type JwtClaims } from './crypto.ts';
import { HttpError } from './http.ts';

const API = 'https://api.github.com';
const UA = 'git2app';

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
  language: string | null;
  private: boolean;
  html_url: string;
}

export class GithubApp {
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(appId: string, privateKeyPem: string, fetchFn: typeof fetch, now: () => number) {
    this.appId = appId;
    this.privateKeyPem = privateKeyPem;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  private async appJwt(): Promise<string> {
    this.keyPromise ??= importRsaPrivateKey(this.privateKeyPem);
    const iat = Math.floor(this.now() / 1000) - 60; // clock-skew allowance, per GitHub docs
    return signRs256Jwt(await this.keyPromise, { iat, exp: iat + 540, iss: this.appId });
  }

  private async gh<T>(path: string, init: RequestInit & { token: string; tokenType?: 'Bearer' | 'token' }): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': UA,
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (res.status === 404) throw new HttpError(404, 'not_found', 'GitHub resource not found or not accessible to the app');
    if (!res.ok) throw new HttpError(502, 'github_error', `GitHub request failed (${res.status})`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Short-lived installation token; optionally narrowed to repos and permissions. */
  async installationToken(
    installationId: number | string,
    narrow?: { repositoryIds?: number[]; permissions?: Record<string, 'read' | 'write'> },
  ): Promise<string> {
    const body =
      narrow && (narrow.repositoryIds || narrow.permissions)
        ? JSON.stringify({
            ...(narrow.repositoryIds ? { repository_ids: narrow.repositoryIds } : {}),
            ...(narrow.permissions ? { permissions: narrow.permissions } : {}),
          })
        : undefined;
    const r = await this.gh<{ token: string }>(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: await this.appJwt(),
      ...(body ? { body } : {}),
    });
    return r.token;
  }

  async getInstallation(installationId: number | string): Promise<{ id: number; account: { login: string; type: string } }> {
    return this.gh(`/app/installations/${installationId}`, { method: 'GET', token: await this.appJwt() });
  }

  async listRepos(installationId: number | string): Promise<GithubRepo[]> {
    const token = await this.installationToken(installationId);
    const out: GithubRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.gh<{ repositories: GithubRepo[] }>(`/installation/repositories?per_page=100&page=${page}`, { method: 'GET', token });
      out.push(...r.repositories);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async getRepo(installationId: number | string, repositoryId: number): Promise<GithubRepo> {
    const token = await this.installationToken(installationId, { repositoryIds: [repositoryId], permissions: { metadata: 'read' } });
    return this.gh(`/repositories/${repositoryId}`, { method: 'GET', token });
  }

  async listBranches(installationId: number | string, repositoryId: number): Promise<Array<{ name: string; commit: { sha: string } }>> {
    const token = await this.installationToken(installationId, { repositoryIds: [repositoryId], permissions: { contents: 'read' } });
    return this.gh(`/repositories/${repositoryId}/branches?per_page=100`, { method: 'GET', token });
  }

  async branchHead(installationId: number | string, repositoryId: number, branch: string): Promise<string> {
    const token = await this.installationToken(installationId, { repositoryIds: [repositoryId], permissions: { contents: 'read' } });
    const r = await this.gh<{ sha: string }>(`/repositories/${repositoryId}/commits/${encodeURIComponent(branch)}`, { method: 'GET', token });
    return r.sha;
  }

  /** Read-only, single-repo clone token handed to a build worker for one job. */
  cloneToken(installationId: number | string, repositoryId: number): Promise<string> {
    return this.installationToken(installationId, { repositoryIds: [repositoryId], permissions: { contents: 'read' } });
  }

  /** Start a job workflow in the workers repo. Inputs carry only non-secret ids. */
  async dispatchWorkflow(workersInstallationId: string, workersRepo: string, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void> {
    const token = await this.installationToken(workersInstallationId, { permissions: { actions: 'write' } });
    await this.gh(`/repos/${workersRepo}/actions/workflows/${workflowFile}/dispatches`, {
      method: 'POST',
      token,
      body: JSON.stringify({ ref, inputs }),
    });
  }

  async cancelRun(workersInstallationId: string, workersRepo: string, runId: string): Promise<void> {
    const token = await this.installationToken(workersInstallationId, { permissions: { actions: 'write' } });
    await this.gh(`/repos/${workersRepo}/actions/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', token });
  }

  /** OAuth code -> user token, used once during installation to prove who installed. */
  async exchangeUserCode(clientId: string, clientSecret: string, code: string): Promise<string> {
    const res = await this.fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const r = (await res.json()) as { access_token?: string };
    if (!r.access_token) throw new HttpError(400, 'github_oauth', 'GitHub sign-in could not be confirmed. Try connecting again.');
    return r.access_token;
  }

  async userInstallationIds(userToken: string): Promise<number[]> {
    const r = await this.gh<{ installations: Array<{ id: number }> }>('/user/installations?per_page=100', { method: 'GET', token: userToken });
    return r.installations.map((i) => i.id);
  }
}

// ------------------------------------------------------------------ GitHub Actions OIDC

export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

export interface ActionsClaims extends JwtClaims {
  repository: string;
  ref: string;
  run_id: string;
  workflow_ref: string;
  event_name: string;
  environment?: string;
}

let jwksCache: { at: number; keys: Jwk[] } | null = null;

export async function actionsJwks(fetchFn: typeof fetch, now: number): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetchFn(`${ACTIONS_ISSUER}/.well-known/jwks`);
  if (!res.ok) throw new HttpError(502, 'oidc', 'Could not load GitHub Actions signing keys');
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  jwksCache = { at: now, keys };
  return keys;
}

/**
 * A build worker proves it is a job workflow of the workers repo, on the expected ref, started
 * by workflow_dispatch. Anything else (a fork, another repo, a pull_request run) is refused.
 */
export async function verifyActionsToken(
  token: string,
  opts: { audience: string; workersRepo: string; workersRef: string; jwks: Jwk[]; now: number },
): Promise<ActionsClaims | null> {
  const c = (await verifyJwt(token, opts.jwks, { audience: opts.audience, issuer: ACTIONS_ISSUER, now: opts.now })) as ActionsClaims | null;
  if (!c) return null;
  if (c.repository !== opts.workersRepo) return null;
  if (c.ref !== `refs/heads/${opts.workersRef}`) return null;
  if (c.event_name !== 'workflow_dispatch') return null;
  if (!/^\.github\/workflows\/g2a-(job|ios)\.yml@/.test(String(c.workflow_ref).replace(`${opts.workersRepo}/`, ''))) return null;
  return c;
}

export function _resetJwksCacheForTests(): void {
  jwksCache = null;
}
