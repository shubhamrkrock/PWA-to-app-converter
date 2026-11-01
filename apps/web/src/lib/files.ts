/** Reading an uploaded signing file into base64 without it ever leaving the browser unencrypted except to the API. */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export async function fileToBase64(file: Blob, maxBytes = 300 * 1024): Promise<string> {
  if (file.size > maxBytes) throw new Error(`That file is ${Math.round(file.size / 1024)} KB; signing files are well under ${Math.round(maxBytes / 1024)} KB. Is it the right file?`);
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Signing file kinds by their first bytes, so a wrong file is caught before upload. */
export function looksLike(kind: 'keystore' | 'p12' | 'mobileprovision', bytes: Uint8Array): boolean {
  if (kind === 'keystore') {
    const jks = bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfe && bytes[3] === 0xed;
    return jks || bytes[0] === 0x30; // JKS or PKCS#12 (DER sequence)
  }
  if (kind === 'p12') return bytes[0] === 0x30;
  // A provisioning profile is a CMS (DER) envelope around a plist.
  return bytes[0] === 0x30 && new TextDecoder('latin1').decode(bytes.subarray(0, 65536)).includes('<plist');
}
