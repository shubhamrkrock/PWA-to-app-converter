/**
 * Plan quotas (PRD §18). Proposed limits, not final prices. iOS is capped on every plan until
 * real macOS cost per build is known (PRD §18.1).
 */

export type Plan = 'free' | 'developer' | 'pro';

export interface Limits {
  projects: number;
  androidBuildsPerMonth: number;
  iosBuildsPerMonth: number;
  autoBuilds: boolean;
  signingVault: boolean;
  concurrentBuilds: number;
}

export const LIMITS: Record<Plan, Limits> = {
  free: { projects: 1, androidBuildsPerMonth: 20, iosBuildsPerMonth: 3, autoBuilds: false, signingVault: false, concurrentBuilds: 1 },
  developer: { projects: 5, androidBuildsPerMonth: 200, iosBuildsPerMonth: 40, autoBuilds: true, signingVault: true, concurrentBuilds: 2 },
  pro: { projects: 1000, androidBuildsPerMonth: 1000, iosBuildsPerMonth: 150, autoBuilds: true, signingVault: true, concurrentBuilds: 4 },
};

export function limitsFor(plan: string | null | undefined): Limits {
  return LIMITS[(plan as Plan) in LIMITS ? (plan as Plan) : 'free'];
}

export function monthStart(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
