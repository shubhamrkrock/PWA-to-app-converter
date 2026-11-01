/**
 * The dashboard's only way to the Git2App API. It adds the Supabase session token, and turns
 * API errors into ApiError with the API's plain-words message. No retries on writes.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | null;
  constructor(status: number, code: string, message: string, fields: Record<string, string> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  text(path: string): Promise<string>;
}

export function makeApi(origin: string, token: () => Promise<string | null>, fetchFn: typeof fetch = fetch): ApiClient {
  const base = `${origin.replace(/\/$/, '')}/api/v1`;
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const t = await token();
    const headers: Record<string, string> = {};
    if (t) headers.authorization = `Bearer ${t}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'network', 'Could not reach Git2App. Check your connection and try again.');
    }
    if (!res.ok) {
      let data: { error?: string; message?: string; fields?: Record<string, string> } = {};
      try {
        data = await res.json();
      } catch {}
      const message = data.message ?? (data.error === 'invalid_configuration' ? 'Some settings need fixing.' : `Request failed (${res.status}).`);
      throw new ApiError(res.status, data.error ?? 'error', message, data.fields ?? null);
    }
    return res;
  }
  return {
    get: async (p) => (await call('GET', p)).json(),
    post: async (p, b) => (await call('POST', p, b ?? {})).json(),
    del: async (p) => (await call('DELETE', p)).json(),
    text: async (p) => (await call('GET', p)).text(),
  };
}
