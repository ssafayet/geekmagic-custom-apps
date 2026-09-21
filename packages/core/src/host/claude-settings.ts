import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppError, nowIso, randomToken } from '@gca/shared';
import type { ClaudeBridgeInstallState, ClaudeSettingsService } from '@gca/module-sdk';

export const BRIDGE_MANIFEST_VERSION = 1;
const MANIFEST_FILENAME = 'claude-bridge.json';
const TOKEN_FILENAME = 'claude-bridge.token';
const MIN_TOKEN_LENGTH = 16;
const MAX_SETTINGS_BYTES = 1024 * 1024;

export interface BridgeManifest {
  version: number;
  installedAt: string;
  settingsPath: string;
  backupPath: string | null;
  endpoint: string;
  tokenFile: string;
  /** The exact statusLine value that existed before installation, or null. */
  previousStatusLine: unknown;
  /** The exact statusLine value this installer wrote, used to detect later edits. */
  writtenStatusLine: unknown;
  /** Command string of the chained status line, for display only. */
  chainedCommand: string | null;
}

export interface ClaudeSettingsServiceOptions {
  dataDir: string;
  /** Absolute path to the bridge CLI entry point. */
  bridgeCommand: string;
  /** Loopback ingestion endpoint the bridge posts to. */
  endpoint: string;
  settingsPath?: string;
}

/**
 * Installs and removes the Claude Code status-line bridge.
 *
 * Two rules drive the whole implementation. First, an existing status line is sacred:
 * it is recorded verbatim, chained so it keeps rendering, and restored byte-for-byte
 * on uninstall. Second, the bridge token never enters Claude's settings file — the
 * command points at an owner-only token file instead.
 */
export class LocalClaudeSettingsService implements ClaudeSettingsService {
  readonly #settingsPath: string;
  readonly #manifestPath: string;
  readonly #tokenPath: string;
  readonly #bridgeCommand: string;
  readonly #endpoint: string;

  constructor(options: ClaudeSettingsServiceOptions) {
    this.#settingsPath = options.settingsPath ?? join(homedir(), '.claude', 'settings.json');
    this.#manifestPath = join(options.dataDir, MANIFEST_FILENAME);
    this.#tokenPath = join(options.dataDir, TOKEN_FILENAME);
    this.#bridgeCommand = options.bridgeCommand;
    this.#endpoint = options.endpoint;
  }

  get tokenPath(): string {
    return this.#tokenPath;
  }

  get manifestPath(): string {
    return this.#manifestPath;
  }

