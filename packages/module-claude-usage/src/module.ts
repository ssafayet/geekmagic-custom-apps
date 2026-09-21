import { AppError, ageSeconds, nowIso, toAppError } from '@gca/shared';
import type {
  AppModule,
  ClaudeCliDetection,
  FrameContext,
  ModuleActionResult,
  ModuleContext,
  ModuleFrameDraft,
  ModuleHealth,
  ModuleManifest,
  ModuleRuntime,
  RefreshReason,
  ValidationContext,
  ValidationResult,
} from '@gca/module-sdk';
import { buildClaudeFrames, CLAUDE_VIEW_API_COST, CLAUDE_VIEW_RATE_LIMITS } from './frames.js';
import {
  ADMIN_API_KEY_SECRET,
  CLAUDE_DEFAULT_SETTINGS,
  CLAUDE_SETTINGS_SCHEMA,
  CLAUDE_UI_SCHEMA,
  type ClaudeUsageSettings,
} from './settings.js';
import { AnthropicUsageClient } from './usage-api.js';
import { isLocalRateLimitSource, isPendingSnapshot } from './types.js';
import type { ClaudeRateLimitSnapshot, ClaudeUsageSnapshot } from './types.js';

/** Organization polling must stay at or below once per minute per Anthropic guidance. */
const MIN_API_POLL_INTERVAL_MS = 60_000;

export const claudeUsageManifest: ModuleManifest = {
  id: 'claude-usage',
  version: '1.0.0',
  settingsVersion: 1,
  displayName: 'Claude Usage',
  description:
    'Shows Claude Code subscription rate-limit usage from your local session, or Anthropic organization API tokens and cost.',
  icon: 'sparkle',
  category: 'productivity',
  singleton: true,
  // Rate limits arrive by event; the timer only re-evaluates relative text and staleness.
  refresh: { defaultSeconds: 60, minimumSeconds: 30, maximumSeconds: 900 },
  permissions: [
    'network:anthropic',
    'host:claude-cli-status',
    'host:claude-settings-write',
    'secrets:read-own',
  ],
  views: [
    { id: CLAUDE_VIEW_RATE_LIMITS, displayName: 'Subscription limits', selectable: true },
    { id: CLAUDE_VIEW_API_COST, displayName: 'API tokens and cost', selectable: true },
  ],
  actions: [
    {
      id: 'claude.detectLocalCli',
      displayName: 'Detect Claude Code',
      description: 'Runs `claude --version` and `claude auth status`. Credentials are never read.',
      confirmation: 'none',
      timeoutMs: 10_000,
    },
    {
      id: 'claude.installBridge',
      displayName: 'Install status-line bridge',
      description: 'Adds the bridge to ~/.claude/settings.json, chaining any existing status line.',
      confirmation: 'confirm',
      timeoutMs: 15_000,
      writes: true,
    },
    {
      id: 'claude.uninstallBridge',
      displayName: 'Remove status-line bridge',
      description: 'Restores the previous status-line configuration.',
      confirmation: 'confirm',
      timeoutMs: 15_000,
      writes: true,
    },
    {
      id: 'claude.testCredential',
      displayName: 'Test credential',
      description: 'Performs one minimal organization usage query. No paid model call is made.',
      confirmation: 'none',
      timeoutMs: 20_000,
    },
  ],
};

type ActiveSource = 'local' | 'api' | 'none';

class ClaudeUsageRuntime implements ModuleRuntime<ClaudeUsageSnapshot> {
  #snapshot: ClaudeUsageSnapshot | null = null;
  #activeSource: ActiveSource = 'none';
  #cli: ClaudeCliDetection | null = null;
  #lastApiFetchAt = 0;
  #lastError: { code: string; message: string } | null = null;
  readonly #usageClient: AnthropicUsageClient;

  constructor(private readonly ctx: ModuleContext<ClaudeUsageSettings>) {
    this.#usageClient = new AnthropicUsageClient(ctx.http);
  }

