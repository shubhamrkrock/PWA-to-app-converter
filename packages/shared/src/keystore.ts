/**
 * Makes an Android signing key in the browser, with Web Crypto only (no package): an RSA 3072
 * key, a self-signed certificate valid for 30 years (Google Play asks for past 2033), and the
 * PKCS#12 keystore that keytool, jarsigner and apksigner open (PBES2 with AES-256 for the key,
 * an HMAC-SHA256 integrity check). The person's own browser makes it and it goes straight into
 * the signing vault, exactly as an uploaded keystore does, so a fixed key signs every build of
 * the app and its SHA-256 fingerprint can be published in /.well-known/assetlinks.json (verified
 * app links). Nothing here is sent anywhere.
 */

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------- DER, just what a keystore needs
type Bytes = Uint8Array<ArrayBuffer>;
const cat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const len = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n);
  const b: number[] = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Uint8Array.of(0x80 | b.length, ...b);
};
const tlv = (tag: number, body: Uint8Array): Bytes => cat(Uint8Array.of(tag), len(body.length), body);
const seq = (...items: Uint8Array[]) => tlv(0x30, cat(...items));
const set = (...items: Uint8Array[]) => tlv(0x31, cat(...items));
const octet = (b: Uint8Array) => tlv(0x04, b);
const ctx0 = (b: Uint8Array) => tlv(0xa0, b); // [0] EXPLICIT, constructed
const NULL = Uint8Array.of(0x05, 0x00);
const intBytes = (b: Uint8Array) => tlv(0x02, b[0]! & 0x80 ? cat(Uint8Array.of(0), b) : b);
const int = (n: number) => {
  const b: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x & 0xff);
  return intBytes(Uint8Array.from(b.length ? b : [0]));
};
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let x = n >> 7; x > 0; x >>= 7) chunk.unshift(0x80 | (x & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
};
const utf8 = (s: string) => tlv(0x0c, enc.encode(s));
const bmp = (s: string) => tlv(0x1e, Uint8Array.from([...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])));
const time = (d: Date) => {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, enc.encode(iso.slice(2))) : tlv(0x18, enc.encode(iso));
};

const OID = {
  rsaSha256: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  data: '1.2.840.113549.1.7.1',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacSha256: '1.2.840.113549.2.9',
  aes256cbc: '2.16.840.1.101.3.4.1.42',
  sha256: '2.16.840.1.101.3.4.2.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
};
const ITERATIONS = 10000;

// ---------------------------------------------------------------- the PKCS#12 integrity key (RFC 7292, Appendix B.2)
async function pkcs12Kdf(password: string, salt: Uint8Array, id: number, iterations: number, n: number): Promise<Bytes> {
  const u = 32, v = 64; // SHA-256
  const pass = Uint8Array.from([...password, '\0'].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]));
  const fill = (b: Uint8Array): Bytes => { const out = new Uint8Array(v * Math.ceil(b.length / v)); for (let i = 0; i < out.length; i++) out[i] = b[i % b.length]!; return out; };
  const I = cat(fill(salt), fill(pass));
  const D = new Uint8Array(v).fill(id);
  const out: Uint8Array[] = [];
  for (let got = 0; got < n; got += u) {
    let A = new Uint8Array(await subtle().digest('SHA-256', cat(D, I)));
    for (let r = 1; r < iterations; r++) A = new Uint8Array(await subtle().digest('SHA-256', A));
    out.push(A);
    const B = fill(A);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const x = I[j + k]! + B[k]! + carry; I[j + k] = x & 0xff; carry = x >> 8; }
    }
  }
  return cat(...out).slice(0, n);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

export interface MadeAndroidKey {
  keystoreB64: string; // PKCS#12
  storePassword: string;
  keyAlias: string;
  keyPassword: string; // the same as the store password, as keytool makes PKCS#12
  fingerprint: string; // SHA-256 of the certificate, AA:BB:... as Play and assetlinks.json show it
}

/** The fingerprint as Android shows it: upper-case hex pairs joined by colons. */
export const colonHex = (b: Uint8Array) => hex(b).toUpperCase().match(/../g)!.join(':');

export async function makeAndroidKey(name: string, now = new Date()): Promise<MadeAndroidKey> {
  const keys = await subtle().generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await subtle().exportKey('spki', keys.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', keys.privateKey));

  const who = seq(set(seq(oid(OID.commonName), utf8(String(name).trim().slice(0, 64) || 'Android upload key'))));
  const serial = random(16); serial[0]! &= 0x7f; serial[0]! |= 0x01;
  const until = new Date(now); until.setUTCFullYear(until.getUTCFullYear() + 30);
  const sigAlg = seq(oid(OID.rsaSha256), NULL);
  const tbs = seq(ctx0(int(2)), intBytes(serial), sigAlg, who, seq(time(now), time(until)), who, spki);
  const sig = new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', keys.privateKey, tbs));
  const cert = seq(tbs, sigAlg, tlv(0x03, cat(Uint8Array.of(0), sig)));
  const fingerprint = colonHex(new Uint8Array(await subtle().digest('SHA-256', cert)));

  const password = hex(random(24)); // 48 hex characters, ASCII, so every tool reads it the same way
  const alias = 'upload';

  // The private key, locked with PBES2 (PBKDF2-HMAC-SHA256, AES-256-CBC).
  const salt = random(16), iv = random(16);
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aes = await subtle().deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-CBC', length: 256 }, false, ['encrypt']);
  const locked = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, aes, pkcs8));
  const pbes2 = seq(oid(OID.pbes2), seq(
    seq(oid(OID.pbkdf2), seq(octet(salt), int(ITERATIONS), seq(oid(OID.hmacSha256), NULL))),
    seq(oid(OID.aes256cbc), octet(iv)),
  ));

  const keyId = new Uint8Array(await subtle().digest('SHA-1', cert)).slice(0, 20);
  const attrs = set(seq(oid(OID.friendlyName), set(bmp(alias))), seq(oid(OID.localKeyId), set(octet(keyId))));
  const keyBag = seq(oid(OID.shroudedKeyBag), ctx0(seq(pbes2, octet(locked))), attrs);
  const certBag = seq(oid(OID.certBag), ctx0(seq(oid(OID.x509Certificate), ctx0(octet(cert)))), attrs);
  const data = (b: Uint8Array) => seq(oid(OID.data), ctx0(octet(b)));
  const authSafe = seq(data(seq(keyBag, certBag)));

  const macSalt = random(16);
  const macKey = await subtle().importKey('raw', await pkcs12Kdf(password, macSalt, 3, ITERATIONS, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle().sign('HMAC', macKey, authSafe));
  const pfx = seq(int(3), data(authSafe), seq(seq(seq(oid(OID.sha256), NULL), octet(mac)), octet(macSalt), int(ITERATIONS)));

  return { keystoreB64: b64(pfx), storePassword: password, keyAlias: alias, keyPassword: password, fingerprint };
}
