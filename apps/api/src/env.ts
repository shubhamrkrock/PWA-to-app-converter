/** Worker bindings and secrets. Secrets are set with `wrangler secret put`, never committed. */

export interface R2ObjectBodyLike {
  body: ReadableStream;
  size: number;
}

export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(opts: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
}

export interface QueueLike<T> {
  send(msg: T): Promise<void>;
}

export interface DispatchMessage {
  jobId: string; // build id, or "analysis:<analysisJobId>"
  kind: 'analyze' | 'build';
  platform: 'android' | 'ios' | null;
}

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string; // PKCS#8 PEM
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  /** Repo whose Actions run the build jobs, e.g. "shubhamrkrock/PWA-to-app-converter". */
  WORKERS_REPO: string;
  WORKERS_REF: string; // branch the job workflows are dispatched on, e.g. "main"
  WORKERS_INSTALLATION_ID: string; // installation on WORKERS_REPO of the App that has actions:write
  /**
   * A second, private GitHub App installed only on WORKERS_REPO with actions:write, so the
   * public App that users install never asks for Actions access to their repos. When unset,
   * the main App is used (it then needs actions:write, which users would also be asked for).
   */
  WORKERS_APP_ID?: string;
  WORKERS_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  STATE_SECRET: string; // signs OAuth state and download links
  TICKET_SECRET: string; // signs job tickets
  CREDENTIALS_MASTER_KEY: string; // base64 of 32 random bytes
  CREDENTIALS_KEY_REF: string; // e.g. "master-v1"
  API_ORIGIN: string; // https://api.example.com
  WEB_ORIGIN: string; // https://app.example.com (CORS + redirects)
  ARTIFACTS: R2BucketLike;
  DISPATCH_QUEUE: QueueLike<DispatchMessage>;
}

/** Things tests replace: network and clock. */
export interface Deps {
  env: Env;
  fetch: typeof fetch;
  now: () => number;
}
