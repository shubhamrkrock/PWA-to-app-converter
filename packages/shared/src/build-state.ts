/**
 * Build lifecycle state machine (PRD §10.1).
 *
 * The API, the runner and the UI all import this so they agree on which transitions are
 * legal. An illegal transition throws — a build can never silently jump stages, and a
 * failure state is terminal. This is deliberately tiny and dependency-free so it runs
 * unchanged in a Cloudflare Worker and in a Node build worker.
 */

export const BUILD_STAGES = [
  'CREATED',
  'QUEUED',
  'ANALYZING',
  'DEPENDENCY_INSTALLATION',
  'WEB_BUILD',
  'NATIVE_CONFIGURATION',
  'PLATFORM_COMPILATION',
  'SIGNING',
  'VALIDATION',
  'COMPLETED',
] as const;

export type BuildStage = (typeof BUILD_STAGES)[number];

/** Terminal failure states, one per stage that can fail, plus a user cancel. */
export const FAILURE_STATES = [
  'CANCELLED',
  'FAILED_ANALYSIS',
  'FAILED_DEPENDENCIES',
  'FAILED_WEB_BUILD',
  'FAILED_NATIVE_CONFIGURATION',
  'FAILED_COMPILATION',
  'FAILED_SIGNING',
  'FAILED_VALIDATION',
] as const;

export type FailureState = (typeof FAILURE_STATES)[number];

export type BuildStatus = BuildStage | FailureState;

/** The failure that belongs to each non-terminal stage. */
const FAILURE_FOR_STAGE: Partial<Record<BuildStage, FailureState>> = {
  ANALYZING: 'FAILED_ANALYSIS',
  DEPENDENCY_INSTALLATION: 'FAILED_DEPENDENCIES',
  WEB_BUILD: 'FAILED_WEB_BUILD',
  NATIVE_CONFIGURATION: 'FAILED_NATIVE_CONFIGURATION',
  PLATFORM_COMPILATION: 'FAILED_COMPILATION',
  SIGNING: 'FAILED_SIGNING',
  VALIDATION: 'FAILED_VALIDATION',
};

export function isFailureState(s: BuildStatus): s is FailureState {
  return (FAILURE_STATES as readonly string[]).includes(s);
}

export function isTerminal(s: BuildStatus): boolean {
  return s === 'COMPLETED' || isFailureState(s);
}

const STAGE_INDEX = new Map<BuildStage, number>(BUILD_STAGES.map((s, i) => [s, i]));

/** Can a build in `from` legally move to `to`? */
export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  if (isTerminal(from)) return false; // terminal states never move
  // A build may cancel from any non-terminal state.
  if (to === 'CANCELLED') return true;
  // A stage may fail into its own failure state.
  if (isFailureState(to)) {
    return !isFailureState(from) && FAILURE_FOR_STAGE[from as BuildStage] === to;
  }
  // Otherwise only forward-by-one through the stage list is allowed.
  const fi = STAGE_INDEX.get(from as BuildStage);
  const ti = STAGE_INDEX.get(to as BuildStage);
  if (fi === undefined || ti === undefined) return false;
  return ti === fi + 1;
}

/** Apply a transition or throw with a clear message (used by the runner/API). */
export function transition(from: BuildStatus, to: BuildStatus): BuildStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal build transition: ${from} -> ${to}`);
  }
  return to;
}

/** The failure state for the stage a build is currently in. */
export function failureFor(stage: BuildStage): FailureState {
  const f = FAILURE_FOR_STAGE[stage];
  if (!f) throw new Error(`Stage ${stage} has no failure state`);
  return f;
}
