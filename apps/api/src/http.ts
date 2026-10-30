/** Small HTTP helpers and a path router. No framework dependency. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Sign in required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const tooMany = (msg: string) => new HttpError(429, 'quota_exceeded', msg);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function readJson<T>(req: Request, maxBytes = 256 * 1024): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw badRequest('Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) throw badRequest('Request body too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('Body must be JSON');
  }
}

export type Params = Record<string, string>;
export type Handler<C> = (req: Request, params: Params, ctx: C) => Promise<Response>;

interface Route<C> {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler<C>;
}

export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: string, pattern: string, handler: Handler<C>): this {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler<C>; params: Params } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function uuidParam(v: string | undefined, name = 'id'): string {
  if (!v || !UUID.test(v)) throw badRequest(`${name} must be a UUID`);
  return v;
}
