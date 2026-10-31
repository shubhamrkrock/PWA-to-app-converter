/**
 * RepoSource implementations. The analyzer only ever reads through a RepoSource, so it can
 * run against a real checked-out tree (FsRepoSource), an in-memory fixture (MemRepoSource,
 * used by tests), or — later — the GitHub contents API, without the analyzer changing.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, normalize, sep, isAbsolute } from 'node:path';
import type { RepoSource } from '@git2app/shared';

/** Reject paths that try to escape the root (path-traversal guard, PRD §16.1). */
function safeJoin(root: string, p: string): string {
  const full = normalize(join(root, p));
  const rootNorm = normalize(root.endsWith(sep) ? root : root + sep);
  if (full !== normalize(root) && !full.startsWith(rootNorm)) {
    throw new Error(`Path escapes repo root: ${p}`);
  }
  return full;
}

export class FsRepoSource implements RepoSource {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    if (!isAbsolute(root)) throw new Error('FsRepoSource root must be absolute');
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(safeJoin(this.root, path), 'utf8');
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(safeJoin(this.root, path));
      return true;
    } catch {
      return false;
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(safeJoin(this.root, dir));
    } catch {
      return [];
    }
  }
}

/** In-memory source from a flat { path: contents } map. Directories are inferred. */
export class MemRepoSource implements RepoSource {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files).map(([k, v]) => [normalizeKey(k), v]));
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(normalizeKey(path)) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    const key = normalizeKey(path);
    if (this.files.has(key)) return true;
    const prefix = key.endsWith('/') ? key : key + '/';
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir === '' || dir === '.' ? '' : normalizeKey(dir) + '/';
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (prefix === '' || k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) names.add(first);
      }
    }
    return [...names];
  }
}

function normalizeKey(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\/+$/, '');
}
