/**
 * PWA detection (PRD §4.4). Looks for a web app manifest in the usual places, validates its
 * required fields, and checks for a registered service worker. Honest about what it cannot
 * know statically (e.g. production HTTPS hosting) rather than guessing.
 */

import type { ManifestCheck, PwaReport, RepoSource } from '@git2app/shared';

function join(root: string, p: string): string {
  return root === '' || root === '.' ? p : `${root.replace(/\/$/, '')}/${p}`;
}

const MANIFEST_CANDIDATES = [
  'public/manifest.json',
  'public/manifest.webmanifest',
  'manifest.json',
  'manifest.webmanifest',
  'src/manifest.json',
  'static/manifest.json', // sveltekit/nuxt
];

interface RawManifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
}

async function findManifest(repo: RepoSource, root: string): Promise<{ path: string; raw: RawManifest } | null> {
  for (const cand of MANIFEST_CANDIDATES) {
    const full = join(root, cand);
    const text = await repo.readText(full);
    if (text !== null) {
      try {
        return { path: cand, raw: JSON.parse(text) as RawManifest };
      } catch {
        // present but unparseable — report as present-but-broken
        return { path: cand, raw: {} };
      }
    }
  }
  return null;
}

function checkManifest(found: { path: string; raw: RawManifest } | null): ManifestCheck {
  if (!found) {
    return {
      present: false,
      accessiblePath: null,
      hasName: false,
      hasShortName: false,
      iconCount: 0,
      hasMaskableIcon: false,
      startUrl: null,
      display: null,
      themeColor: null,
      backgroundColor: null,
    };
  }
  const m = found.raw;
  const icons = Array.isArray(m.icons) ? m.icons : [];
  return {
    present: true,
    accessiblePath: found.path,
    hasName: typeof m.name === 'string' && m.name.length > 0,
    hasShortName: typeof m.short_name === 'string' && m.short_name.length > 0,
    iconCount: icons.length,
    hasMaskableIcon: icons.some((i) => (i.purpose ?? '').split(/\s+/).includes('maskable')),
    startUrl: typeof m.start_url === 'string' ? m.start_url : null,
    display: typeof m.display === 'string' ? m.display : null,
    themeColor: typeof m.theme_color === 'string' ? m.theme_color : null,
    backgroundColor: typeof m.background_color === 'string' ? m.background_color : null,
  };
}

const SW_CANDIDATES = [
  'public/sw.js',
  'public/service-worker.js',
  'public/serviceworker.js',
  'src/sw.js',
  'src/service-worker.ts',
  'src/service-worker.js',
  'sw.js',
  'service-worker.js',
  'static/sw.js',
];

async function findServiceWorker(repo: RepoSource, root: string): Promise<string | null> {
  for (const cand of SW_CANDIDATES) {
    if (await repo.exists(join(root, cand))) return cand;
  }
  // Also accept a vite-plugin-pwa / workbox config as evidence of a generated SW.
  for (const cfg of ['vite.config.ts', 'vite.config.js']) {
    const text = await repo.readText(join(root, cfg));
    if (text && /vite-plugin-pwa|VitePWA|workbox/.test(text)) return `${cfg} (generated via plugin)`;
  }
  return null;
}

/** Scan HTML/entry files for a serviceWorker.register call. */
async function serviceWorkerRegistered(repo: RepoSource, root: string): Promise<boolean> {
  const entries = ['index.html', 'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx', 'src/index.ts'];
  for (const e of entries) {
    const text = await repo.readText(join(root, e));
    if (text && /serviceWorker\s*\.\s*register\s*\(/.test(text)) return true;
  }
  return false;
}

export async function detectPwa(repo: RepoSource, root = ''): Promise<PwaReport> {
  const found = await findManifest(repo, root);
  const manifest = checkManifest(found);
  const swFile = await findServiceWorker(repo, root);
  const swRegistered = (await serviceWorkerRegistered(repo, root)) || swFile !== null;

  const isInstallablePwa = manifest.present && manifest.hasName && manifest.iconCount > 0 && swRegistered;

  return {
    manifest,
    serviceWorker: { registered: swRegistered, file: swFile },
    httpsHostingKnown: false, // cannot be confirmed from source alone
    offlineLikely: swFile !== null,
    isInstallablePwa,
  };
}
