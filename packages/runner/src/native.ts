/**
 * Native project creation. The native project lives in its own folder beside the user's repo
 * (never inside it), with Git2App's pinned Capacitor packages and a copy of the built web app.
 * The user's package.json and lockfile are untouched, and the result can be zipped and handed
 * over as "the Android/iOS project" (PRD §6.4, §7.6).
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfiguration } from '@git2app/shared';
import { capacitorPlan, patchAndroidManifest, patchAppBuildGradle, patchInfoPlist, patchPbxproj, entitlements, TOOLCHAIN, twaManifest } from '@git2app/generator';
import { handToSandbox, run, takeFromSandbox } from './exec.ts';
import type { Logger } from './log.ts';
import { StageError } from './workspace.ts';

export interface NativeResult {
  dir: string;
  notes: string[];
}

async function editFile(path: string, fn: (s: string) => string): Promise<void> {
  await writeFile(path, fn(await readFile(path, 'utf8')));
}

/** Renders an SVG to a square PNG (argv: in, out, size), centred on transparency with launcher padding. */
const RENDER_SVG = `const sharp = require(require.resolve('sharp', { paths: [process.cwd()] }));
const [input, output, size] = process.argv.slice(2);
const px = Number(size);
// A page's SVG icon is a bare glyph, drawn edge to edge. Launcher masks (circle, squircle) keep
// only the middle of an icon, so the glyph is placed in the central 62% of the canvas.
const inner = Math.round(px * 0.62);
const pad = Math.floor((px - inner) / 2);
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
// Rasterise at the density that gives the target size directly, so the vector is never upscaled.
sharp(input).metadata()
  .then((m) => sharp(input, { density: Math.min(50000, (72 * inner) / Math.max(m.width || inner, m.height || inner)) })
    .resize(inner, inner, { fit: 'contain', background: clear })
    .extend({ top: pad, left: pad, bottom: px - inner - pad, right: px - inner - pad, background: clear })
    .png()
    .toFile(output))
  .then(() => console.log('Rendered ' + input + ' at ' + px + 'x' + px))
  .catch((e) => { console.error(e.message); process.exit(1); });
`;

export async function createCapacitorProject(opts: {
  nativeDir: string;
  webOutDir: string;
  platform: 'android' | 'ios';
  variant: 'debug' | 'release';
  config: AppConfiguration;
  icon: { file: string; size: number; kind?: 'png' | 'svg' };
  logger: Logger;
}): Promise<NativeResult> {
  const { nativeDir, platform, config, logger } = opts;
  const plan = capacitorPlan(config, 'www');
  await mkdir(nativeDir, { recursive: true });
  await cp(opts.webOutDir, join(nativeDir, 'www'), { recursive: true });
  await writeFile(join(nativeDir, 'capacitor.config.json'), JSON.stringify(plan.capacitorConfig, null, 2));
  await writeFile(
    join(nativeDir, 'package.json'),
    JSON.stringify({ name: 'g2a-native', private: true, version: config.version, dependencies: { ...plan.packages, '@capacitor/assets': TOOLCHAIN.npm['@capacitor/assets'] } }, null, 2),
  );
  logger.line(`Native toolchain ${TOOLCHAIN.id}: ${Object.entries(plan.packages).map(([k, v]) => `${k}@${v}`).join(', ')}`);
  for (const n of plan.notes) logger.line(`NOTE: ${n}`);

  // Pinned toolchain packages only; their install scripts are not needed.
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 15 * 60_000 });
  await run('npx', ['--no-install', 'cap', 'add', platform], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 10 * 60_000 });

  // Icons and splash from one source image (PRD §8.2). Generated, never stretched.
  await mkdir(join(nativeDir, 'assets'), { recursive: true });
  if (opts.icon.kind === 'svg') {
    // Vector icon: render it once at 1024 px with the sharp that @capacitor/assets brings.
    await cp(opts.icon.file, join(nativeDir, 'assets', 'source.svg'));
    await writeFile(join(nativeDir, 'render-icon.cjs'), RENDER_SVG);
    await run('node', ['render-icon.cjs', 'assets/source.svg', 'assets/logo.png', String(opts.icon.size)], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 2 * 60_000 });
  } else {
    await cp(opts.icon.file, join(nativeDir, 'assets', 'logo.png'));
  }
  const bg = config.backgroundColor ?? '#FFFFFF';
  await run('npx', ['--no-install', 'capacitor-assets', 'generate', `--${platform}`, '--iconBackgroundColor', bg, '--iconBackgroundColorDark', bg, '--splashBackgroundColor', bg, '--splashBackgroundColorDark', bg], {
    cwd: nativeDir,
    sandbox: true,
    logger,
    timeoutMs: 10 * 60_000,
  });

  // The patches are the runner's own edits: take the folder back (this also stops any leftover
  // sandbox process), patch, then hand it to the sandbox again for `cap sync`.
  await takeFromSandbox(nativeDir);
  if (platform === 'android') {
    await editFile(join(nativeDir, 'android/app/build.gradle'), (s) => patchAppBuildGradle(s, config));
    await editFile(join(nativeDir, 'android/app/src/main/AndroidManifest.xml'), (s) => patchAndroidManifest(s, config));
  } else {
    await editFile(join(nativeDir, 'ios/App/App.xcodeproj/project.pbxproj'), (s) => patchPbxproj(s, config));
    await editFile(join(nativeDir, 'ios/App/App/Info.plist'), (s) => patchInfoPlist(s, config));
    const ent = entitlements(config, opts.variant);
    if (ent) await writeFile(join(nativeDir, 'ios/App/App/App.entitlements'), ent);
  }
  await handToSandbox(nativeDir);
  await run('npx', ['--no-install', 'cap', 'sync', platform], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 10 * 60_000 });
  return { dir: nativeDir, notes: plan.notes };
}

