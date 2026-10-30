/**
 * Framework and render-mode detection. Based on dependency + config analysis, never on
 * filename guesses alone (PRD §4.4). Returns the framework, the evidence that led to it,
 * and the render mode (which decides whether a static package would be honest — PRD §5.3).
 */

import type { Framework, RenderMode, RepoSource } from '@git2app/shared';

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface FrameworkResult {
  framework: Framework;
  evidence: string[];
  renderMode: RenderMode;
}

async function readJson<T>(repo: RepoSource, path: string): Promise<T | null> {
  const raw = await repo.readText(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function allDeps(pkg: Pkg | null): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

async function firstExisting(repo: RepoSource, root: string, names: string[]): Promise<string | null> {
  for (const n of names) if (await repo.exists(join(root, n))) return n;
  return null;
}

function join(root: string, p: string): string {
  return root === '' || root === '.' ? p : `${root.replace(/\/$/, '')}/${p}`;
}

export async function detectFramework(repo: RepoSource, root = ''): Promise<FrameworkResult> {
  const evidence: string[] = [];
  const pkg = await readJson<Pkg>(repo, join(root, 'package.json'));
  const deps = allDeps(pkg);
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);

  // Config files present (used as corroborating evidence, not sole signal).
  const viteCfg = await firstExisting(repo, root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
  const nextCfg = await firstExisting(repo, root, ['next.config.js', 'next.config.mjs', 'next.config.ts']);
  const nuxtCfg = await firstExisting(repo, root, ['nuxt.config.ts', 'nuxt.config.js']);
  const angularCfg = await firstExisting(repo, root, ['angular.json']);
  const svelteCfg = await firstExisting(repo, root, ['svelte.config.js', 'svelte.config.ts']);
  const vueCfg = await firstExisting(repo, root, ['vue.config.js']);

  let framework: Framework = 'unknown';
  let renderMode: RenderMode = 'unknown';

  // Order matters: meta-frameworks (Next/Nuxt/SvelteKit) before their base libs.
  if (has('next') || nextCfg) {
    framework = 'next';
    if (has('next')) evidence.push('dependency: next');
    if (nextCfg) evidence.push(`config: ${nextCfg}`);
    renderMode = await nextRenderMode(repo, root, nextCfg);
  } else if (has('nuxt') || has('nuxt3') || nuxtCfg) {
    framework = 'nuxt';
    if (nuxtCfg) evidence.push(`config: ${nuxtCfg}`);
    if (has('nuxt')) evidence.push('dependency: nuxt');
    renderMode = 'server-rendered'; // default Nuxt is SSR unless ssr:false/static
  } else if (has('@sveltejs/kit') || (svelteCfg && has('@sveltejs/kit'))) {
    framework = 'sveltekit';
    evidence.push('dependency: @sveltejs/kit');
    renderMode = 'server-rendered'; // adapter decides; default needs a server
  } else if (has('@angular/core') || angularCfg) {
    framework = 'angular';
    if (has('@angular/core')) evidence.push('dependency: @angular/core');
    if (angularCfg) evidence.push('config: angular.json');
    renderMode = has('@angular/ssr') || has('@nguniversal/express-engine') ? 'server-rendered' : 'client-rendered';
  } else if (has('svelte') || svelteCfg) {
    framework = 'svelte';
    if (has('svelte')) evidence.push('dependency: svelte');
    renderMode = 'client-rendered';
  } else if (has('vue') || vueCfg) {
    framework = 'vue';
    if (has('vue')) evidence.push('dependency: vue');
    if (vueCfg) evidence.push('config: vue.config.js');
    renderMode = 'client-rendered';
  } else if (has('react') || has('react-dom')) {
    // React on Vite is the common case; distinguish Vite vs vanilla CRA-ish.
    framework = viteCfg ? 'vite' : 'react';
    evidence.push(has('react') ? 'dependency: react' : 'dependency: react-dom');
    if (viteCfg) evidence.push(`config: ${viteCfg}`);
    renderMode = 'client-rendered';
  } else if (viteCfg) {
    framework = 'vite';
    evidence.push(`config: ${viteCfg}`);
    renderMode = 'client-rendered';
  } else if (pkg) {
    framework = 'vanilla';
    evidence.push('package.json present, no known UI framework dependency');
    renderMode = 'client-rendered';
  } else {
    // No package.json at all: treat as a static HTML site if there is an index.html.
    const indexHtml = await firstExisting(repo, root, ['index.html', 'public/index.html', 'src/index.html']);
    if (indexHtml) {
      framework = 'static';
      evidence.push(`static html: ${indexHtml}, no package.json`);
      renderMode = 'static';
    } else {
      evidence.push('no package.json and no index.html found at project root');
    }
  }

  // Vite/React/Vue/Svelte SPAs are effectively static to serve (bundle + assets).
  if (['vite', 'react', 'vue', 'svelte', 'vanilla'].includes(framework) && renderMode === 'client-rendered') {
    // keep client-rendered: it may call a hosted backend, but the bundle itself is static.
  }

  return { framework, evidence, renderMode };
}

/** Next.js: output:'export' ⇒ static-export; otherwise server-rendered (needs a server). */
async function nextRenderMode(repo: RepoSource, root: string, cfg: string | null): Promise<RenderMode> {
  if (!cfg) return 'server-rendered';
  const text = (await repo.readText(join(root, cfg))) ?? '';
  if (/output\s*:\s*['"]export['"]/.test(text)) return 'static-export';
  return 'server-rendered';
}
