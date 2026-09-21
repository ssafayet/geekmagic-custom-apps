import { execFile } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeCliDetection, ClaudeCliService, ClaudeCliUsageReading } from '@gca/module-sdk';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 2_000;
const AUTH_TIMEOUT_MS = 5_000;
/** `/usage` contacts Anthropic, so allow more than a local command would need. */
const USAGE_TIMEOUT_MS = 20_000;
/**
 * Minimum gap between `/usage` invocations.
 *
 * Each one is a process spawn plus a network round trip, measured at around seven
 * seconds. The module polls every 60s by default and the numbers it reads reset on
 * a five-hour cycle, so spawning more often than this buys nothing. Between spawns
 * the cache file is still read, which picks up refreshes made by any Claude Code
 * session running on this machine.
 */
const USAGE_MIN_INTERVAL_MS = 300_000;

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

  /**
   * Reads subscription usage by asking the CLI itself.
   *
   * `claude -p "/usage"` is handled locally by Claude Code and reports
   * `num_turns: 0` and `total_cost_usd: 0` — it is not a model call and costs no
   * tokens. Its side effect is what this actually wants: the CLI refreshes
   * `cachedUsageUtilization` in its own config file, which is structured data
   * rather than the human-readable table printed to stdout.
   *
   * That field is internal to Claude Code and may change shape between versions,
   * so every failure here is answered with null. The module treats a missing
   * reading as "no local source", never as an error.
   */
  async readUsage(signal?: AbortSignal): Promise<ClaudeCliUsageReading | null> {
    const cached = await this.readUsageCache();
    // A reading the CLI refreshed moments ago needs no new invocation: a normal
    // Claude Code session updates this file as a matter of course.
    if (cached && Date.now() - cached.fetchedAtMs < USAGE_MIN_INTERVAL_MS) {
      return cached.reading;
    }

    const binaryPath = await this.locate();
    if (!binaryPath) return cached?.reading ?? null;

    try {
      await execFileAsync(binaryPath, ['-p', '/usage', '--output-format', 'json'], {
        timeout: USAGE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
    } catch {
      // A failed refresh still leaves whatever the CLI cached earlier, which is
      // better than nothing as long as the module marks it stale.
      return cached?.reading ?? null;
    }

    const refreshed = await this.readUsageCache();
    return refreshed?.reading ?? cached?.reading ?? null;
  }

  private async readUsageCache(): Promise<{
    fetchedAtMs: number;
    reading: ClaudeCliUsageReading;
  } | null> {
    for (const path of claudeConfigPaths()) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        const reading = parseUsageUtilization(parsed);
        if (reading) return reading;
      } catch {
        continue;
      }
    }
    return null;
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

/** Claude Code keeps its config beside the home directory, or under an override. */
function claudeConfigPaths(): string[] {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  const paths = [join(homedir(), '.claude.json')];
  if (override) paths.unshift(join(override, '.claude.json'));
  return paths;
}

/**
 * Extracts the two windows the display shows from the CLI's usage cache.
 *
 * The cache carries many sibling windows under internal codenames. Only the two
 * documented in `/usage` output are read; anything unrecognised is ignored rather
 * than guessed at.
 */
export function parseUsageUtilization(
  value: unknown,
): { fetchedAtMs: number; reading: ClaudeCliUsageReading } | null {
  if (!value || typeof value !== 'object') return null;
  const cached = (value as Record<string, unknown>)['cachedUsageUtilization'];
  if (!cached || typeof cached !== 'object') return null;

  const record = cached as Record<string, unknown>;
  const fetchedAtMs = typeof record['fetchedAtMs'] === 'number' ? record['fetchedAtMs'] : 0;
  const utilization = record['utilization'];
  if (!utilization || typeof utilization !== 'object') return null;

  const windows = utilization as Record<string, unknown>;
  const fiveHour = parseWindow(windows['five_hour']);
  const sevenDay = parseWindow(windows['seven_day']);
  // Neither window present means the shape changed or the account has no
  // subscription limits; either way there is nothing to show.
  if (!fiveHour && !sevenDay) return null;

  return {
    fetchedAtMs,
    reading: {
      fetchedAt: new Date(fetchedAtMs || Date.now()).toISOString(),
      fiveHour,
      sevenDay,
    },
  };
}

function parseWindow(value: unknown): { usedPercentage: number; resetsAt: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const used = record['utilization'];
  const resetsAt = record['resets_at'];
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof resetsAt !== 'string') return null;
  const parsed = Date.parse(resetsAt);
  if (Number.isNaN(parsed)) return null;
  return {
    usedPercentage: Math.min(100, Math.max(0, Math.round(used))),
    resetsAt: new Date(parsed).toISOString(),
  };
}