/** Bubblewrap TWA project, generated non-interactively from a twa-manifest.json. */
export async function createTwaProject(opts: {
  nativeDir: string;
  config: AppConfiguration;
  hostedOrigin: string;
  manifest: { json: any } | null;
  logger: Logger;
}): Promise<NativeResult> {
  const { nativeDir, config, hostedOrigin, logger } = opts;
  const m = opts.manifest?.json ?? {};
  const abs = (src: string) => new URL(src, `${hostedOrigin.replace(/\/$/, '')}/`).href;
  const icons = (m.icons ?? []) as Array<{ src: string; sizes?: string; purpose?: string }>;
  const bySize = (i: { sizes?: string }) => Number((i.sizes ?? '0x0').split('x')[0]);
  const any = icons.filter((i) => !(i.purpose ?? '').includes('maskable')).sort((a, b) => bySize(b) - bySize(a))[0];
  const mask = icons.filter((i) => (i.purpose ?? '').includes('maskable')).sort((a, b) => bySize(b) - bySize(a))[0];
  if (!any) throw new StageError('The web manifest has no icon for the Trusted Web Activity', 'Add a 512×512 icon to the manifest, or use the Capacitor strategy.');
  const twa = twaManifest({
    config,
    hostedOrigin,
    startUrl: m.start_url ?? '/',
    webManifestUrl: abs('manifest.webmanifest'),
    iconUrl: abs(any.src),
    maskableIconUrl: mask ? abs(mask.src) : null,
    enableNotifications: config.permissions.includes('notifications'),
  });
  await mkdir(nativeDir, { recursive: true });
  await writeFile(join(nativeDir, 'twa-manifest.json'), JSON.stringify(twa, null, 2));
  await writeFile(join(nativeDir, 'package.json'), JSON.stringify({ name: 'g2a-twa', private: true, dependencies: { '@bubblewrap/cli': TOOLCHAIN.npm['@bubblewrap/cli'] } }, null, 2));
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 15 * 60_000 });
  // Bubblewrap reads the JDK and SDK locations from its config file instead of asking.
  const home = process.env.G2A_SANDBOX_HOME ?? process.env.HOME ?? '/tmp';
  await mkdir(join(home, '.bubblewrap'), { recursive: true }).catch(() => {});
  await writeFile(join(home, '.bubblewrap', 'config.json'), JSON.stringify({ jdkPath: process.env.JAVA_HOME, androidSdkPath: process.env.ANDROID_HOME })).catch(() => {});
  // `update` regenerates the Android project from twa-manifest.json without prompts; it fetches
  // the icons from the live site, so the site must be up.
  await run('npx', ['--no-install', 'bubblewrap', 'update', '--skipVersionUpgrade', '--manifest=./twa-manifest.json'], { cwd: nativeDir, sandbox: true, logger, timeoutMs: 10 * 60_000 });
  return { dir: nativeDir, notes: ['Publish /.well-known/assetlinks.json on your domain (shown in the build report) so Android opens the app full screen without a browser bar.'] };
}
