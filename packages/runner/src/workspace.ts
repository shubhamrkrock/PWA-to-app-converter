/**
 * Getting the user's web app built: clone exactly the requested commit, install dependencies
 * with the lockfile, run the build, and check the output folder is a real web app. Every step
 * that runs repository code is sandboxed (see exec.ts).
 */

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import type { BuildDetection } from '@git2app/shared';
import { run } from './exec.ts';
import type { Logger } from './log.ts';
import type { RepoSpec } from './reporter.ts';

export class StageError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

/** Resolve a repo-relative path and refuse anything that escapes the root. */
export function inside(root: string, rel: string): string {
  if (rel.split(/[\\/]/).includes('..') || rel.startsWith('/')) throw new StageError(`Path ${rel} leaves the repository`, 'Use a folder inside the repository.');
  const full = normalize(resolve(root, rel || '.'));
  const r = normalize(resolve(root));
  if (full !== r && !full.startsWith(r + sep)) throw new StageError(`Path ${rel} leaves the repository`, 'Use a folder inside the repository.');
  return full;
}

/**
 * Clone one commit. The token travels in GIT_CONFIG_* environment variables (not argv, which any
 * local user can read with ps) and is never written to .git/config.
 */
export async function cloneAtCommit(repo: RepoSpec, dest: string, logger: Logger): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(repo.commitSha)) throw new StageError('Invalid commit SHA', 'Pick a full commit SHA.');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(repo.cloneUrl)) throw new StageError('Unexpected clone URL', 'Only GitHub repositories are supported.');
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (repo.cloneToken) {
    logger.addSecret(repo.cloneToken);
    const basic = Buffer.from(`x-access-token:${repo.cloneToken}`).toString('base64');
    logger.addSecret(basic);
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
  }
  logger.line(`Cloning ${repo.fullName} at ${repo.commitSha}`);
  await run('git', ['init', '-q', dest], { cwd: '/', logger });
  await run('git', ['-C', dest, 'remote', 'add', 'origin', repo.cloneUrl], { cwd: dest, logger });
  await run('git', ['-C', dest, 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', repo.commitSha], { cwd: dest, env, logger, timeoutMs: 15 * 60_000 });
  await run('git', ['-C', dest, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: dest, logger });
  // Submodules are not fetched: they would need credentials we do not hold, and are rare in PWAs.
  const head = (await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { cwd: dest })).trim();
  if (head !== repo.commitSha) throw new StageError(`Checked out ${head}, expected ${repo.commitSha}`, 'Retry the build.');
  logger.line(`Checked out ${head}`);
}

export function installCommand(pm: BuildDetection['packageManager'], lockfile: string | null): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] };
    case 'yarn':
      return { cmd: 'corepack', args: ['yarn', 'install', '--immutable'] };
    case 'bun':
      return { cmd: 'bun', args: ['install', '--frozen-lockfile'] };
    default:
      return lockfile ? { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] } : { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] };
  }
}

export async function installDependencies(projectDir: string, build: BuildDetection, logger: Logger): Promise<void> {
  const { cmd, args } = installCommand(build.packageManager, build.lockfile);
  logger.line(`Installing dependencies: ${cmd} ${args.join(' ')}`);
  try {
    await run(cmd, args, { cwd: projectDir, sandbox: true, logger, timeoutMs: 25 * 60_000 });
  } catch (e: any) {
    throw new StageError('Dependency installation failed', explainInstall(String(e.tail ?? '')));
  }
}

function explainInstall(tail: string): string {
  if (/npm ci can only install packages when your package.json and package-lock.json/.test(tail) || /lockfile.*(out of date|not up to date)|frozen-lockfile/i.test(tail)) {
    return 'The lockfile does not match package.json. Run your package manager install locally and commit the updated lockfile.';
  }
  if (/E404|404 Not Found/.test(tail)) return 'A dependency was not found on the registry. Private packages are not supported yet.';
  if (/EBADENGINE|engine/.test(tail)) return 'A dependency needs a different Node.js version. Set "engines.node" or .nvmrc.';
  return 'See the log above for the first error from the package manager.';
}

export async function buildWeb(projectDir: string, build: BuildDetection, logger: Logger, env: Record<string, string> = {}): Promise<void> {
  if (!build.buildCommand) {
    logger.line('No build step: the project is served as-is.');
    return;
  }
  const [cmd, ...args] = build.buildCommand.split(' ') as [string, ...string[]];
  const viaCorepack = cmd === 'pnpm' || cmd === 'yarn';
  logger.line(`Building the web app: ${build.buildCommand}`);
  try {
    await run(viaCorepack ? 'corepack' : cmd, viaCorepack ? [cmd, ...args] : args, { cwd: projectDir, sandbox: true, logger, timeoutMs: 25 * 60_000, env: { NODE_ENV: 'production', ...env } });
  } catch (e: any) {
    const tail = String(e.tail ?? '');
    const missing = build.envVarsReferenced.filter((v) => tail.includes(v));
    throw new StageError(
      'The web build failed',
      missing.length ? `The build mentions ${missing.join(', ')} in its error. Add them as build settings.` : 'Run the same build command locally to see the error, then push a fix.',
    );
  }
}

/** The output must exist, contain index.html, and not be the source tree itself. */
export async function checkWebOutput(projectDir: string, outputDir: string): Promise<{ dir: string; files: number; bytes: number }> {
  const dir = inside(projectDir, outputDir);
  try {
    await access(join(dir, 'index.html'));
  } catch {
    throw new StageError(`No index.html in ${outputDir} after the build`, 'Check the output folder setting; it must hold the built site.');
  }
  let files = 0;
  let bytes = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') throw new StageError('The output folder contains node_modules', 'Point the output folder at the build output, not the project.');
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        files++;
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir, 0);
  if (bytes > 400 * 1024 * 1024) throw new StageError('The built web app is over 400 MB', 'Remove large files from the build output.');
  return { dir, files, bytes };
}

/** The web manifest inside the built output, used for icons and colours. */
export async function builtManifest(outDir: string): Promise<{ path: string; json: any } | null> {
  const html = await readFile(join(outDir, 'index.html'), 'utf8').catch(() => '');
  const href = /<link[^>]+rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']manifest["']/i.exec(html)?.[1];
  const candidates = [href, 'manifest.webmanifest', 'manifest.json'].filter(Boolean) as string[];
  for (const c of candidates) {
    if (/^https?:/.test(c)) continue;
    try {
      const p = inside(outDir, c.replace(/^\.?\//, '').split('?')[0]!);
      return { path: p, json: JSON.parse(await readFile(p, 'utf8')) };
    } catch {}
  }
  return null;
}
