/**
 * Compatibility + strategy engine (PRD §5, §15.4). Pure function of the detection results:
 * it emits findings, derives per-platform strategies independently (PRD §5.4, principle 3),
 * and computes 0–100 scores where every deduction is tied to a finding. Scores are
 * readiness indicators, never a probability of store acceptance.
 */

import type {
  BuildDetection,
  CompatibilityFinding,
  CompatibilityScores,
  Framework,
  PackagingStrategy,
  PwaReport,
  RenderMode,
} from '@git2app/shared';
import type { NativeSignal } from './detect-native.ts';

export interface StrategyInput {
  framework: Framework;
  renderMode: RenderMode;
  pwa: PwaReport;
  build: BuildDetection;
  native: NativeSignal[];
  /** Production HTTPS origin the user says they control (enables TWA). */
  hostedOrigin?: string | null;
}

export interface StrategyResult {
  android: PackagingStrategy;
  ios: PackagingStrategy;
  findings: CompatibilityFinding[];
  scores: CompatibilityScores;
}

/** Native features TWA cannot serve well; any of these pushes Android to Capacitor. */
const TWA_WEAK = new Set(['camera', 'biometrics', 'files', 'bluetooth', 'microphone']);

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function recommend(input: StrategyInput): StrategyResult {
  const f: CompatibilityFinding[] = [];
  const add = (level: CompatibilityFinding['level'], code: string, message: string) => f.push({ level, code, message });

  // ---- Can we package at all? (PRD §5.3: never package a server app as static) ----
  let packageable = true;
  if (input.framework === 'unknown') {
    packageable = false;
    add('blocker', 'NO_WEB_APP', 'No web application was found at the project root. Choose the folder that holds package.json or index.html.');
  }
  if (input.renderMode === 'server-rendered') {
    packageable = false;
    add(
      'blocker',
      'NEEDS_SERVER',
      `This ${input.framework} app renders on a server. Embedding its build output would break server features. ` +
        'Options: enable static export, or keep the hosted backend and package the hosted URL.',
    );
  }
  if (input.renderMode === 'static-export') add('info', 'STATIC_EXPORT', 'Static export is configured, so the build output can be embedded.');

  // ---- Build facts ----
  if (input.framework !== 'static' && !input.build.buildCommand) {
    add('warning', 'NO_BUILD_SCRIPT', 'package.json has no "build" script. Add one, or set the build command manually.');
  }
  if (!input.build.outputDir) add('warning', 'NO_OUTPUT_DIR', 'Could not determine the build output folder. Set it manually.');
  else add('ok', 'OUTPUT_DIR', `Build output folder: ${input.build.outputDir}`);
  if (!input.build.lockfile && input.framework !== 'static') {
    add('warning', 'NO_LOCKFILE', 'No lockfile found, so dependency versions are not pinned and builds may not be reproducible.');
  }
  if (input.build.envVarsReferenced.length) {
    add('info', 'ENV_VARS', `Build reads environment variables: ${input.build.envVarsReferenced.join(', ')}. Provide them as build settings.`);
  }

  // ---- PWA facts ----
  const m = input.pwa.manifest;
  if (!m.present) add('warning', 'NO_MANIFEST', 'No web app manifest found. Name, icons and colours must be entered by hand.');
  else {
    if (!m.hasName) add('warning', 'MANIFEST_NO_NAME', 'Manifest has no "name".');
    if (!m.hasShortName) add('info', 'MANIFEST_NO_SHORT_NAME', 'Manifest has no "short_name"; the home-screen label will use the name.');
    if (m.iconCount === 0) add('warning', 'MANIFEST_NO_ICONS', 'Manifest lists no icons. Upload a 1024×1024 icon in Branding.');
    if (!m.hasMaskableIcon) add('info', 'NO_MASKABLE_ICON', 'No maskable icon; the Android adaptive icon will be padded from the regular icon.');
  }
  if (!input.pwa.serviceWorker.registered) add('info', 'NO_SERVICE_WORKER', 'No service worker found. The app will not work offline unless assets are embedded (Capacitor embeds them).');

  // ---- Strategy per platform ----
  const nativeNames = input.native.map((n) => n.feature);
  const twaBlockers = nativeNames.filter((n) => TWA_WEAK.has(n));
  const twaPossible = packageable && input.pwa.isInstallablePwa && !!input.hostedOrigin && /^https:\/\//.test(input.hostedOrigin);

  let android: PackagingStrategy = 'unsupported';
  let ios: PackagingStrategy = 'unsupported';
  if (packageable) {
    if (twaPossible && twaBlockers.length === 0) {
      android = 'twa';
      add('info', 'ANDROID_TWA', `Android: Trusted Web Activity on ${input.hostedOrigin}. You must publish /.well-known/assetlinks.json on that domain.`);
    } else {
      android = 'capacitor';
      const why = twaBlockers.length
        ? `it uses ${twaBlockers.join(', ')}, which a Trusted Web Activity cannot reach natively`
        : !input.hostedOrigin
          ? 'no hosted HTTPS origin was given'
          : 'the app is not an installable PWA';
      add('info', 'ANDROID_CAPACITOR', `Android: Capacitor, because ${why}.`);
    }
    ios = 'capacitor'; // iOS has no TWA; Capacitor is the only supported strategy
    add('info', 'IOS_CAPACITOR', 'iOS: Capacitor. The build runs on a macOS worker.');
    if (nativeNames.length === 0) {
      add(
        'warning',
        'APPLE_MIN_FUNCTIONALITY',
        'No native features detected. Apple may reject an app that only wraps a website (guideline 4.2). Consider push, share or offline support.',
      );
    }
  }
  for (const n of input.native) add('info', `NATIVE_${n.feature.toUpperCase().replace('-', '_')}`, `Uses ${n.feature} (seen in ${n.evidence}); a native plugin and permission text will be offered.`);

  // ---- Scores: each deduction maps to a finding above ----
  let pwa = 100;
  if (!m.present) pwa -= 45;
  else {
    if (!m.hasName) pwa -= 15;
    if (m.iconCount === 0) pwa -= 20;
    if (!m.hasMaskableIcon) pwa -= 5;
    if (!m.startUrl) pwa -= 5;
  }
  if (!input.pwa.serviceWorker.registered) pwa -= 20;

  let base = packageable ? 100 : 0;
  if (packageable) {
    if (!input.build.buildCommand && input.framework !== 'static') base -= 20;
    if (!input.build.outputDir) base -= 20;
    if (!input.build.lockfile && input.framework !== 'static') base -= 10;
    if (!m.present || m.iconCount === 0) base -= 10;
  }
  const ios_ = packageable ? clamp(base - (nativeNames.length === 0 ? 15 : 0)) : 0;
  const nativeFeatures = clamp(packageable ? 60 + Math.min(40, nativeNames.length * 10) : 0);
  const storeReadiness = clamp(packageable ? (m.present && m.iconCount > 0 ? 70 : 50) + (nativeNames.length ? 10 : 0) : 0);

  return {
    android,
    ios,
    findings: f,
    scores: { android: clamp(base), ios: ios_, pwa: clamp(pwa), nativeFeatures, storeReadiness },
  };
}
