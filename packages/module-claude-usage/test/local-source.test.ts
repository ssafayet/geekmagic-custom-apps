import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeCliUsageReading,
  ModuleContext,
  ClaudeBridgeInstallState,
  BridgePayload,
} from '@gca/module-sdk';
import { claudeUsageModule } from '../src/module.js';
import { CLAUDE_DEFAULT_SETTINGS, type ClaudeUsageSettings } from '../src/settings.js';
import type { ClaudeRateLimitSnapshot } from '../src/types.js';

const NOW = new Date('2026-09-21T17:30:00Z');

const READING: ClaudeCliUsageReading = {
  fetchedAt: '2026-09-21T17:29:00.000Z',
  fiveHour: { usedPercentage: 5, resetsAt: '2026-09-21T20:10:00.000Z' },
  sevenDay: { usedPercentage: 47, resetsAt: '2026-09-22T09:00:00.000Z' },
};

const INSTALLED: ClaudeBridgeInstallState = {
  installed: true,
  settingsPath: '/home/test/.claude/settings.json',
  chainedCommand: null,
  installedAt: NOW.toISOString(),
  backupPath: null,
  conflict: null,
};

interface HarnessOptions {
  bridgePayload?: BridgePayload | null;
  cliUsage?: ClaudeCliUsageReading | null;
  cliFound?: boolean;
  bridgeInstalled?: boolean;
  settings?: Partial<ClaudeUsageSettings>;
}

function createContext(options: HarnessOptions = {}) {
  const readUsage = vi.fn(async () => options.cliUsage ?? null);
  const context = {
    instanceId: 'mod_test',
    moduleId: 'claude-usage',
    instanceName: 'Claude Usage',
    settings: { ...CLAUDE_DEFAULT_SETTINGS, ...options.settings },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch: vi.fn() },
    secrets: { get: async () => null, has: async () => false },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    events: {
      requestDisplayRefresh: vi.fn(),
      requestAttention: vi.fn(),
      releaseAttention: vi.fn(),
      reportHealth: vi.fn(),
    },
    now: () => NOW,
    host: {
      claudeCli: {
        detect: async () => ({
          found: options.cliFound ?? true,
          binaryPath: '/usr/local/bin/claude',
          version: '2.1.263',
          authenticated: options.cliFound ?? true,
          detail: 'ok',
        }),
        readUsage,
      },
      claudeSettings: {
        inspect: async () => ({ ...INSTALLED, installed: options.bridgeInstalled ?? true }),
        install: async () => INSTALLED,
        uninstall: async () => INSTALLED,
      },
      bridgeInbox: { latest: async () => options.bridgePayload ?? null },
    },
  } as unknown as ModuleContext<ClaudeUsageSettings>;

  return { context, readUsage };
}

function bridgePayload(): BridgePayload {
  return {
    receivedAt: NOW.toISOString(),
    claudeCodeVersion: '2.1.263',
    sessionKey: 'hashed',
    modelId: 'claude-opus-5',
    modelDisplayName: 'Claude Opus 5',
    fiveHour: { usedPercentage: 12, resetsAt: '2026-09-21T20:10:00.000Z' },
    sevenDay: null,
    spendLimit: null,
    sessionCostUsd: 1.5,
  };
}

describe('local usage sources', () => {
  it('prefers the bridge payload when one has arrived', async () => {
    const { context, readUsage } = createContext({
      bridgePayload: bridgePayload(),
      cliUsage: READING,
    });
    const runtime = claudeUsageModule.createRuntime(context);

    const snapshot = (await runtime.refresh(
      'scheduled',
      new AbortController().signal,
    )) as ClaudeRateLimitSnapshot;

    expect(snapshot.source).toBe('claude-code-statusline');
    expect(snapshot.fiveHour?.usedPercentage).toBe(12);
    // The CLI is a fallback, not a supplement: no process is spawned when the
    // bridge already answered.
    expect(readUsage).not.toHaveBeenCalled();
  });

  it('falls back to the CLI when the inbox is empty, as it is after a restart', async () => {
    const { context, readUsage } = createContext({ bridgePayload: null, cliUsage: READING });
    const runtime = claudeUsageModule.createRuntime(context);

    const snapshot = (await runtime.refresh(
      'scheduled',
      new AbortController().signal,
    )) as ClaudeRateLimitSnapshot;

    expect(readUsage).toHaveBeenCalledOnce();
    expect(snapshot.source).toBe('claude-code-cli');
    expect(snapshot.fiveHour?.usedPercentage).toBe(5);
    expect(snapshot.sevenDay?.usedPercentage).toBe(47);
    expect(snapshot.pending).toBeUndefined();

    await expect(runtime.getHealth()).resolves.toMatchObject({ status: 'healthy' });
  });

  // Throwing here previously counted against the crash backoff on every poll,
  // which after a restart is guaranteed: the inbox is in memory.
  it('reports a pending snapshot instead of throwing when no source answers', async () => {
    const { context } = createContext({ bridgePayload: null, cliUsage: null });
    const runtime = claudeUsageModule.createRuntime(context);

    const snapshot = (await runtime.refresh(
      'scheduled',
      new AbortController().signal,
    )) as ClaudeRateLimitSnapshot;

    expect(snapshot.pending).toBe(true);
    expect(snapshot.fiveHour).toBeNull();
    expect(snapshot.sevenDay).toBeNull();
  });

  it('does not call a pending snapshot healthy', async () => {
    const { context } = createContext({ bridgePayload: null, cliUsage: null });
    const runtime = claudeUsageModule.createRuntime(context);
    await runtime.refresh('scheduled', new AbortController().signal);

    const health = await runtime.getHealth();

    expect(health.status).not.toBe('healthy');
  });

  it('keeps a real reading when a later poll finds nothing', async () => {
    const { context } = createContext({ bridgePayload: null, cliUsage: READING });
    const runtime = claudeUsageModule.createRuntime(context);
    await runtime.refresh('scheduled', new AbortController().signal);

    // The CLI stops answering; the previous numbers must survive rather than being
    // replaced by a pending placeholder.
    (context.host.claudeCli as { readUsage: () => Promise<null> }).readUsage = async () => null;
    const second = (await runtime.refresh(
      'scheduled',
      new AbortController().signal,
    )) as ClaudeRateLimitSnapshot;

    expect(second.pending).toBeUndefined();
    expect(second.fiveHour?.usedPercentage).toBe(5);
  });
});
