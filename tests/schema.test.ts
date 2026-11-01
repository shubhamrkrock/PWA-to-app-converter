// Database rules checked as text across all migrations, in order (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'supabase/migrations';
const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');

test('a signed-in user can read their profile but not change their own plan', () => {
  const created = [...sql.matchAll(/create policy (\w+) on public\.profiles\s+for (\w+)/g)].map((m) => [m[1], m[2]]);
  const dropped = new Set([...sql.matchAll(/drop policy (?:if exists )?(\w+) on public\.profiles/g)].map((m) => m[1]));
  const live = created.filter(([name]) => !dropped.has(name));
  assert.ok(live.length > 0, 'profiles needs a read policy');
  for (const [name, cmd] of live) assert.equal(cmd, 'select', `policy ${name} lets users write profiles (plan)`);
});

test('the sign-up trigger function cannot be called through the public API', () => {
  assert.match(sql, /revoke execute on function public\.handle_new_user\(\) from public, anon, authenticated/);
});