  async start(): Promise<void> {
    // Detection is best-effort at start: a Docker deployment legitimately has no CLI.
    this.#cli = await this.detectCli().catch(() => null);
  }

  async stop(): Promise<void> {
    // No long-lived resources; the bridge pushes to the server, not to this runtime.
  }

  getSnapshot(): ClaudeUsageSnapshot | null {
    return this.#snapshot;
  }

  hydrate(snapshot: unknown): void {
    if (isClaudeSnapshot(snapshot)) {
      this.#snapshot = snapshot;
      this.#activeSource = isLocalRateLimitSource(snapshot.source) ? 'local' : 'api';
    }
  }

  async refresh(reason: RefreshReason, signal: AbortSignal): Promise<ClaudeUsageSnapshot> {
    const settings = this.ctx.settings;
    this.#lastError = null;

    const wantsLocal = settings.source === 'auto' || settings.source === 'local-claude-code';
    if (wantsLocal) {
      const local = await this.readLocalSnapshot(signal);
      if (local) {
        this.transitionSource('local');
        this.#snapshot = local;
        return local;
      }
    }

    const wantsApi =
      settings.source === 'anthropic-usage-api' ||
      (settings.source === 'auto' &&
        (settings.allowApiFallback || !(await this.claudeAvailable())));

    if (wantsApi) {
      const apiSnapshot = await this.readApiSnapshot(reason, signal);
      if (apiSnapshot) {
        this.transitionSource('api');
        this.#snapshot = apiSnapshot;
        return apiSnapshot;
      }
    }

    // Nothing usable. Keep any previous snapshot so the display can mark it stale
    // rather than losing the last known state entirely.
    if (this.#snapshot) return this.#snapshot;

    if (wantsLocal) {
      // Having no reading yet is a state, not a failure. The bridge inbox lives in
      // memory, so it is empty after every restart until Claude Code next renders a
      // status line — throwing here drove the instance into the crash backoff on
      // each poll and delayed the pickup once data did arrive. `getHealth` still
      // reports precisely what is missing, through `resolveSetupState`.
      return {
        source: 'claude-code-statusline',
        capturedAt: nowIso(),
        claudeCodeVersion: this.#cli?.version ?? null,
        modelDisplayName: null,
        fiveHour: null,
        sevenDay: null,
        spendLimit: null,
        sessionCostUsd: null,
        pending: true,
      };
    }

    throw new AppError(
      'ANTHROPIC_USAGE_UNAVAILABLE',
      'No organization usage credential is configured.',
    );
  }

  async getFrames(ctx: FrameContext): Promise<ModuleFrameDraft[]> {
    const setupState = await this.resolveSetupState();
    // A pending snapshot carries no numbers, so it must not reach the frame builder
    // as if it did.
    const snapshot = isPendingSnapshot(this.#snapshot) ? null : this.#snapshot;
    return buildClaudeFrames({
      snapshot: setupState ? null : snapshot,
      settings: this.ctx.settings,
      ctx,
      stale: this.isStale(ctx.now),
      setupState,
    });
  }

  async getHealth(): Promise<ModuleHealth> {
    if (this.#lastError) {
      return { status: 'error', message: this.#lastError.message, code: this.#lastError.code };
    }
    const setupState = await this.resolveSetupState();
    if (setupState) {
      return {
        status: setupState.waiting ? 'degraded' : 'error',
        message: setupState.detail,
        ...(setupState.code ? { code: setupState.code } : {}),
      };
    }
    if (!this.#snapshot) return { status: 'unknown', message: 'No usage data yet.' };
    if (isPendingSnapshot(this.#snapshot)) {
      return { status: 'unknown', message: 'No usage data yet.' };
    }
    if (this.isStale(this.ctx.now())) {
      return {
        status: 'degraded',
        message: `Last update ${ageSeconds(this.#snapshot.capturedAt, this.ctx.now())}s ago.`,
      };
    }
    return {
      status: 'healthy',
      message:
        this.#snapshot.source === 'claude-code-statusline'
          ? 'Receiving Claude Code status-line updates.'
          : this.#snapshot.source === 'claude-code-cli'
            ? 'Reading usage from the local Claude Code CLI.'
            : 'Organization usage reporting is available.',
    };
  }

  async getStatusPanel(): Promise<ModuleActionResult['panel'] | null> {
    const cli = this.#cli ?? (await this.detectCli().catch(() => null));
    const bridge = await this.ctx.host.claudeSettings?.inspect().catch(() => null);
    const latest = await this.ctx.host.bridgeInbox?.latest().catch(() => null);
    const secretConfigured = await this.ctx.secrets.has(ADMIN_API_KEY_SECRET);

    const windowsPresent = latest
      ? [latest.fiveHour ? '5H' : null, latest.sevenDay ? '7D' : null].filter(Boolean).join(', ')
      : '';

    return {
      title: 'Local Claude Code',
      rows: [
        {
          label: 'Claude binary',
          value: cli?.found ? (cli.binaryPath ?? 'found') : 'not found',
          tone: cli?.found ? 'good' : 'warn',
          ...(cli?.found
            ? {}
            : {
                hint: 'The host-side bridge can still forward data if the service runs elsewhere.',
              }),
        },
        { label: 'Version', value: cli?.version ?? '—' },
        {
          label: 'Logged in',
          value: cli?.authenticated === null ? 'unknown' : cli?.authenticated ? 'yes' : 'no',
          tone: cli?.authenticated ? 'good' : 'warn',
        },
        {
          label: 'Bridge',
          value: bridge?.installed ? 'installed' : 'not installed',
          tone: bridge?.installed ? 'good' : 'warn',
          ...(bridge?.chainedCommand ? { hint: `Chaining: ${bridge.chainedCommand}` } : {}),
        },
        {
          label: 'Last payload',
          value: latest ? `${ageSeconds(latest.receivedAt, this.ctx.now())}s ago` : 'never',
          tone: latest ? 'good' : 'warn',
        },
        { label: 'Payload version', value: latest?.claudeCodeVersion ?? '—' },
        {
          label: 'Rate-limit windows',
          value: latest ? windowsPresent || 'none present' : '—',
          tone: windowsPresent ? 'good' : 'warn',
          ...(latest && !windowsPresent
            ? { hint: 'Claude Code reports these only after an API response in an active session.' }
            : {}),
        },
        {
          label: 'Usage credential',
          value: secretConfigured ? 'configured' : 'not configured',
          tone: secretConfigured ? 'good' : 'neutral',
        },
      ],
    };
  }

  async runAction(
    actionId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ModuleActionResult> {
    switch (actionId) {
      case 'claude.detectLocalCli':
        return this.actionDetect();
      case 'claude.installBridge':
        return this.actionInstallBridge();
      case 'claude.uninstallBridge':
        return this.actionUninstallBridge();
      case 'claude.testCredential':
        return this.actionTestCredential(input, signal);
      default:
        throw new AppError('MODULE_ACTION_UNKNOWN', `Unknown action "${actionId}".`);
    }
  }

  private async actionDetect(): Promise<ModuleActionResult> {
    const cli = await this.detectCli();
    this.#cli = cli;
    return {
      ok: cli.found,
      message: cli.found
        ? cli.authenticated
          ? `Claude Code ${cli.version ?? ''} found and authenticated.`.trim()
          : 'Claude Code found, but it is not logged in. Run `claude` and sign in first.'
        : 'Claude Code was not found in this process PATH. If the service runs in Docker or under another account, install the bridge on the host instead.',
      code: cli.found
        ? cli.authenticated
          ? undefined
          : 'CLAUDE_NOT_AUTHENTICATED'
        : 'CLAUDE_CLI_NOT_FOUND',
      data: { found: cli.found, version: cli.version, authenticated: cli.authenticated },
      panel: (await this.getStatusPanel()) ?? undefined,
    };
  }

  private async actionInstallBridge(): Promise<ModuleActionResult> {
    const service = this.ctx.host.claudeSettings;
    if (!service) {
      return {
        ok: false,
        message:
          'Bridge installation is not available in this deployment. Install it on the host with `gca-claude-bridge install`.',
        code: 'CLAUDE_BRIDGE_INSTALL_FAILED',
      };
    }
    try {
      const state = await service.install();
      return {
        ok: true,
        message: state.chainedCommand
          ? `Bridge installed. Your existing status line is preserved and will keep rendering: ${state.chainedCommand}`
          : 'Bridge installed. Usage will appear after Claude Code makes its next request.',
        data: { settingsPath: state.settingsPath, backupPath: state.backupPath },
        panel: (await this.getStatusPanel()) ?? undefined,
      };
    } catch (error) {
      const appError = toAppError(error, 'Bridge installation failed');
      return { ok: false, message: appError.message, code: appError.code };
    }
  }

  private async actionUninstallBridge(): Promise<ModuleActionResult> {
    const service = this.ctx.host.claudeSettings;
    if (!service) {
      return {
        ok: false,
        message: 'Bridge management is not available in this deployment.',
        code: 'CLAUDE_BRIDGE_INSTALL_FAILED',
      };
    }
    try {
      const state = await service.uninstall();
      return {
        ok: !state.installed,
        message: state.conflict
          ? `The status line was changed after installation, so it was left alone: ${state.conflict}`
          : 'Bridge removed and the previous status line restored.',
        ...(state.conflict ? { code: 'CONFLICT' } : {}),
        panel: (await this.getStatusPanel()) ?? undefined,
      };
    } catch (error) {
      const appError = toAppError(error, 'Bridge removal failed');
      return { ok: false, message: appError.message, code: appError.code };
    }
  }

  private async actionTestCredential(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ModuleActionResult> {
    const provided = (input as { adminApiKey?: unknown } | null)?.adminApiKey;
    const apiKey =
      typeof provided === 'string' && provided.trim() !== ''
        ? provided.trim()
        : await this.ctx.secrets.get(ADMIN_API_KEY_SECRET);

    if (!apiKey) {
      return {
        ok: false,
        message: 'Enter an organization usage credential first.',
        code: 'ANTHROPIC_USAGE_CREDENTIAL_INVALID',
      };
    }

    const result = await this.#usageClient.validateCredential(apiKey, signal);
    return {
      ok: result.ok,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      panel: {
        title: 'Credential check',
        rows: [
          {
            label: 'Organization usage access',
            value: result.ok ? 'authorized' : 'denied',
            tone: result.ok ? 'good' : 'bad',
          },
          {
            label: 'Note',
            value: result.ok
              ? 'No paid model call was made.'
              : 'Subscription limits still work through local Claude Code mode.',
          },
        ],
      },
    };
  }

  private async readLocalSnapshot(signal?: AbortSignal): Promise<ClaudeRateLimitSnapshot | null> {
    const payload = await this.ctx.host.bridgeInbox?.latest();
    // The inbox is in-memory, so it is empty after every restart until Claude Code
    // next renders a status line. Asking the CLI directly covers that gap, and is
    // the only local source at all when the bridge was never installed.
    if (!payload || (!payload.fiveHour && !payload.sevenDay && !payload.spendLimit)) {
      return this.readCliSnapshot(signal);
    }

    return {
      source: 'claude-code-statusline',
      capturedAt: payload.receivedAt,
      claudeCodeVersion: payload.claudeCodeVersion,
      modelDisplayName: payload.modelDisplayName,
      fiveHour: payload.fiveHour,
      sevenDay: payload.sevenDay,
      spendLimit: payload.spendLimit,
      sessionCostUsd: payload.sessionCostUsd,
    };
  }

  /**
   * Reads usage from the local CLI as a fallback for the bridge.
   *
   * Costs no tokens — `/usage` is answered locally by Claude Code — so this is safe
   * to reach for on every refresh that the bridge could not satisfy.
   */
  private async readCliSnapshot(signal?: AbortSignal): Promise<ClaudeRateLimitSnapshot | null> {
    const reading = await this.ctx.host.claudeCli?.readUsage?.(signal).catch(() => null);
    if (!reading) return null;
    if (!reading.fiveHour && !reading.sevenDay) return null;

    return {
      source: 'claude-code-cli',
      capturedAt: reading.fetchedAt,
      claudeCodeVersion: this.#cli?.version ?? null,
      modelDisplayName: null,
      fiveHour: reading.fiveHour,
      sevenDay: reading.sevenDay,
      spendLimit: null,
      sessionCostUsd: null,
    };
  }

  private async readApiSnapshot(
    reason: RefreshReason,
    signal: AbortSignal,
  ): Promise<ClaudeUsageSnapshot | null> {
    const apiKey = await this.ctx.secrets.get(ADMIN_API_KEY_SECRET);
    if (!apiKey) return null;

    const elapsed = Date.now() - this.#lastApiFetchAt;
    if (reason !== 'manual' && this.#lastApiFetchAt > 0 && elapsed < MIN_API_POLL_INTERVAL_MS) {
      // Honour Anthropic's documented polling guidance even if the module's refresh
      // interval is configured lower.
      return this.#snapshot?.source === 'anthropic-usage-api' ? this.#snapshot : null;
    }

    try {
      const snapshot = await this.#usageClient.fetchSnapshot({
        apiKey,
        windowDays: this.ctx.settings.usageWindowDays,
        now: this.ctx.now(),
        signal,
      });
      this.#lastApiFetchAt = Date.now();
      return snapshot;
    } catch (error) {
      const appError = toAppError(error, 'Organization usage request failed');
      this.#lastError = { code: appError.code, message: appError.message };
      this.ctx.logger.warn({ code: appError.code }, 'Organization usage request failed');
      // Credential problems are terminal for this source; transient ones are not.
      if (
        appError.code === 'ANTHROPIC_USAGE_CREDENTIAL_INVALID' ||
        appError.code === 'ANTHROPIC_USAGE_FORBIDDEN'
      ) {
        throw appError;
      }
      return null;
    }
  }

  private async resolveSetupState(): Promise<ClaudeFrameSetupState | null> {
    // A pending placeholder is not a reading, so it must not silence the guidance
    // that says what is still missing.
    if (this.#snapshot && !isPendingSnapshot(this.#snapshot)) return null;
    const settings = this.ctx.settings;

    if (this.#lastError) {
      return {
        headline: 'Usage unavailable',
        detail: this.#lastError.message,
        code: this.#lastError.code,
        waiting: false,
      };
    }

    const hasCredential = await this.ctx.secrets.has(ADMIN_API_KEY_SECRET);
    if (settings.source === 'anthropic-usage-api' && !hasCredential) {
      return {
        headline: 'Setup required',
        detail: 'Add an organization usage credential in module settings',
        code: 'ANTHROPIC_USAGE_CREDENTIAL_INVALID',
        waiting: false,
      };
    }

    const cli = this.#cli ?? (await this.detectCli().catch(() => null));
    const bridge = await this.ctx.host.claudeSettings?.inspect().catch(() => null);

    // Authenticated but quiet is the common, expected state: say so plainly rather
    // than implying something is broken.
    if (cli?.found && cli.authenticated && bridge?.installed) {
      return {
        headline: 'Waiting for Claude',
        detail: 'Usage appears after Claude Code makes a request',
        waiting: true,
      };
    }
    if (cli?.found && cli.authenticated && !bridge?.installed) {
      return {
        headline: 'Bridge not installed',
        detail: 'Install the status-line bridge to forward usage to this service',
        code: 'CLAUDE_BRIDGE_NOT_CONNECTED',
        waiting: false,
      };
    }
    if (cli?.found && cli.authenticated === false) {
      return {
        headline: 'Claude not signed in',
        detail: 'Run claude and sign in, then install the bridge',
        code: 'CLAUDE_NOT_AUTHENTICATED',
        waiting: false,
      };
    }
    if (hasCredential) {
      return {
        headline: 'Setup required',
        detail: 'Waiting for the first organization usage response',
        code: 'CLAUDE_BRIDGE_NOT_CONNECTED',
        waiting: true,
      };
    }

    // No local Claude Code at all. In a container that is expected rather than
    // wrong — the bridge runs on the host, where this process cannot see it — so
    // do not claim the bridge is missing when it may be installed and merely
    // rejected. `gca-claude-bridge doctor` is the thing that can actually tell.
    return {
      headline: 'No usage received',
      detail: bridge?.installed
        ? 'Install the status-line bridge or add a usage credential'
        : 'Run: gca-claude-bridge doctor',
      code: 'CLAUDE_BRIDGE_NOT_CONNECTED',
      waiting: false,
    };
  }

  private async claudeAvailable(): Promise<boolean> {
    const cli = this.#cli ?? (await this.detectCli().catch(() => null));
    return Boolean(cli?.found && cli.authenticated);
  }

  private async detectCli(): Promise<ClaudeCliDetection> {
    const service = this.ctx.host.claudeCli;
    if (!service) {
      return {
        found: false,
        binaryPath: null,
        version: null,
        authenticated: null,
        detail: 'Local CLI detection is not available in this deployment.',
      };
    }
    return service.detect();
  }

  private transitionSource(next: ActiveSource): void {
    if (this.#activeSource === next) return;
    this.ctx.logger.info({ from: this.#activeSource, to: next }, 'Claude usage source changed');
    this.#activeSource = next;
    this.ctx.events.requestDisplayRefresh('claude source changed');
  }

  private isStale(now: Date): boolean {
    if (!this.#snapshot) return false;
    return ageSeconds(this.#snapshot.capturedAt, now) > this.ctx.settings.staleAfterMinutes * 60;
  }
}

interface ClaudeFrameSetupState {
  headline: string;
  detail: string;
  code?: string;
  waiting: boolean;
}

export const claudeUsageModule: AppModule<ClaudeUsageSettings, ClaudeUsageSnapshot> = {
  manifest: claudeUsageManifest,
  settingsSchema: CLAUDE_SETTINGS_SCHEMA,
  uiSchema: CLAUDE_UI_SCHEMA,
  defaultSettings: CLAUDE_DEFAULT_SETTINGS,
  secretKeys: [ADMIN_API_KEY_SECRET],

  async validateSettings(
    settings: unknown,
    ctx: ValidationContext,
  ): Promise<ValidationResult<ClaudeUsageSettings>> {
    const value = { ...CLAUDE_DEFAULT_SETTINGS, ...(settings as Partial<ClaudeUsageSettings>) };
    const errors: Array<{ path: string; message: string }> = [];

    if (value.source === 'anthropic-usage-api' && !ctx.secretConfigured(ADMIN_API_KEY_SECRET)) {
      errors.push({
        path: `/${ADMIN_API_KEY_SECRET}`,
        message: 'Organization usage mode needs a credential authorized for usage reporting.',
      });
    }
    if (value.usageWindowDays < 1 || value.usageWindowDays > 31) {
      errors.push({
        path: '/usageWindowDays',
        message: 'The reporting window must be between 1 and 31 days.',
      });
    }
    if (errors.length > 0) return { ok: false, errors };

    const warnings: string[] = [];
    if (value.displayMode === 'api-cost' && !ctx.secretConfigured(ADMIN_API_KEY_SECRET)) {
      warnings.push('API cost mode will show a setup frame until a usage credential is added.');
    }
    if (value.source === 'local-claude-code' && value.displayMode === 'api-cost') {
      warnings.push('Local Claude Code mode reports subscription percentages, not API cost.');
    }
    return { ok: true, value, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async migrateSettings(fromVersion: number, settings: unknown) {
    return { version: Math.max(1, fromVersion), settings };
  },

  createRuntime(ctx) {
    return new ClaudeUsageRuntime(ctx);
  },

  snapshotIsValid: isClaudeSnapshot,
};

function isClaudeSnapshot(value: unknown): value is ClaudeUsageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const source = (value as { source?: unknown }).source;
  return isLocalRateLimitSource(source) || source === 'anthropic-usage-api';
}
