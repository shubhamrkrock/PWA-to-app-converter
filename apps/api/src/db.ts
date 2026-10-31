/**
 * Minimal PostgREST client. Two modes:
 * - asUser(jwt): requests carry the user's own token, so Postgres RLS decides what they see.
 *   Used for every read a user makes — tenant isolation never depends on our query filters.
 * - service(): the service role, used only where the API must write on the user's behalf after
 *   it has itself verified ownership (builds, analyses, artifacts, credentials, webhooks).
 */

import { HttpError } from './http.ts';

type Query = Record<string, string>;

export class Db {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly bearer: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, apiKey: string, bearer: string, fetchFn: typeof fetch) {
    this.url = url.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.bearer = bearer;
    this.fetchFn = fetchFn;
  }

  private async call<T>(method: string, table: string, query: Query, body?: unknown, prefer?: string): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const res = await this.fetchFn(`${this.url}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        apikey: this.apiKey,
        authorization: `Bearer ${this.bearer}`,
        'content-type': 'application/json',
        ...(prefer ? { prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 409) throw new HttpError(409, 'conflict', 'Already exists');
    if (!res.ok) {
      // Never forward database error text to the client; it can describe schema internals.
      throw new HttpError(502, 'db_error', `Database request failed (${res.status})`);
    }
    if (res.status === 204) return [] as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : []) as T;
  }

  select<T>(table: string, query: Query): Promise<T[]> {
    return this.call<T[]>('GET', table, query);
  }

  async one<T>(table: string, query: Query): Promise<T | null> {
    const rows = await this.select<T>(table, { ...query, limit: '1' });
    return rows[0] ?? null;
  }

  insert<T>(table: string, row: unknown, opts: { ignoreDuplicates?: boolean } = {}): Promise<T[]> {
    const prefer = ['return=representation', opts.ignoreDuplicates ? 'resolution=ignore-duplicates' : ''].filter(Boolean).join(',');
    return this.call<T[]>('POST', table, {}, row, prefer);
  }

  update<T>(table: string, query: Query, patch: unknown): Promise<T[]> {
    return this.call<T[]>('PATCH', table, query, patch, 'return=representation');
  }

  delete(table: string, query: Query): Promise<unknown> {
    if (Object.keys(query).length === 0) throw new Error('Refusing unfiltered delete');
    return this.call('DELETE', table, query);
  }
}

/** PostgREST filter value helpers (values are URL-encoded by URLSearchParams). */
export const eq = (v: string | number | boolean) => `eq.${v}`;
export const inList = (vs: Array<string | number>) => `in.(${vs.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
