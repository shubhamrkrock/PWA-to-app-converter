/**
 * Running commands. Anything that executes repository code (dependency install, the web build,
 * Gradle, Xcode) runs through `sandboxed`, which on the Linux worker drops to an unprivileged
 * user with a scrubbed environment: no job ticket, no OIDC request token, no GitHub token, and no
 * way to read the runner's environment through /proc (PRD §16.1). Every command has a timeout.
 */

import { spawn } from 'node:child_process';
import type { Logger } from './log.ts';

export class CommandError extends Error {
  readonly code: number | null;
  readonly tail: string;
  constructor(cmd: string, code: number | null, tail: string) {
    super(`${cmd} exited with ${code === null ? 'a timeout or signal' : `code ${code}`}`);
    this.code = code;
    this.tail = tail;
  }
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  logger?: Logger;
  /** Run as the sandbox user with a clean environment. */
  sandbox?: boolean;
  input?: string;
}

/** Variables passed through to sandboxed commands; everything else is dropped. */
// Proxy and CA settings are network plumbing, not secrets; corporate or sandboxed networks need them.
const SANDBOX_PASS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DEVELOPER_DIR', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'JAVA_TOOL_OPTIONS'];

/** Never hand these to a sandboxed process, even if a caller passes them. */
const FORBIDDEN = /^(ACTIONS_|GITHUB_TOKEN|G2A_TICKET|RUNNER_TOKEN|INPUT_)/;

export function sandboxEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, home: string): Record<string, string> {
  const out: Record<string, string> = { HOME: home, CI: 'true', npm_config_update_notifier: 'false', NEXT_TELEMETRY_DISABLED: '1' };
  for (const k of SANDBOX_PASS) if (base[k]) out[k] = base[k]!;
  for (const [k, v] of Object.entries(extra)) if (!FORBIDDEN.test(k)) out[k] = v;
  return out;
}

export function sandboxUser(): string | null {
  const u = process.env.G2A_SANDBOX_USER;
  return u && /^[a-z_][a-z0-9_-]{0,31}$/.test(u) ? u : null;
}

export function run(cmd: string, args: string[], opts: RunOptions): Promise<string> {
  let file = cmd;
  let argv = args;
  let env: Record<string, string>;
  const user = opts.sandbox ? sandboxUser() : null;
  if (opts.sandbox) {
    const home = user ? `/home/${user}` : (process.env.G2A_SANDBOX_HOME ?? process.env.HOME ?? '/tmp');
    env = sandboxEnv(process.env, opts.env, home);
    if (user) {
      // sudo -n: never prompt. env -i: start from nothing, then only the allowed variables.
      file = 'sudo';
      argv = ['-n', '-u', user, '-H', 'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args];
      env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    }
  } else {
    env = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const tail: string[] = [];
    let out = '';
    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
      for (const l of s.split('\n')) if (l) tail.push(l), tail.length > 80 && tail.shift();
      opts.logger?.line(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          opts.logger?.line(`Timed out after ${Math.round(opts.timeoutMs! / 60000)} min: ${cmd}`);
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new CommandError(cmd, null, String(e.message)));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new CommandError(`${cmd} ${args.slice(0, 2).join(' ')}`.trim(), code, tail.join('\n')));
    });
  });
}

/** Stop anything the sandbox user left running before trusted steps continue. */
export async function killSandboxProcesses(): Promise<void> {
  const user = sandboxUser();
  if (!user) return;
  await run('sudo', ['-n', 'pkill', '-KILL', '-u', user], { cwd: '/' }).catch(() => {});
}

/** Give the sandbox user the workspace (Linux worker only). */
export async function handToSandbox(dir: string): Promise<void> {
  const user = sandboxUser();
  if (!user) return;
  await run('sudo', ['-n', 'chown', '-R', `${user}:${user}`, dir], { cwd: '/' });
}

/** Take the workspace back after untrusted steps, so the sandbox user cannot change outputs. */
export async function takeFromSandbox(dir: string): Promise<void> {
  const user = sandboxUser();
  if (!user) return;
  await killSandboxProcesses();
  const me = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  await run('sudo', ['-n', 'chown', '-R', me, dir], { cwd: '/' });
}