  /** Reads (creating on first use) the shared secret the ingestion endpoint checks. */
  readOrCreateToken(): string {
    if (existsSync(this.#tokenPath)) {
      const token = readFileSync(this.#tokenPath, 'utf8').trim();
      if (token.length >= MIN_TOKEN_LENGTH) return token;
    }
    const token = randomToken(32);
    mkdirSync(dirname(this.#tokenPath), { recursive: true });
    writeFileSync(this.#tokenPath, token, { mode: 0o600 });
    chmodSync(this.#tokenPath, 0o600);
    return token;
  }

  /**
   * Stores a token chosen elsewhere, so the bridge can match a server that was
   * given one through `GCA_BRIDGE_TOKEN`.
   */
  writeToken(token: string): string {
    const trimmed = token.trim();
    if (trimmed.length < MIN_TOKEN_LENGTH) {
      throw new AppError(
        'VALIDATION_FAILED',
        `A bridge token must be at least ${MIN_TOKEN_LENGTH} characters.`,
      );
    }
    mkdirSync(dirname(this.#tokenPath), { recursive: true });
    writeFileSync(this.#tokenPath, trimmed, { mode: 0o600 });
    chmodSync(this.#tokenPath, 0o600);
    return trimmed;
  }

  async inspect(): Promise<ClaudeBridgeInstallState> {
    const manifest = this.readManifest();
    const settings = this.readSettings();
    const currentStatusLine = settings?.['statusLine'] ?? null;

    if (!manifest) {
      return {
        installed: false,
        settingsPath: this.#settingsPath,
        chainedCommand: null,
        installedAt: null,
        backupPath: null,
        conflict: null,
      };
    }

    const stillOurs = deepEqual(currentStatusLine, manifest.writtenStatusLine);
    return {
      installed: stillOurs,
      settingsPath: manifest.settingsPath,
      chainedCommand: manifest.chainedCommand,
      installedAt: manifest.installedAt,
      backupPath: manifest.backupPath,
      conflict: stillOurs
        ? null
        : 'The status line in ~/.claude/settings.json no longer matches what was installed. It was changed outside this application.',
    };
  }

  async install(): Promise<ClaudeBridgeInstallState> {
    const existing = this.readSettings() ?? {};
    const current = existing['statusLine'] ?? null;

    // Re-installing must not chain the bridge to its own previous invocation: that
    // makes every render spawn it twice, post twice, and turns uninstall into a
    // no-op that "restores" the bridge. Carry forward whatever the first install
    // displaced instead, so running this repeatedly is genuinely idempotent.
    const alreadyOurs = isBridgeStatusLine(current, this.#manifestPath);
    const recorded = this.readManifest()?.previousStatusLine ?? null;
    // Also repair a manifest an earlier install already corrupted this way: what it
    // recorded as "previous" may itself be the bridge.
    const previousStatusLine = alreadyOurs
      ? isBridgeStatusLine(recorded, this.#manifestPath)
        ? null
        : recorded
      : current;

    // Ensure the token exists before the command that depends on it is written.
    this.readOrCreateToken();

    const backupPath = this.writeBackup(existing);

    const writtenStatusLine = {
      type: 'command',
      command: `${this.#bridgeCommand} run --config ${quoteIfNeeded(this.#manifestPath)}`,
      padding: readPadding(previousStatusLine),
    };

    // Spread preserves every unrelated key in the user's settings file.
    const updated = { ...existing, statusLine: writtenStatusLine };
    this.writeSettings(updated);

    const manifest: BridgeManifest = {
      version: BRIDGE_MANIFEST_VERSION,
      installedAt: nowIso(),
      settingsPath: this.#settingsPath,
      backupPath,
      endpoint: this.#endpoint,
      tokenFile: this.#tokenPath,
      previousStatusLine,
      writtenStatusLine,
      chainedCommand: readCommand(previousStatusLine),
    };
    this.writeManifest(manifest);

    return {
      installed: true,
      settingsPath: this.#settingsPath,
      chainedCommand: manifest.chainedCommand,
      installedAt: manifest.installedAt,
      backupPath,
      conflict: null,
    };
  }

  async uninstall(): Promise<ClaudeBridgeInstallState> {
    const manifest = this.readManifest();
    if (!manifest) {
      return {
        installed: false,
        settingsPath: this.#settingsPath,
        chainedCommand: null,
        installedAt: null,
        backupPath: null,
        conflict: null,
      };
    }

    const settings = this.readSettings() ?? {};
    const current = settings['statusLine'] ?? null;

    // Only unwind what we actually wrote. If the user (or another tool) has since
    // changed the status line, silently reverting would destroy their configuration.
    if (!deepEqual(current, manifest.writtenStatusLine)) {
      return {
        installed: false,
        settingsPath: manifest.settingsPath,
        chainedCommand: manifest.chainedCommand,
        installedAt: manifest.installedAt,
        backupPath: manifest.backupPath,
        conflict:
          'The status line was modified after the bridge was installed, so it was left untouched. Edit ~/.claude/settings.json by hand to finish removing the bridge.',
      };
    }

    const restored = { ...settings };
    if (manifest.previousStatusLine === null || manifest.previousStatusLine === undefined) {
      delete restored['statusLine'];
    } else {
      restored['statusLine'] = manifest.previousStatusLine;
    }
    this.writeSettings(restored);
    this.deleteManifest();

    return {
      installed: false,
      settingsPath: manifest.settingsPath,
      chainedCommand: null,
      installedAt: null,
      backupPath: manifest.backupPath,
      conflict: null,
    };
  }

  readManifest(): BridgeManifest | null {
    if (!existsSync(this.#manifestPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.#manifestPath, 'utf8')) as BridgeManifest;
      return parsed.version === BRIDGE_MANIFEST_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeManifest(manifest: BridgeManifest): void {
    mkdirSync(dirname(this.#manifestPath), { recursive: true });
    writeFileSync(this.#manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  private deleteManifest(): void {
    try {
      unlinkSync(this.#manifestPath);
    } catch {
      // Already gone is the desired end state.
    }
  }

  private readSettings(): Record<string, unknown> | null {
    if (!existsSync(this.#settingsPath)) return null;
    const raw = readFileSync(this.#settingsPath, 'utf8');
    if (raw.length > MAX_SETTINGS_BYTES) {
      throw new AppError(
        'CLAUDE_BRIDGE_INSTALL_FAILED',
        `${this.#settingsPath} is unexpectedly large; refusing to rewrite it.`,
      );
    }
    if (raw.trim() === '') return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings.json is not a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (cause) {
      throw new AppError(
        'CLAUDE_BRIDGE_INSTALL_FAILED',
        `${this.#settingsPath} is not valid JSON, so it was not modified. Fix it and try again.`,
        { cause },
      );
    }
  }

  /** Atomic write: a crash mid-write must not leave Claude with a truncated config. */
  private writeSettings(value: Record<string, unknown>): void {
    mkdirSync(dirname(this.#settingsPath), { recursive: true });
    const temporary = `${this.#settingsPath}.gca-tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#settingsPath);
  }

  private writeBackup(settings: Record<string, unknown>): string | null {
    if (!existsSync(this.#settingsPath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.#settingsPath}.gca-backup-${stamp}`;
    writeFileSync(backupPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return backupPath;
  }
}

function readCommand(statusLine: unknown): string | null {
  if (!statusLine || typeof statusLine !== 'object') return null;
  const command = (statusLine as Record<string, unknown>)['command'];
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

function readPadding(statusLine: unknown): number {
  if (!statusLine || typeof statusLine !== 'object') return 0;
  const padding = (statusLine as Record<string, unknown>)['padding'];
  return typeof padding === 'number' && Number.isFinite(padding) ? padding : 0;
}

function quoteIfNeeded(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key, index) =>
      key === bKeys[index] &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Recognises a status line this bridge wrote.
 *
 * Matched on the manifest path rather than the whole command, because the node
 * binary and the source-versus-dist entry point legitimately differ between the
 * `tsx` development path and an installed build.
 */
export function isBridgeStatusLine(statusLine: unknown, manifestPath: string): boolean {
  if (!statusLine || typeof statusLine !== 'object') return false;
  const command = (statusLine as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(manifestPath);
}
