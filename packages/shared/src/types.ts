/** Shared domain types for Git2App. Kept free of runtime dependencies. */

import type { BuildStatus } from './build-state.ts';

export type Platform = 'android' | 'ios';

export type Framework =
  | 'react'
  | 'vite'
  | 'next'
  | 'vue'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'sveltekit'
  | 'vanilla'
  | 'static'
  | 'unknown';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

/** How a repo can be turned into a native app. */
export type PackagingStrategy = 'twa' | 'capacitor' | 'unsupported';

/** Rendering mode of the web app — decides whether a static package is even honest. */
export type RenderMode =
  | 'static' // fully static / SPA, safe to embed
  | 'static-export' // framework can static-export (e.g. Next output: 'export')
  | 'client-rendered' // SPA that talks to a hosted backend
  | 'server-rendered' // needs a running server; cannot be embedded as static
  | 'unknown';

export interface ManifestCheck {
  present: boolean;
  accessiblePath: string | null;
  hasName: boolean;
  hasShortName: boolean;
  iconCount: number;
  hasMaskableIcon: boolean;
  startUrl: string | null;
  display: string | null;
  themeColor: string | null;
  backgroundColor: string | null;
}

export interface PwaReport {
  manifest: ManifestCheck;
  serviceWorker: { registered: boolean; file: string | null };
  httpsHostingKnown: boolean; // true if we could confirm a production HTTPS origin
  offlineLikely: boolean;
  isInstallablePwa: boolean; // manifest + name + icons + SW
}

export interface BuildDetection {
  packageManager: PackageManager;
  lockfile: string | null;
  nodeVersion: string | null; // from engines / .nvmrc / volta
  buildCommand: string | null;
  outputDir: string | null; // resolved, not assumed to be "dist"
  envVarsReferenced: string[];
}

export interface CompatibilityFinding {
  level: 'ok' | 'info' | 'warning' | 'blocker';
  code: string;
  message: string;
}

/** Scores are 0–100 and every score is backed by findings (PRD §15.4). */
export interface CompatibilityScores {
  android: number;
  ios: number;
  pwa: number;
  nativeFeatures: number;
  storeReadiness: number;
}

export interface AnalysisReport {
  schemaVersion: 1;
  analyzedAt: string; // ISO
  projectRoot: string; // subdirectory analyzed (monorepo support)
  framework: Framework;
  frameworkEvidence: string[];
  renderMode: RenderMode;
  pwa: PwaReport;
  build: BuildDetection;
  recommendedAndroidStrategy: PackagingStrategy;
  recommendedIosStrategy: PackagingStrategy;
  scores: CompatibilityScores;
  findings: CompatibilityFinding[];
  /** Human-readable, always truthful about limits (PRD §1.4). */
  summary: string;
}

/** A read-only view of a repo tree the analyzer works against. Injectable for tests. */
export interface RepoSource {
  /** Returns file text, or null if the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** Returns true if a file or directory exists. */
  exists(path: string): Promise<boolean>;
  /** Lists immediate entries under a directory (names only), or [] if missing. */
  list(dir: string): Promise<string[]>;
}

export interface AppConfiguration {
  appName: string;
  packageId: string; // Android applicationId / also used for iOS if bundleId absent
  bundleId: string; // iOS
  version: string; // e.g. 1.0.0
  buildNumber: number;
  iconPath: string | null;
  splashPath: string | null;
  themeColor: string | null;
  backgroundColor: string | null;
  orientation: 'default' | 'portrait' | 'landscape';
  permissions: NativePermission[];
  /** Why the app needs each permission, in the app's own words (shown by iOS/Android). */
  permissionText?: Partial<Record<NativePermission, string>>;
  /** Custom URL scheme for deep links, e.g. "xpenstack" for xpenstack://auth/callback. */
  urlScheme?: string | null;
  privacyPolicyUrl: string | null;
}

export type NativePermission =
  | 'camera'
  | 'location'
  | 'microphone'
  | 'notifications'
  | 'photos'
  | 'biometrics'
  | 'bluetooth';

export interface BuildRecord {
  id: string;
  projectId: string;
  userId: string;
  commitSha: string;
  platform: Platform;
  strategy: PackagingStrategy;
  status: BuildStatus;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
