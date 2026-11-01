/**
 * Crypto primitives on WebCrypto only (runs in Workers and Node 22, no dependencies):
 * - base64url helpers
 * - HMAC-SHA256 sign/verify with constant-time compare (webhooks, job tickets, download URLs)
 * - RS256 JWT signing for the GitHub App
 * - JWT verification against a JWKS (Supabase asymmetric keys: ES256 / RS256)
 * - AES-GCM envelope encryption for signing credentials
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

/** Constant-time equality for equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

export function hex(u8: Uint8Array): string {
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** Verify GitHub's X-Hub-Signature-256 header ("sha256=<hex>") over the raw body. */
export async function verifyGithubSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = hex(await hmacSha256(secret, rawBody));
  return timingSafeEqual(enc.encode(expected), enc.encode(header.slice(7)));
}

// ------------------------------------------------------------------ signed tokens (tickets, URLs)

/**
 * A compact signed token: base64url(JSON payload) + "." + base64url(HMAC). Used for build job
 * tickets (scope: one build) and download links (scope: one artifact). Always carries `exp`.
 */
export async function signToken(secret: string, payload: Record<string, unknown> & { exp: number }): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmacSha256(secret, body))}`;
}

export async function verifyToken<T extends { exp: number }>(secret: string, token: string, now = Date.now()): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig || token.split('.').length !== 2) return null;
  const expected = await hmacSha256(secret, body);
  let given: Uint8Array;
  try {
    given = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, given)) return null;
  let payload: T;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  return payload;
}

// ------------------------------------------------------------------ GitHub App JWT (RS256)

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return b64ToBytes(b64);
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// AlgorithmIdentifier for rsaEncryption (OID 1.2.840.113549.1.1.1, NULL parameters).
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** Wraps a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo, which is what WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = 3 + RSA_ALGORITHM.length + octet.length + pkcs1.length; // 3 = INTEGER 0
  const head = [0x30, ...derLength(inner), 0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head, 0);
  out.set(pkcs1, head.length);
  return out;
}

/**
 * GitHub App private keys download as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports only
 * PKCS#8, so a PKCS#1 key is wrapped here. The owner pastes the downloaded file as is, with no
 * conversion step. Line breaks may be lost or changed by pasting; the base64 body is what counts.
 */
export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  if (!pkcs1 && !/BEGIN PRIVATE KEY/.test(pem)) throw new Error('That is not a private key file (.pem). Paste the whole file, including the BEGIN and END lines.');
  try {
    const der = pemToDer(pem);
    return await crypto.subtle.importKey('pkcs8', pkcs1 ? pkcs1ToPkcs8(der) : der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new Error('The private key could not be read. Paste the whole .pem file again, including the BEGIN and END lines.');
  }
}

export async function signRs256Jwt(key: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

// ------------------------------------------------------------------ JWT verification (JWKS)

export interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

export interface JwtClaims {
  sub?: string;
  exp: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  [k: string]: unknown;
}

function algFor(jwk: Jwk, headerAlg: string): { importAlg: EcKeyImportParams | RsaHashedImportParams; verifyAlg: AlgorithmIdentifier | EcdsaParams } | null {
  if (headerAlg === 'ES256' && jwk.kty === 'EC') {
    return { importAlg: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlg: { name: 'ECDSA', hash: 'SHA-256' } };
  }
  if (headerAlg === 'RS256' && jwk.kty === 'RSA') {
    return { importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } };
  }
  return null;
}

/**
 * Verify a JWT against a JWKS. Only asymmetric algorithms are accepted (no "none", no HS256
 * key confusion). Checks signature, exp, nbf, audience and (optionally) issuer.
 */
export async function verifyJwt(
  token: string,
  jwks: Jwk[],
  opts: { audience: string; issuer?: string; now?: number },
): Promise<JwtClaims | null> {
  const now = opts.now ?? Date.now();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(h)));
    claims = JSON.parse(dec.decode(b64urlDecode(p)));
  } catch {
    return null;
  }
  if (!header.alg || !['ES256', 'RS256'].includes(header.alg)) return null;
  const jwk = jwks.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
  if (!jwk) return null;
  const algs = algFor(jwk, header.alg);
  if (!algs) return null;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, algs.importAlg, false, ['verify']);
    ok = await crypto.subtle.verify(algs.verifyAlg, key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + 60_000) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) return null;
  if (opts.issuer && claims.iss !== opts.issuer) return null;
  return claims;
}

export interface SupabaseClaims extends JwtClaims {
  sub: string;
  email?: string;
}

/** Supabase session: audience "authenticated" and a UUID subject. */
export async function verifySupabaseJwt(token: string, jwks: Jwk[], now = Date.now()): Promise<SupabaseClaims | null> {
  const c = await verifyJwt(token, jwks, { audience: 'authenticated', now });
  if (!c || typeof c.sub !== 'string' || !/^[0-9a-f-]{36}$/.test(c.sub)) return null;
  return c as SupabaseClaims;
}

// ------------------------------------------------------------------ envelope encryption

/**
 * Envelope encryption for signing credentials (PRD §12.8, §16.2). A random 256-bit data key
 * encrypts the payload; the data key is wrapped by the master key (Worker secret, base64 of 32
 * bytes). Stored blob = version(1) | wrappedKeyIv(12) | wrappedKey(48) | iv(12) | ciphertext.
 * The master key never touches the database; key_reference names which master key version.
 */
async function importAes(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

export async function sealCredential(masterKeyB64: string, plaintext: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const master = await importAes(b64ToBytes(masterKeyB64), ['encrypt']);
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const kIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: kIv, additionalData: enc.encode(aad) }, master, dataKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dk = await importAes(dataKey, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, dk, plaintext));
  dataKey.fill(0);
  const out = new Uint8Array(1 + 12 + wrapped.length + 12 + ct.length);
  out[0] = 1;
  out.set(kIv, 1);
  out.set(wrapped, 13);
  out.set(iv, 13 + wrapped.length);
  out.set(ct, 25 + wrapped.length);
  return out;
}

export async function openCredential(masterKeyB64: string, blob: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob[0] !== 1) throw new Error('Unknown credential blob version');
  const wrappedLen = 48; // 32-byte key + 16-byte GCM tag
  const kIv = blob.slice(1, 13);
  const wrapped = blob.slice(13, 13 + wrappedLen);
  const iv = blob.slice(13 + wrappedLen, 25 + wrappedLen);
  const ct = blob.slice(25 + wrappedLen);
  const master = await importAes(b64ToBytes(masterKeyB64), ['decrypt']);
  const dataKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kIv, additionalData: enc.encode(aad) }, master, wrapped));
  const dk = await importAes(dataKey, ['decrypt']);
  dataKey.fill(0);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, dk, ct));
}
