/**
 * analyze(): the single entry point. Deterministic — the same tree yields the same report
 * (apart from analyzedAt). An LLM may later *explain* this report, never replace it (PRD §15).
 */

import type { AnalysisReport, RepoSource } from '@git2app/shared';
import { detectFramework } from './detect-framework.ts';
import { detectPwa } from './detect-pwa.ts';
import { detectBuild } from './detect-build.ts';
import { detectNative } from './detect-native.ts';
import { recommend } from './strategy.ts';

export { FsRepoSource, MemRepoSource } from './repo-source.ts';
export { detectFramework, detectPwa, detectBuild, detectNative, recommend };

export interface AnalyzeOptions {
  projectRoot?: string;
  hostedOrigin?: string | null;
  now?: () => Date;
}

export async function analyze(repo: RepoSource, opts: AnalyzeOptions = {}): Promise<AnalysisReport> {
  const rawRoot = opts.projectRoot ?? '';
  if (rawRoot.split(/[\\/]/).includes('..') || rawRoot.startsWith('/')) throw new Error('projectRoot may not contain .. or be absolute');
  const root = rawRoot.replace(/^(\.\/)+/, '').replace(/^\.$/, '').replace(/\/+$/, '');

  const fw = await detectFramework(repo, root);
  const pwa = await detectPwa(repo, root);
  const build = await detectBuild(repo, root, fw.framework);
  const native = await detectNative(repo, root);
  const rec = recommend({ framework: fw.framework, renderMode: fw.renderMode, pwa, build, native, hostedOrigin: opts.hostedOrigin ?? null });
  if (opts.hostedOrigin && /^https:\/\//.test(opts.hostedOrigin)) pwa.httpsHostingKnown = true;

  const blockers = rec.findings.filter((x) => x.level === 'blocker');
  const summary = blockers.length
    ? `Not packageable as-is: ${blockers.map((b) => b.message).join(' ')}`
    : `${fw.framework} app (${fw.renderMode}). Android: ${rec.android}. iOS: ${rec.ios}. ` +
      'This is a readiness check, not a store approval; Apple and Google decide approval.';

  return {
    schemaVersion: 1,
    analyzedAt: (opts.now ?? (() => new Date()))().toISOString(),
    projectRoot: root,
    framework: fw.framework,
    frameworkEvidence: fw.evidence,
    renderMode: fw.renderMode,
    pwa,
    build,
    recommendedAndroidStrategy: rec.android,
    recommendedIosStrategy: rec.ios,
    scores: rec.scores,
    findings: rec.findings,
    summary,
  };
}
