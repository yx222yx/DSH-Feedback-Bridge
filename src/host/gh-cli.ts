/**
 * Host-side GitHub CLI runner for the explicitly selected gh account path
 * (Issue #9). The runner is the only place the plugin talks to the local
 * `gh` binary: it discovers stored GitHub CLI accounts from `gh auth
 * status` and resolves one account's OAuth token via `gh auth token`.
 *
 * Security contract: account discovery and token resolution never expose the
 * token to the Client, the model, or logs. The token leaves this module only
 * through the `tokenFor` return value, which the GitHub service attaches to
 * the Host-to-GitHub fetch header. Child processes never run through a
 * shell, never inherit ambient GitHub or model credentials, and are killed
 * on timeout.
 */

import { spawn } from 'node:child_process';
import type { GhAccount, GhCli } from './github.js';

/** Result of one gh command invocation. */
export interface GhRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Per-invocation options of a gh run. */
export interface GhRunOptions {
  timeoutMs?: number;
}

/** The injectable command seam; production wires a real spawn. */
export type GhRun = (args: string[], options?: GhRunOptions) => Promise<GhRunResult>;

/** Default per-command timeout for gh invocations. */
export const DEFAULT_GH_TIMEOUT_MS = 10_000;

/** Ambient credential environment variables that must never reach a gh child. */
const CREDENTIAL_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'DEEPSEEK_API_KEY',
] as const;

/** Minimal structural view of the spawned child the runner drives. */
export interface GhSpawnHandle {
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): void };
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void };
  on(event: 'error' | 'close', listener: (code?: number | null) => void): void;
  kill(): void;
}

/** The injectable spawn seam; production wires node:child_process spawn. */
export type GhSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
) => GhSpawnHandle;

/**
 * Copy an environment with ambient credential variables removed, so a gh
 * child can never pick up a token or model key that happens to be exported.
 *
 * @param base - the parent environment, usually process.env.
 * @returns a sanitized copy.
 */
export function sanitizeGhEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Parse `gh auth status` output into github.com accounts. Only github.com
 * logins count; enterprise hosts and not-logged-in output produce nothing.
 *
 * @param stdout - raw `gh auth status` output.
 * @returns the parsed accounts in output order with the active flag.
 */
export function parseGhAuthStatus(stdout: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let current: GhAccount | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/i.exec(trimmed);
    if (match !== null) {
      current = { login: match[1], active: false };
      accounts.push(current);
      continue;
    }
    if (current !== null && /^- Active account: true$/i.test(trimmed)) {
      current.active = true;
    }
  }
  return accounts;
}

/** Spawn gh without a shell, with a credential-free env, and kill on timeout. */
function runGhCommand(spawnFn: GhSpawnFn, args: string[], timeoutMs: number): Promise<GhRunResult> {
  return new Promise((resolve) => {
    const child = spawnFn('gh', args, { env: sanitizeGhEnv(process.env), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

/**
 * Create the default gh command runner over node:child_process.
 *
 * @param spawnFn - spawn seam; defaults to the real spawn.
 * @param timeoutMs - default per-command timeout.
 * @returns a run function the gh CLI handle is built on.
 */
export function createGhRun(
  spawnFn: GhSpawnFn = (command, args, options) => spawn(command, args, options) as unknown as GhSpawnHandle,
  timeoutMs: number = DEFAULT_GH_TIMEOUT_MS,
): GhRun {
  return (args, options) => runGhCommand(spawnFn, args, options?.timeoutMs ?? timeoutMs);
}

/**
 * Create the gh CLI handle over an injected run seam.
 *
 * @param run - the command seam; production wires createGhRun().
 * @returns the runner handle.
 */
export function createGhCli(run: GhRun): GhCli {
  return {
    async listAccounts() {
      const result = await run(['auth', 'status']);
      if (result.code !== 0) return [];
      return parseGhAuthStatus(result.stdout);
    },
    async tokenFor(login) {
      const result = await run(['auth', 'token', '-u', login]);
      if (result.code !== 0) {
        throw new Error('dsh-feedback-bridge: no GitHub CLI token for account ' + login);
      }
      const token = result.stdout.trim();
      if (token === '') {
        throw new Error('dsh-feedback-bridge: empty GitHub CLI token for account ' + login);
      }
      return token;
    },
  };
}
