import { describe, expect, it, vi } from 'vitest';
import type { BridgePayload, FrameContext, ModuleContext } from '@gca/module-sdk';
import { claudeUsageModule } from '../src/module.js';
import { CLAUDE_DEFAULT_SETTINGS, type ClaudeUsageSettings } from '../src/settings.js';

const NOW = new Date('2026-09-21T17:30:00Z');

const frameCtx: FrameContext = { now: NOW, timezone: 'UTC', accent: 'purple' };

/**
 * A payload that arrived carrying no usage windows.
 *
 * This is what a container sees constantly: Claude Code posts on render but only
 * includes `rate_limits` during an active session, and the host pusher posts whatever
 * the local CLI last cached.
 */
function emptyPayload(): BridgePayload {
  return {
    receivedAt: NOW.toISOString(),
    claudeCodeVersion: '2.1.263',
    sessionKey: 'hashed',
    modelId: null,
    modelDisplayName: null,
    fiveHour: null,
    sevenDay: null,
    spendLimit: null,
    sessionCostUsd: null,
  };
}

/** A containerised server: no local CLI, and no host settings file to inspect. */
function createContext(options: { payload?: BridgePayload | null } = {}) {
  return {
    instanceId: 'mod_test',
    moduleId: 'claude-usage',
    instanceName: 'Claude Usage',
    settings: { ...CLAUDE_DEFAULT_SETTINGS } satisfies ClaudeUsageSettings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { request: vi.fn() },
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
      // No `claude` binary and no ~/.claude/settings.json exist inside the container.
      claudeCli: undefined,
      claudeSettings: undefined,
      bridgeInbox: { latest: async () => options.payload ?? null },
    },
  } as unknown as ModuleContext<ClaudeUsageSettings>;
}

describe('containerised server with a working bridge', () => {
  it('says it is waiting once a payload has arrived, rather than calling the bridge broken', async () => {
    const runtime = claudeUsageModule.createRuntime(createContext({ payload: emptyPayload() }));
    await runtime.refresh('scheduled', new AbortController().signal).catch(() => undefined);

    const [frame] = await runtime.getFrames(frameCtx);

    expect(frame?.layout.kind).toBe('empty');
    if (frame?.layout.kind !== 'empty') throw new Error('expected the waiting frame');
    expect(frame.layout.headline).toBe('Waiting for data');
    expect(frame.layout.detail).toContain('Bridge connected');
  });

  it('is degraded, not errored, while it waits', async () => {
    const runtime = claudeUsageModule.createRuntime(createContext({ payload: emptyPayload() }));
    await runtime.refresh('scheduled', new AbortController().signal).catch(() => undefined);

    await expect(runtime.getHealth()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('still reports a real problem when nothing has ever arrived', async () => {
    const runtime = claudeUsageModule.createRuntime(createContext({ payload: null }));
    await runtime.refresh('scheduled', new AbortController().signal).catch(() => undefined);

    const [frame] = await runtime.getFrames(frameCtx);

    // Not a waiting frame: with no CLI, no settings file and nothing delivered, the
    // operator genuinely has to go and look.
    expect(frame?.layout.kind).toBe('error');
    if (frame?.layout.kind !== 'error') throw new Error('expected the setup frame');
    expect(frame.layout.headline).toBe('No usage received');
    expect(frame.layout.code).toBe('CLAUDE_BRIDGE_NOT_CONNECTED');
  });
});
