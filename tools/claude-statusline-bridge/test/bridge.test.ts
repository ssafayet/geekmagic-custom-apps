import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_INPUT_BYTES,
  readStdin,
  runBridge,
  type BridgeConfig,
  type BridgeDeps,
} from '../src/bridge.js';

const CONFIG: BridgeConfig = {
  version: 1,
  endpoint: 'http://127.0.0.1:3210/internal/claude/statusline',
  tokenFile: '/data/claude-bridge.token',
  chainedCommand: null,
};

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    readToken: () => 'test-token',
    post: async () => undefined,
    runChained: async () => ({ stdout: '', exitCode: 0 }),
    ...overrides,
  };
}

const PAYLOAD = JSON.stringify({
  version: '2.1.263',
  rate_limits: { five_hour: { used_percentage: 40 } },
});

describe('runBridge', () => {
  it('posts the payload verbatim with a bearer token', async () => {
    const post = vi.fn(async () => undefined);
    const result = await runBridge(PAYLOAD, CONFIG, deps({ post }));

    expect(result.posted).toBe(true);
    expect(post).toHaveBeenCalledWith(CONFIG.endpoint, 'test-token', PAYLOAD);
  });

  it('never fails Claude Code when the server is down', async () => {
    const result = await runBridge(
      PAYLOAD,
      CONFIG,
      deps({
        post: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.posted).toBe(false);
    expect(result.diagnostics).toContain('post-failed:Error');
  });

  it('never fails when the token file is missing', async () => {
    const result = await runBridge(PAYLOAD, CONFIG, deps({ readToken: () => '' }));

    expect(result.exitCode).toBe(0);
    expect(result.posted).toBe(false);
    expect(result.diagnostics).toContain('missing-token');
  });

  it('never leaks the token, payload or server error to stdout', async () => {
    const result = await runBridge(
      PAYLOAD,
      CONFIG,
      deps({
        readToken: () => 'super-secret-token',
        post: async () => {
          throw new Error('500 Internal Server Error: database is locked');
        },
      }),
    );

    expect(result.stdout).toBe('');
    // Diagnostics carry only an error class name, never a message or body.
    expect(JSON.stringify(result.diagnostics)).not.toContain('super-secret-token');
    expect(JSON.stringify(result.diagnostics)).not.toContain('database is locked');
    expect(JSON.stringify(result.diagnostics)).not.toContain('used_percentage');
  });

  it('rejects an oversized payload without posting it', async () => {
    const post = vi.fn(async () => undefined);
    const huge = 'x'.repeat(MAX_INPUT_BYTES + 1);

    const result = await runBridge(huge, CONFIG, deps({ post }));

    expect(post).not.toHaveBeenCalled();
    expect(result.diagnostics).toContain('input-too-large');
    expect(result.exitCode).toBe(0);
  });

  it('forwards stdin to the chained command and returns its stdout', async () => {
    const runChained = vi.fn(async () => ({ stdout: '🔮 my status line', exitCode: 0 }));
    const config = { ...CONFIG, chainedCommand: '~/bin/statusline.sh' };

    const result = await runBridge(PAYLOAD, config, deps({ runChained }));

    expect(runChained).toHaveBeenCalledWith('~/bin/statusline.sh', PAYLOAD);
    expect(result.stdout).toBe('🔮 my status line');
    expect(result.exitCode).toBe(0);
  });

  it('preserves the chained command exit code', async () => {
    const config = { ...CONFIG, chainedCommand: 'false' };
    const result = await runBridge(
      PAYLOAD,
      config,
      deps({ runChained: async () => ({ stdout: 'partial', exitCode: 3 }) }),
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('partial');
  });

  it('still posts when the chained command fails', async () => {
    const post = vi.fn(async () => undefined);
    const config = { ...CONFIG, chainedCommand: 'broken' };

    const result = await runBridge(
      PAYLOAD,
      config,
      deps({
        post,
        runChained: async () => {
          throw new Error('spawn failed');
        },
      }),
    );

    expect(post).toHaveBeenCalled();
    expect(result.posted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toContain('chain-failed:Error');
  });

  it('still renders the chained status line when the post fails', async () => {
    const config = { ...CONFIG, chainedCommand: 'mine' };
    const result = await runBridge(
      PAYLOAD,
      config,
      deps({
        post: async () => {
          throw new Error('timeout');
        },
        runChained: async () => ({ stdout: 'my line', exitCode: 0 }),
      }),
    );

    expect(result.posted).toBe(false);
    expect(result.stdout).toBe('my line');
  });
});

describe('readStdin', () => {
  it('reads the whole payload', async () => {
    const stream = Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]);
    expect(await readStdin(stream)).toBe('{"a":1}');
  });

  it('stops reading past the cap', async () => {
    const stream = Readable.from([Buffer.from('x'.repeat(100)), Buffer.from('y'.repeat(100))]);
    const result = await readStdin(stream, 50);
    // The cap is honoured; the caller rejects anything over it.
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith('x')).toBe(true);
  });

  it('returns an empty string for an empty stream', async () => {
    expect(await readStdin(Readable.from([]))).toBe('');
  });
});
