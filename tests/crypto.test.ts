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

test('GitHub App key: the PKCS#1 file GitHub downloads works as is, and so does PKCS#8', async () => {
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const type of ['pkcs1', 'pkcs8'] as const) {
    const pem = privateKey.export({ type, format: 'pem' }).toString();
    // Pasted into a dashboard box, a key can lose its line breaks or gain Windows ones.
    for (const variant of [pem, pem.replace(/\n/g, '\r\n'), pem.replace(/\n/g, ' ')]) {
      const key = await importRsaPrivateKey(variant);
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode('hello')));
      assert.equal(createVerify('SHA256').update('hello').verify(publicKey, sig), true, `${type} key signs`);
    }
  }
});

test('GitHub App key: a broken key is refused with a plain message', async () => {
  await assert.rejects(() => importRsaPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /private key/i);
  await assert.rejects(() => importRsaPrivateKey('not a key'), /private key/i);
});
