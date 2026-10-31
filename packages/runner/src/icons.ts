/**
 * Picking the source icon (PRD §8.2). In order: the user's uploaded icon; a square PNG of at
 * least 1024 px from the built or the source web manifest; an SVG icon (manifest or
 * `<link rel="icon" type="image/svg+xml">`), rendered later at 1024 px; else the largest square
 * PNG of at least 512 px. Low-resolution sources are refused rather than stretched.
 *
 * Bundlers often rewrite the manifest (Vite emits it under assets/ with a hash) while the icons
 * it lists are never copied, so the source project's manifest is read as well.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { inside } from './workspace.ts';

/** Width and height from a PNG header, or null if not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** An SVG file has an <svg> root element near the start. */
export function isSvg(buf: Buffer): boolean {
  return /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'));
}

export interface IconChoice {
  file: string;
  /** Pixel size; for an SVG, the size it will be rendered at. */
  size: number;
  maskable: boolean;
  kind: 'png' | 'svg';
}

/** A place to look for icons. `root` is the folder a leading "/" maps to; nothing outside it is read. */
export interface IconSource {
  root: string;
  manifest: { path: string; json: any } | null;
  /** The HTML page whose <link rel="icon"> tags are read, if any. */
  html?: string | null;
}

export const SVG_RENDER_SIZE = 1024;

function resolveIn(root: string, base: string, src: string): string | null {
  if (!src || /^[a-z]+:/i.test(src) || src.startsWith('//')) return null;
  const clean = src.split(/[?#]/)[0]!;
  try {
    if (clean.startsWith('/')) return inside(root, clean.replace(/^\/+/, ''));
    return inside(root, join(relative(root, base), clean.replace(/^\.\//, '')));
  } catch {
    return null;
  }
}

function svgLinks(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/rel=["'][^"']*icon[^"']*["']/i.test(tag) && /type=["']image\/svg\+xml["']/i.test(tag)) {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (href) out.push(href);
    }
  }
  return out;
}

export async function chooseIcon(sources: IconSource[], uploaded: string | null): Promise<IconChoice> {
  const candidates: Array<{ file: string; maskable: boolean; uploaded: boolean }> = [];
  if (uploaded) candidates.push({ file: uploaded, maskable: false, uploaded: true });
  for (const s of sources) {
    const base = s.manifest ? dirname(s.manifest.path) : s.root;
    for (const icon of (s.manifest?.json?.icons ?? []) as Array<{ src?: string; purpose?: string }>) {
      const purposes = (icon.purpose ?? 'any').split(/\s+/);
      // Monochrome icons are single-colour silhouettes, not app icons.
      if (!purposes.includes('any') && !purposes.includes('maskable')) continue;
      const file = resolveIn(s.root, base, icon.src ?? '');
      if (file) candidates.push({ file, maskable: !purposes.includes('any'), uploaded: false });
    }
    for (const href of svgLinks(s.html ?? '')) {
      const file = resolveIn(s.root, s.root, href);
      if (file) candidates.push({ file, maskable: false, uploaded: false });
    }
  }

  let png: IconChoice | null = null;
  let svg: IconChoice | null = null;
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.file)) continue;
    seen.add(c.file);
    const buf = await readFile(c.file).catch(() => null);
    if (!buf) continue;
    const s = pngSize(buf);
    if (s) {
      if (s.width !== s.height) continue;
      // The upload always wins when it is usable.
      if (c.uploaded && s.width >= 512) return { file: c.file, size: s.width, maskable: false, kind: 'png' };
      // Prefer the non-maskable "any" icon at equal size: maskable art has extra padding.
      if (!png || s.width > png.size || (s.width === png.size && png.maskable && !c.maskable)) png = { file: c.file, size: s.width, maskable: c.maskable, kind: 'png' };
    } else if (isSvg(buf)) {
      if (c.uploaded) return { file: c.file, size: SVG_RENDER_SIZE, maskable: false, kind: 'svg' };
      if (!svg || (svg.maskable && !c.maskable)) svg = { file: c.file, size: SVG_RENDER_SIZE, maskable: c.maskable, kind: 'svg' };
    }
  }
  if (png && png.size >= SVG_RENDER_SIZE) return png;
  if (svg) return svg;
  if (!png) throw new Error('No square PNG or SVG icon was found in the web manifest or the page.');
  // Never upscale: below 512 the launcher icons would be blurry. 512 is enough for test builds;
  // the App Store needs 1024, which the pipeline enforces for iOS release builds.
  if (png.size < 512) throw new Error(`The largest icon is ${png.size}×${png.size}, too small for app icons.`);
  return png;
}
