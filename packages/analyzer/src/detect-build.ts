/**
 * Build detection (PRD §4.4): package manager, Node version, build command, the real
 * output directory and referenced environment variables. The output directory is read from
 * the framework config and the build script; "dist" is only a fallback for Vite when
 * nothing overrides it (PRD §5.2: "Do not assume every application uses dist").
 */

import type { BuildDetection, Framework, PackageManager, RepoSource } from '@git2app/shared';

function join(root: string, p: string): string {
  return root === '' || root === '.' ? p : `${root.replace(/\/$/, '')}/${p}`;
}

interface Pkg {
  scripts?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  volta?: { node?: string };
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

async function detectPackageManager(repo: RepoSource, root: string, pkg: Pkg | null) {
  // Explicit corepack field wins.
  const pmField = pkg?.packageManager?.split('@')[0];
  if (pmField === 'pnpm' || pmField === 'yarn' || pmField === 'npm' || pmField === 'bun') {
    const lock = LOCKFILES.find(([, pm]) => pm === pmField)?.[0] ?? null;
    return { packageManager: pmField as PackageManager, lockfile: lock && (await repo.exists(join(root, lock))) ? lock : null };
  }
  // Monorepo: lockfile may live at repo root rather than project root.
  for (const base of root ? [root, ''] : ['']) {
    for (const [file, pm] of LOCKFILES) {
      if (await repo.exists(join(base, file))) return { packageManager: pm, lockfile: base ? `${base}/${file}` : file };
    }
  }
  return { packageManager: (pkg ? 'npm' : 'unknown') as PackageManager, lockfile: null };
}

async function detectNodeVersion(repo: RepoSource, root: string, pkg: Pkg | null): Promise<string | null> {
  for (const f of ['.nvmrc', '.node-version']) {
    const t = await repo.readText(join(root, f));
    if (t && t.trim()) return t.trim();
  }
  return pkg?.volta?.node ?? pkg?.engines?.node ?? null;
}

/** Pull `--outDir x` out of a build script, if present. */
function outDirFromScript(script: string | undefined): string | null {
  if (!script) return null;
  const m = /--out-?dir[ =]+["']?([^\s"']+)/i.exec(script);
  return m?.[1] ?? null;
}

async function outDirFromConfig(repo: RepoSource, root: string, framework: Framework): Promise<string | null> {
  if (framework === 'vite' || framework === 'react' || framework === 'vue' || framework === 'svelte') {
    for (const cfg of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const t = await repo.readText(join(root, cfg));
      if (t) {
        const m = /outDir\s*:\s*['"]([^'"]+)['"]/.exec(t);
        if (m?.[1]) return m[1];
        return 'dist'; // Vite default when a config exists without outDir
      }
    }
  }
  if (framework === 'angular') {
    const t = await repo.readText(join(root, 'angular.json'));
    const m = t && /"outputPath"\s*:\s*"([^"]+)"/.exec(t);
    if (m && m[1]) return m[1];
  }
  if (framework === 'next') return 'out'; // only meaningful for static export
  if (framework === 'nuxt') return '.output/public';
  if (framework === 'sveltekit') return 'build';
  if (framework === 'static') return '.';
  if (framework === 'react') return 'build'; // CRA default
  return null;
}

const ENV_PATTERNS: RegExp[] = [
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
];

/** Find env vars referenced in config files and an .env.example (names only, never values). */
async function detectEnvVars(repo: RepoSource, root: string): Promise<string[]> {
  const names = new Set<string>();
  const files = ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'src/main.tsx', 'src/main.ts', 'src/config.ts', 'src/env.ts'];
  for (const f of files) {
    const t = await repo.readText(join(root, f));
    if (!t) continue;
    for (const re of ENV_PATTERNS) for (const m of t.matchAll(re)) if (m[1]) names.add(m[1]);
  }
  // .env.example documents required vars; we read names only (never .env itself).
  const example = await repo.readText(join(root, '.env.example'));
  if (example) for (const line of example.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  // Ignore names that are always present at build time and are not user secrets.
  for (const builtin of ['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']) names.delete(builtin);
  return [...names].sort();
}

export async function detectBuild(repo: RepoSource, root: string, framework: Framework): Promise<BuildDetection> {
  const raw = await repo.readText(join(root, 'package.json'));
  let pkg: Pkg | null = null;
  try {
    pkg = raw ? (JSON.parse(raw) as Pkg) : null;
  } catch {
    pkg = null;
  }
  const { packageManager, lockfile } = await detectPackageManager(repo, root, pkg);
  const nodeVersion = await detectNodeVersion(repo, root, pkg);

  const buildScript = pkg?.scripts?.build;
  let buildCommand: string | null = null;
  if (buildScript) buildCommand = `${packageManager === 'unknown' ? 'npm' : packageManager} run build`;
  else if (framework === 'static') buildCommand = null; // nothing to build

  const outputDir = outDirFromScript(buildScript) ?? (await outDirFromConfig(repo, root, framework));
  const envVarsReferenced = await detectEnvVars(repo, root);

  return { packageManager, lockfile, nodeVersion, buildCommand, outputDir, envVarsReferenced };
}
