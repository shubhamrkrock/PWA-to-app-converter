/** Small, strict text-editing helpers. Every patch fails loudly if its anchor is missing, so a
 * template change upstream breaks the build visibly instead of producing a half-patched app. */

export class PatchError extends Error {}

export function replaceOnce(text: string, find: RegExp | string, replacement: string, what: string): string {
  const re = typeof find === 'string' ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : find;
  if (!re.test(text)) throw new PatchError(`Template changed: could not find ${what}`);
  return text.replace(re, replacement);
}

export function replaceAll(text: string, find: RegExp, replacement: string, what: string): string {
  const g = new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g');
  if (!g.test(text)) throw new PatchError(`Template changed: could not find ${what}`);
  return text.replace(g, replacement);
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
