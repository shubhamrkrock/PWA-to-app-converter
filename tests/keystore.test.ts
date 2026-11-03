import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAndroidKey } from '../packages/shared/src/index.ts';
import { signAndroid } from '../packages/runner/src/android.ts';
import { Logger } from '../packages/runner/src/log.ts';

// Owner, 3 Nov 2026: sign-in must come back into the app by a verified app link, which needs one
// fixed key for every build and its fingerprint. The browser makes it; Java's own tools must open
// it exactly as they open a keystore from keytool, with the same steps the signing job runs.
test('a key made in the browser opens in keytool and signs like an uploaded one', async () => {
  const k = await makeAndroidKey('Xpenstack');
  assert.match(k.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(k.keyAlias, 'upload');
  assert.match(k.storePassword, /^[0-9a-f]{48}$/);
  const dir = mkdtempSync(join(tmpdir(), 'g2a-ks-'));
  const ks = join(dir, 'upload.jks');
  writeFileSync(ks, Buffer.from(k.keystoreB64, 'base64'));
  const env = { ...process.env, G2A_KS_PASS: k.storePassword, G2A_KEY_PASS: k.keyPassword };
  const list = execFileSync('keytool', ['-list', '-v', '-keystore', ks, '-storepass:env', 'G2A_KS_PASS'], { env, encoding: 'utf8' });
  assert.match(list, /Alias name: upload/);
  assert.match(list, /Entry type: PrivateKeyEntry/);
  assert.ok(list.includes(`SHA256: ${k.fingerprint}`), 'the fingerprint shown is the certificate keytool sees');
  assert.match(list, /3072-bit RSA key/);
  assert.match(list, /until: .* 20[5-9]\d/, 'valid well past 2033, as Google Play asks');
  // The signing job's own AAB step (packages/runner/src/android.ts), on a small signed-jar stand-in for the bundle.
  writeFileSync(join(dir, 'a.txt'), 'hello');
  execFileSync('jar', ['cf', join(dir, 'app.aab'), '-C', dir, 'a.txt']);
  const log = new Logger(async () => {}, { echo: false });
  const out = await signAndroid({ apk: null, aab: join(dir, 'app.aab') }, k, join(dir, 'sign'), log);
  assert.match(execFileSync('jarsigner', ['-verify', '-certs', out.aab!], { encoding: 'utf8' }), /jar verified/);
});

test('every key is new: two keys never share a fingerprint or a password', async () => {
  const [a, b] = await Promise.all([makeAndroidKey('A'), makeAndroidKey('B')]);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(a.storePassword, b.storePassword);
});
