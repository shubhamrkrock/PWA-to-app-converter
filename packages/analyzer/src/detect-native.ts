/**
 * Native capability detection (PRD §2.2 Use Case C, §8.3). Scans a bounded slice of the
 * source tree for web APIs whose native equivalents need a Capacitor plugin and a
 * permission declaration. It only *suggests* permissions; the user confirms them, and the
 * generator never adds a permission the user did not enable (PRD §7.4, §8.3).
 */

import type { NativePermission, RepoSource } from '@git2app/shared';

export interface NativeSignal {
  feature: NativePermission | 'share' | 'files' | 'deep-links';
  evidence: string; // file where it was seen
}

const RULES: Array<{ feature: NativeSignal['feature']; re: RegExp }> = [
  { feature: 'notifications', re: /PushManager|pushManager\.subscribe|addEventListener\(\s*['"]push['"]|Notification\.requestPermission/ },
  { feature: 'camera', re: /getUserMedia|capture=["'](?:environment|user)["']|ImageCapture/ },
  { feature: 'microphone', re: /getUserMedia\(\s*\{[^}]*audio\s*:\s*true/ },
  { feature: 'location', re: /navigator\.geolocation/ },
  { feature: 'biometrics', re: /navigator\.credentials\.(?:create|get)|PublicKeyCredential/ },
  { feature: 'bluetooth', re: /navigator\.bluetooth/ },
  { feature: 'share', re: /navigator\.share\s*\(/ },
  { feature: 'files', re: /showSaveFilePicker|showOpenFilePicker|URL\.createObjectURL\([^)]*\)[\s\S]{0,80}download/ },
];

const SCAN_DIRS = ['src', 'public', 'app', 'pages', 'components', 'lib'];
const SCAN_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|html)$/;
const MAX_FILES = 1500; // bounded: analysis must stay cheap and predictable
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage']);

function join(root: string, p: string): string {
  return root === '' || root === '.' ? p : `${root.replace(/\/$/, '')}/${p}`;
}

async function walk(repo: RepoSource, dir: string, out: string[], depth = 0): Promise<void> {
  if (out.length >= MAX_FILES || depth > 8) return;
  for (const name of await repo.list(dir)) {
    if (out.length >= MAX_FILES) return;
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const path = `${dir}/${name}`;
    if (SCAN_EXT.test(name)) out.push(path);
    else if (!name.includes('.')) await walk(repo, path, out, depth + 1); // likely a directory
  }
}

export async function detectNative(repo: RepoSource, root = ''): Promise<NativeSignal[]> {
  const files: string[] = [];
  for (const d of SCAN_DIRS) {
    const full = join(root, d);
    if (await repo.exists(full)) await walk(repo, full, files);
  }
  for (const f of ['index.html']) if (await repo.exists(join(root, f))) files.push(join(root, f));

  const seen = new Map<string, NativeSignal>();
  for (const f of files) {
    const text = await repo.readText(f);
    if (!text) continue;
    for (const { feature, re } of RULES) {
      if (!seen.has(feature) && re.test(text)) seen.set(feature, { feature, evidence: f });
    }
  }
  return [...seen.values()];
}
