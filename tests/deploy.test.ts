// The API's addresses in apps/api/wrangler.toml, checked as text (no TOML dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync('apps/api/wrangler.toml', 'utf8');
const str = (k: string) => toml.match(new RegExp(`^${k} = "([^"]*)"`, 'm'))?.[1];

test('the API lives on its own xpenstack.com address, served by a Cloudflare custom domain', () => {
  assert.equal(str('API_ORIGIN'), 'https://git2app-api.xpenstack.com');
  assert.equal(str('WEB_ORIGIN'), 'https://git2app.xpenstack.com');
  assert.match(toml, /^routes = \[\{ pattern = "git2app-api\.xpenstack\.com", custom_domain = true \}\]$/m);
});

test('the API answers on one address only (no extra workers.dev copy)', () => {
  assert.match(toml, /^workers_dev = false$/m);
});

test('values the owner adds in the Cloudflare dashboard survive the next deploy from git', () => {
  // The four GitHub ids (GITHUB_APP_ID, GITHUB_CLIENT_ID, WORKERS_APP_ID, WORKERS_INSTALLATION_ID)
  // were added as plain dashboard variables on 1 Nov 2026; without keep_vars a deploy deletes them.
  assert.match(toml, /^keep_vars = true$/m);
});
