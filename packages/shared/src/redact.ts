/**
 * Secret redaction for build logs (PRD §10.3, §16.2). The runner pipes every log line
 * through redactLine before the line is persisted or returned. It redacts (a) any value
 * from a known-secret set, and (b) anything that looks like a token/key/PEM even when the
 * value was not pre-registered, so an accidental echo never leaks.
 */

const TOKEN_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub classic PAT
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth token
  /ghs_[A-Za-z0-9]{20,}/g, // GitHub App installation token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /sk-[A-Za-z0-9]{20,}/g, // generic API secret key
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, // PEM
];

const REDACTED = '[REDACTED]';

/** Escape a string for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact one line. `knownSecrets` are exact values (token strings, passwords) that must
 * never appear; they are matched case-sensitively and in full.
 */
export function redactLine(line: string, knownSecrets: readonly string[] = []): string {
  let out = line;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) {
      out = out.replace(new RegExp(escapeRe(secret), 'g'), REDACTED);
    }
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Redact a whole multi-line blob. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  return text
    .split('\n')
    .map((l) => redactLine(l, knownSecrets))
    .join('\n');
}
