/**
 * Where a run reports to. ApiReporter talks to the Git2App API from a GitHub Actions worker;
 * LocalReporter writes to a folder so the same pipeline runs on a laptop or in the e2e workflow
 * with no API at all.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AppConfiguration, BuildStatus, AnalysisReport } from '@git2app/shared';

export interface RepoSpec {
  fullName: string;
  cloneUrl: string;
  commitSha: string;
  projectRoot: string;
  cloneToken: string | null;
}

export interface BuildSpec {
  kind: 'build';
  jobId: string;
  platform: 'android' | 'ios';
  strategy: 'capacitor' | 'twa';
  variant: 'debug' | 'release';
  repo: RepoSpec;
  build: { outputDir: string | null; hostedOrigin: string | null };
  config: AppConfiguration;
  needsSigning: boolean;
}

export interface AnalysisSpec {
  kind: 'analysis';
  jobId: string;
  repo: RepoSpec;
  hostedOrigin: string | null;
}

export type ArtifactType = 'apk' | 'aab' | 'ipa' | 'android-project' | 'ios-project' | 'ios-simulator-app' | 'report';

export interface Reporter {
  status(s: BuildStatus, message?: string): Promise<void>;
  log(chunk: string): Promise<void>;
  upload(type: ArtifactType, file: string, validated: boolean): Promise<void>;
  analysis(report: AnalysisReport): Promise<void>;
  analysisStatus(s: 'COMPLETED' | 'FAILED', message?: string): Promise<void>;
}

export function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ------------------------------------------------------------------ GitHub OIDC

/** Ask the Actions runtime for an OIDC token for our API (needs `id-token: write`). */
export async function actionsOidcToken(audience: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !tok) throw new Error('No GitHub OIDC available: the workflow needs permissions: id-token: write');
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`OIDC token request failed (${res.status})`);
  return ((await res.json()) as { value: string }).value;
}

// ------------------------------------------------------------------ API reporter

export class ApiReporter implements Reporter {
  private seq = 0;
  private readonly base: string;
  private ticket: string;

  constructor(apiOrigin: string, kind: 'build' | 'analysis', jobId: string, ticket: string) {
    if (!/^https:\/\//.test(apiOrigin)) throw new Error('API origin must be https');
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('job id must be a UUID');
    this.base = `${apiOrigin.replace(/\/$/, '')}/api/v1/internal/jobs/${kind}/${jobId}`;
    this.ticket = ticket;
  }

  static async claim(apiOrigin: string, kind: 'build' | 'analysis', jobId: string): Promise<ApiReporter> {
    const oidc = await actionsOidcToken(apiOrigin);
    const res = await fetch(`${apiOrigin.replace(/\/$/, '')}/api/v1/internal/jobs/${kind}/${jobId}/claim`, { method: 'POST', headers: { authorization: `Bearer ${oidc}` } });
    if (!res.ok) throw new Error(`Claim refused (${res.status}): ${await res.text()}`);
    const { ticket } = (await res.json()) as { ticket: string };
    return new ApiReporter(apiOrigin, kind, jobId, ticket);
  }

  /** The signing job: identity is the OIDC token of the g2a-signing environment. */
  static async forSigning(apiOrigin: string, jobId: string): Promise<{ reporter: ApiReporter; signing: Record<string, string> }> {
    const oidc = await actionsOidcToken(apiOrigin);
    const res = await fetch(`${apiOrigin.replace(/\/$/, '')}/api/v1/internal/jobs/build/${jobId}/signing`, { method: 'POST', headers: { authorization: `Bearer ${oidc}` } });
    if (!res.ok) throw new Error(`Signing material refused (${res.status}): ${await res.text()}`);
    const { ticket, signing } = (await res.json()) as { ticket: string; signing: Record<string, string> };
    return { reporter: new ApiReporter(apiOrigin, 'build', jobId, ticket), signing };
  }

  get ticketValue(): string {
    return this.ticket;
  }

  private async req(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.ticket}`, ...headers }, ...(body !== undefined ? { body } : {}) });
        if (res.status >= 500) throw new Error(`API ${res.status}`);
        if (res.status === 410) throw Object.assign(new Error('Build was cancelled'), { cancelled: true });
        if (!res.ok) throw Object.assign(new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
        return res;
      } catch (e: any) {
        if (e?.fatal || e?.cancelled) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw last;
  }

  async spec<T>(): Promise<T> {
    return (await (await this.req('GET', '/spec')).json()) as T;
  }

  async status(s: BuildStatus, message?: string): Promise<void> {
    await this.req('POST', '/status', JSON.stringify({ status: s, ...(message ? { message } : {}) }), { 'content-type': 'application/json' });
  }

  async log(chunk: string): Promise<void> {
    await this.req('POST', '/logs', chunk, { 'x-seq': String(this.seq++), 'content-type': 'text/plain' });
  }

  async upload(type: ArtifactType, file: string, validated: boolean): Promise<void> {
    const buf = await readFile(file);
    if (buf.length > 95 * 1024 * 1024) throw new Error(`${basename(file)} is over 95 MB, the upload limit`);
    await this.req('PUT', `/artifacts/${type}?name=${encodeURIComponent(basename(file))}`, new Uint8Array(buf), {
      'x-sha256': sha256File(buf),
      'x-validated': String(validated),
      'content-type': 'application/octet-stream',
    });
  }

  async analysis(report: AnalysisReport): Promise<void> {
    await this.req('POST', '/analysis', JSON.stringify(report), { 'content-type': 'application/json' });
  }

  async analysisStatus(s: 'COMPLETED' | 'FAILED', message?: string): Promise<void> {
    await this.req('POST', '/status', JSON.stringify({ status: s, ...(message ? { message } : {}) }), { 'content-type': 'application/json' });
  }
}

// ------------------------------------------------------------------ local reporter

export class LocalReporter implements Reporter {
  readonly outDir: string;
  readonly statuses: Array<{ status: string; message?: string }> = [];
  readonly artifacts: Array<{ type: ArtifactType; file: string; validated: boolean; sha256: string }> = [];

  constructor(outDir: string) {
    this.outDir = outDir;
  }

  async status(s: BuildStatus, message?: string): Promise<void> {
    this.statuses.push({ status: s, ...(message ? { message } : {}) });
    await mkdir(this.outDir, { recursive: true });
    await writeFile(join(this.outDir, 'status.json'), JSON.stringify(this.statuses, null, 2));
  }

  async log(chunk: string): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
    await writeFile(join(this.outDir, 'build.log'), chunk, { flag: 'a' });
  }

  async upload(type: ArtifactType, file: string, validated: boolean): Promise<void> {
    await mkdir(join(this.outDir, 'artifacts'), { recursive: true });
    const dest = join(this.outDir, 'artifacts', `${type}-${basename(file)}`);
    await copyFile(file, dest);
    this.artifacts.push({ type, file: dest, validated, sha256: sha256File(await readFile(dest)) });
    await writeFile(join(this.outDir, 'artifacts.json'), JSON.stringify(this.artifacts, null, 2));
  }

  async analysis(report: AnalysisReport): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
    await writeFile(join(this.outDir, 'analysis.json'), JSON.stringify(report, null, 2));
  }

  async analysisStatus(s: 'COMPLETED' | 'FAILED', message?: string): Promise<void> {
    this.statuses.push({ status: s, ...(message ? { message } : {}) });
  }
}
