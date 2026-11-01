/** Build status in plain words, and how far along a build is. */
import { BUILD_STAGES, FAILURE_STATES, type BuildStatus } from '@git2app/shared';

export const STAGE_LABEL: Record<string, string> = {
  CREATED: 'Created',
  QUEUED: 'Waiting for a build computer',
  ANALYZING: 'Checking the code',
  DEPENDENCY_INSTALLATION: 'Installing packages',
  WEB_BUILD: 'Building the website',
  NATIVE_CONFIGURATION: 'Making the app project',
  PLATFORM_COMPILATION: 'Compiling the app',
  SIGNING: 'Signing',
  VALIDATION: 'Checking the app',
  COMPLETED: 'Ready',
  CANCELLED: 'Cancelled',
  FAILED_ANALYSIS: 'Failed while checking the code',
  FAILED_DEPENDENCIES: 'Failed installing packages',
  FAILED_WEB_BUILD: 'Failed building the website',
  FAILED_NATIVE_CONFIGURATION: 'Failed making the app project',
  FAILED_COMPILATION: 'Failed compiling the app',
  FAILED_SIGNING: 'Failed signing',
  FAILED_VALIDATION: 'Failed the app checks',
};

export type Tone = 'done' | 'running' | 'failed' | 'muted';

export function toneOf(status: string): Tone {
  if (status === 'COMPLETED') return 'done';
  if (status === 'CANCELLED') return 'muted';
  if ((FAILURE_STATES as readonly string[]).includes(status)) return 'failed';
  return 'running';
}

export function isFinished(status: string): boolean {
  return toneOf(status) !== 'running';
}

/**
 * The steps a build shows, with where it is. Store builds go through Signing; test builds skip
 * it, so it is hidden for them. A failure marks the step it happened in.
 */
export function steps(status: string, variant: 'debug' | 'release'): Array<{ stage: string; label: string; state: 'done' | 'current' | 'failed' | 'todo' }> {
  const visible = BUILD_STAGES.filter((s) => s !== 'CREATED' && (variant === 'release' || s !== 'SIGNING'));
  const failedAt = failedStage(status);
  const at = failedAt ?? (status === 'CANCELLED' ? null : status);
  const idx = at ? BUILD_STAGES.indexOf(at as (typeof BUILD_STAGES)[number]) : -1;
  return visible.map((stage) => {
    const i = BUILD_STAGES.indexOf(stage);
    let state: 'done' | 'current' | 'failed' | 'todo' = 'todo';
    if (status === 'COMPLETED' || i < idx) state = 'done';
    else if (i === idx) state = failedAt ? 'failed' : 'current';
    return { stage, label: STAGE_LABEL[stage] ?? stage, state };
  });
}

const FAILED_AT: Record<string, BuildStatus> = {
  FAILED_ANALYSIS: 'ANALYZING',
  FAILED_DEPENDENCIES: 'DEPENDENCY_INSTALLATION',
  FAILED_WEB_BUILD: 'WEB_BUILD',
  FAILED_NATIVE_CONFIGURATION: 'NATIVE_CONFIGURATION',
  FAILED_COMPILATION: 'PLATFORM_COMPILATION',
  FAILED_SIGNING: 'SIGNING',
  FAILED_VALIDATION: 'VALIDATION',
};

export function failedStage(status: string): string | null {
  return FAILED_AT[status] ?? null;
}

export const ARTIFACT_LABEL: Record<string, string> = {
  apk: 'Android app (.apk)',
  aab: 'Play Store bundle (.aab)',
  ipa: 'iPhone app (.ipa)',
  'ios-simulator-app': 'iPhone simulator app',
  'android-project': 'Android Studio project',
  'ios-project': 'Xcode project',
  report: 'Build report',
  log: 'Build log',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
