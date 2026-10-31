#!/usr/bin/env node
/** CLI: node packages/analyzer/bin/analyze.ts <repo-path> [--root apps/web] [--origin https://x] */
import { resolve } from 'node:path';
import { analyze, FsRepoSource } from '../src/index.ts';

const args = process.argv.slice(2);
const repoPath = args.find((a) => !a.startsWith('--'));
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
if (!repoPath) { console.error('usage: analyze <repo-path> [--root dir] [--origin https://host]'); process.exit(2); }
const report = await analyze(new FsRepoSource(resolve(repoPath)), { projectRoot: flag('--root') ?? '', hostedOrigin: flag('--origin') });
console.log(JSON.stringify(report, null, 2));
