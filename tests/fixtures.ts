/**
 * In-memory versions of the PRD §21.1 test repositories. Each is the minimum set of files
 * that makes the case what it claims to be, so the analyzer is tested against real-shaped
 * inputs without network or disk.
 */

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: 'vite build' }, extra: object = {}) =>
  JSON.stringify({ name: 'x', scripts, dependencies: deps, ...extra });

const manifest = (o: object = {}) =>
  JSON.stringify({
    name: 'Demo App',
    short_name: 'Demo',
    start_url: '/',
    display: 'standalone',
    theme_color: '#112233',
    background_color: '#ffffff',
    icons: [
      { src: '/i192.png', sizes: '192x192', type: 'image/png' },
      { src: '/i512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    ...o,
  });

const swReg = `if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');`;

export const FIXTURES: Record<string, Record<string, string>> = {
  // 1. React + Vite PWA
  'react-vite-pwa': {
    'package.json': pkg({ react: '19.0.0', 'react-dom': '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': `export default { plugins: [] }`,
    'public/manifest.json': manifest(),
    'public/sw.js': `self.addEventListener('fetch', () => {})`,
    'src/main.tsx': swReg,
    'index.html': '<div id="root"></div>',
  },
  // 2. React + Vite non-PWA
  'react-vite-nonpwa': {
    'package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': `export default { build: { outDir: 'web-out' } }`,
    'src/main.tsx': 'render()',
    'index.html': '<div id="root"></div>',
  },
  // 3. Vue PWA
  'vue-pwa': {
    'package.json': pkg({ vue: '3.5.0', vite: '6.0.0' }),
    'pnpm-lock.yaml': '',
    'vite.config.ts': `import { VitePWA } from 'vite-plugin-pwa'; export default { plugins: [VitePWA()] }`,
    'public/manifest.webmanifest': manifest(),
    'src/main.ts': 'createApp()',
  },
  // 4. Angular PWA
  'angular-pwa': {
    'package.json': pkg({ '@angular/core': '19.0.0', '@angular/service-worker': '19.0.0' }, { build: 'ng build' }),
    'package-lock.json': '{}',
    'angular.json': JSON.stringify({ projects: { app: { architect: { build: { options: { outputPath: 'dist/app/browser' } } } } } }),
    'src/manifest.json': manifest(),
    'src/main.ts': swReg,
  },
  // 5. Vanilla JS PWA (no framework, no package.json)
  'vanilla-pwa': {
    'index.html': `<link rel="manifest" href="manifest.json"><script>${swReg}</script>`,
    'manifest.json': manifest(),
    'sw.js': 'self.addEventListener("fetch",()=>{})',
  },
  // 6. Next.js static export
  'next-static': {
    'package.json': pkg({ next: '15.0.0', react: '19.0.0' }, { build: 'next build' }),
    'package-lock.json': '{}',
    'next.config.mjs': `export default { output: 'export' }`,
  },
  // 7. Next.js server-dependent
  'next-server': {
    'package.json': pkg({ next: '15.0.0', react: '19.0.0' }, { build: 'next build' }),
    'package-lock.json': '{}',
    'next.config.mjs': `export default { experimental: {} }`,
    'app/api/route.ts': 'export async function GET() {}',
  },
  // 8. PWA with offline functionality
  'offline-pwa': {
    'package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': 'export default {}',
    'public/manifest.json': manifest(),
    'public/service-worker.js': `self.addEventListener('fetch', e => e.respondWith(caches.match(e.request)))`,
    'src/main.tsx': swReg,
  },
  // 9. PWA with camera
  'camera-pwa': {
    'package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': 'export default {}',
    'public/manifest.json': manifest(),
    'public/sw.js': '',
    'src/main.tsx': swReg,
    'src/Scanner.tsx': `navigator.mediaDevices.getUserMedia({ video: true })`,
  },
  // 10. PWA with push notifications
  'push-pwa': {
    'package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': 'export default {}',
    'public/manifest.json': manifest(),
    'public/sw.js': `self.addEventListener('push', e => {})`,
    'src/main.tsx': swReg,
    'src/push.ts': `reg.pushManager.subscribe({ userVisibleOnly: true })`,
  },
  // 11. Missing manifest
  'no-manifest': {
    'package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'package-lock.json': '{}',
    'vite.config.ts': 'export default {}',
    'src/main.tsx': 'render()',
  },
  // 12. Invalid build configuration (no build script, unparseable manifest)
  'invalid-build': {
    'package.json': pkg({ react: '19.0.0' }, {}),
    'public/manifest.json': '{ not json',
  },
  // Extra: monorepo with the app in apps/web
  monorepo: {
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    'pnpm-lock.yaml': '',
    'apps/web/package.json': pkg({ react: '19.0.0', vite: '6.0.0' }),
    'apps/web/vite.config.ts': 'export default {}',
    'apps/web/public/manifest.json': manifest(),
    'apps/web/public/sw.js': '',
    'apps/web/src/main.tsx': swReg,
  },
};
