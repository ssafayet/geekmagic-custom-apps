import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeCliDetection, ClaudeCliService } from '@gca/module-sdk';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 2_000;
const AUTH_TIMEOUT_MS = 5_000;

/** Locations a user-installed Claude Code commonly lives in outside a service PATH. */
const EXTRA_PATHS = [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  join(homedir(), 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

/**
 * Detects a local Claude Code installation without ever reading its credentials.
 *
 * Everything here is observational: run `--version`, ask `auth status` whether a login
 * exists, and stop. The application never opens `~/.claude/.credentials.json`, the
 * Keychain, browser storage or Claude Desktop state — the whole point of the bridge is
 * that it does not need to.
 */
export class LocalClaudeCliService implements ClaudeCliService {
  #cache: { at: number; result: ClaudeCliDetection } | null = null;
  readonly #cacheMs: number;

  constructor(options: { cacheMs?: number } = {}) {
    this.#cacheMs = options.cacheMs ?? 15_000;
  }

  async detect(signal?: AbortSignal): Promise<ClaudeCliDetection> {
    const cached = this.#cache;
    if (cached && Date.now() - cached.at < this.#cacheMs) return cached.result;

    const result = await this.run(signal);
    this.#cache = { at: Date.now(), result };
    return result;
  }

  invalidate(): void {
    this.#cache = null;
  }

  private async run(signal?: AbortSignal): Promise<ClaudeCliDetection> {
    const binaryPath = await this.locate();
    if (!binaryPath) {
      return {
        found: false,
        binaryPath: null,
        version: null,
        authenticated: null,
        detail:
          'No `claude` binary was found in this process PATH or the usual user-local locations.',
      };
    }

    let version: string | null = null;
    try {
      // Spawned without a shell, so nothing here is interpreted by /bin/sh.
      const { stdout } = await execFileAsync(binaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      version = parseVersion(stdout);
    } catch {
      return {
        found: true,
        binaryPath,
        version: null,
        authenticated: null,
        detail: '`claude --version` did not complete. The binary may be broken or blocked.',
      };
    }

    const authenticated = await this.checkAuth(binaryPath, signal);
    return {
      found: true,
      binaryPath,
      version,
      authenticated,
      detail:
        authenticated === null
          ? 'Authentication state could not be determined from `claude auth status`.'
          : authenticated
            ? 'Claude Code is installed and signed in.'
            : 'Claude Code is installed but not signed in.',
    };
  }

  /** Exit code 0 means authenticated, 1 means not; anything else is inconclusive. */
  private async checkAuth(binaryPath: string, signal?: AbortSignal): Promise<boolean | null> {
    try {
      await execFileAsync(binaryPath, ['auth', 'status'], {
        timeout: AUTH_TIMEOUT_MS,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 1) return false;
      const stdout = String((error as { stdout?: unknown }).stdout ?? '');
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      const combined = `${stdout}\n${stderr}`.toLowerCase();
      if (/not logged in|not authenticated|please log in|run .?claude login/.test(combined))
        return false;
      if (/logged in|authenticated as|account:/.test(combined)) return true;
      return null;
    }
  }

  private async locate(): Promise<string | null> {
    const fromPath = await which('claude');
    if (fromPath) return fromPath;
    for (const candidate of EXTRA_PATHS) {
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  }
}

async function which(command: string): Promise<string | null> {
  const pathValue = process.env['PATH'] ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseVersion(stdout: string): string | null {
  const match = stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  if (match) return match[0];
  const trimmed = stdout.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}
