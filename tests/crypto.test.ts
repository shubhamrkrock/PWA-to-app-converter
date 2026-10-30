import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealCredential, openCredential, signToken, verifyToken, verifyGithubSignature, hex, hmacSha256, importRsaPrivateKey } from '../apps/api/src/crypto.ts';

const master = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const enc = new TextEncoder();

test('envelope encryption: round trip, and the blob is bound to its owner and id', async () => {
  const blob = await sealCredential(master, enc.encode('secret'), 'user-a:cred-1');
  assert.equal(new TextDecoder().decode(await openCredential(master, blob, 'user-a:cred-1')), 'secret');
  await assert.rejects(() => openCredential(master, blob, 'user-b:cred-1')); // moved to another user
  const otherMaster = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await assert.rejects(() => openCredential(otherMaster, blob, 'user-a:cred-1'));
  const tampered = blob.slice();
  tampered[tampered.length - 1]! ^= 1;
  await assert.rejects(() => openCredential(master, tampered, 'user-a:cred-1'));
});

test('envelope encryption: the same plaintext seals differently each time', async () => {
  const a = await sealCredential(master, enc.encode('x'), 'aad');
  const b = await sealCredential(master, enc.encode('x'), 'aad');
  assert.notDeepEqual(a, b);
});

test('signed tokens: tamper and expiry are rejected', async () => {
  const t = await signToken('k', { a: 1, exp: Math.floor(Date.now() / 1000) + 60 });
  assert.deepEqual((await verifyToken<{ a: number; exp: number }>('k', t))?.a, 1);
  assert.equal(await verifyToken('other', t), null);
  const [body, sig] = t.split('.');
  const forgedBody = btoa(JSON.stringify({ a: 2, exp: 9e9 })).replace(/=+$/, '');
  assert.equal(await verifyToken('k', `${forgedBody}.${sig}`), null);
  assert.equal(await verifyToken('k', `${body}.${sig}.extra`), null);
  const old = await signToken('k', { exp: 1 });
  assert.equal(await verifyToken('k', old), null);
});

test('github webhook signature: exact HMAC accepted, anything else refused', async () => {
  const body = '{"a":1}';
  const good = `sha256=${hex(await hmacSha256('s', body))}`;
  assert.equal(await verifyGithubSignature('s', body, good), true);
  assert.equal(await verifyGithubSignature('s', body + ' ', good), false);
  assert.equal(await verifyGithubSignature('s', body, null), false);
  assert.equal(await verifyGithubSignature('s', body, good.replace('sha256=', 'sha1=')), false);
});

test('GitHub App key: PKCS#1 keys get a clear conversion message', async () => {
  await assert.rejects(() => importRsaPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /openssl pkcs8/);
});
