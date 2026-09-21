import { describe, expect, it, vi } from 'vitest';
import { AppError, type DeviceCapabilities } from '@gca/shared';
import { DeviceUploadQueue } from '../src/upload-queue.js';
import type { DeviceAdapter, EncodedFrameInput, UploadResult } from '../src/adapters/types.js';

const capabilities: DeviceCapabilities = {
  canUploadImage: true,
  canSetBrightness: true,
  canListFiles: false,
  canDeleteFiles: false,
  requiresAlbumManagement: false,
  canReadState: true,
  supportsBackup: false,
  notes: [],
};

interface FakeAdapterOptions {
  failTimes?: number;
  error?: AppError;
  onUpload?: () => void;
}

function fakeAdapter(options: FakeAdapterOptions = {}) {
  let failsRemaining = options.failTimes ?? 0;
  const uploads: EncodedFrameInput[] = [];
  const prepares: number[] = [];

  const adapter: DeviceAdapter = {
    profile: 'stock-ultra',
    capabilities,
    probe: async () => {
      throw new Error('not used');
    },
    getState: async () => ({
      reachable: true,
      themeId: 3,
      brightness: 50,
      currentImage: null,
      raw: {},
    }),
    getBrightness: async () => 50,
    setBrightness: async () => undefined,
    prepareManagedDisplay: async () => {
      prepares.push(Date.now());
    },
    uploadFrame: async (frame): Promise<UploadResult> => {
      if (failsRemaining > 0) {
        failsRemaining -= 1;
        throw options.error ?? new AppError('DEVICE_UPLOAD_FAILED', 'boom', { retryable: true });
      }
      options.onUpload?.();
      uploads.push(frame);
      return { uploaded: true, verified: true, filename: 'dashboard.jpg', durationMs: 1 };
    },
    verifyFrame: async () => ({ present: true, detail: 'ok' }),
  };

  return { adapter, uploads, prepares };
}

function frame(id: string, sha = id) {
  return {
    frameId: id,
    viewId: 'v',
    frame: { bytes: Buffer.from(sha), sha256: sha, contentType: 'image/jpeg' },
    priority: 'normal' as const,
    albumManagementConsent: true,
  };
}

describe('DeviceUploadQueue', () => {
  it('skips an upload when the encoded bytes are unchanged', async () => {
    const { adapter, uploads } = fakeAdapter();
    const queue = new DeviceUploadQueue({ deviceId: 'd1', adapter, minimumIntervalMs: 0 });

    const first = await queue.enqueue(frame('a', 'sha-1'));
    const second = await queue.enqueue(frame('b', 'sha-1'));

    expect(first.status).toBe('uploaded');
    expect(second.status).toBe('skipped-unchanged');
    expect(uploads).toHaveLength(1);
  });

  it('still uploads unchanged bytes when force is set', async () => {
    const { adapter, uploads } = fakeAdapter();
    const queue = new DeviceUploadQueue({ deviceId: 'd1', adapter, minimumIntervalMs: 0 });

    await queue.enqueue(frame('a', 'sha-1'));
    const forced = await queue.enqueue({ ...frame('b', 'sha-1'), force: true });

    expect(forced.status).toBe('uploaded');
    expect(uploads).toHaveLength(2);
  });

  it('honours a previously uploaded hash restored from the database', async () => {
    const { adapter, uploads } = fakeAdapter();
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter,
      minimumIntervalMs: 0,
      lastUploadedSha256: 'sha-restored',
    });

    const outcome = await queue.enqueue(frame('a', 'sha-restored'));

    expect(outcome.status).toBe('skipped-unchanged');
    expect(uploads).toHaveLength(0);
  });

  it('coalesces queued frames so only the newest is sent', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, uploads } = fakeAdapter({
      onUpload: () => undefined,
    });
    const slowAdapter: DeviceAdapter = {
      ...adapter,
      uploadFrame: async (input) => {
        await gate;
        return adapter.uploadFrame(input);
      },
    };

    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter: slowAdapter,
      minimumIntervalMs: 0,
    });

    const first = queue.enqueue(frame('first', 'sha-1'));
    const second = queue.enqueue(frame('second', 'sha-2'));
    const third = queue.enqueue(frame('third', 'sha-3'));

    release?.();
    const [firstOutcome, secondOutcome, thirdOutcome] = await Promise.all([first, second, third]);

    expect(firstOutcome.status).toBe('uploaded');
    // The middle frame is superseded by the newest one rather than being sent.
    expect(secondOutcome.status).toBe('skipped-superseded');
    expect(thirdOutcome.status).toBe('uploaded');
    expect(uploads.map((upload) => upload.sha256)).toEqual(['sha-1', 'sha-3']);
  });

  it('does not let a normal frame displace a pending attention frame', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter } = fakeAdapter();
    const slowAdapter: DeviceAdapter = {
      ...adapter,
      uploadFrame: async (input) => {
        await gate;
        return adapter.uploadFrame(input);
      },
    };
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter: slowAdapter,
      minimumIntervalMs: 0,
    });

    const inflight = queue.enqueue(frame('busy', 'sha-0'));
    const attention = queue.enqueue({ ...frame('alert', 'sha-1'), priority: 'attention' });
    const routine = queue.enqueue(frame('routine', 'sha-2'));

    release?.();
    const [, attentionOutcome, routineOutcome] = await Promise.all([inflight, attention, routine]);

    expect(routineOutcome.status).toBe('skipped-superseded');
    expect(attentionOutcome.status).toBe('uploaded');
  });

  it('retries retryable failures with backoff and eventually succeeds', async () => {
    const waits: number[] = [];
    const { adapter, uploads } = fakeAdapter({ failTimes: 2 });
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter,
      minimumIntervalMs: 0,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const outcome = await queue.enqueue(frame('a', 'sha-1'));

    expect(outcome.status).toBe('uploaded');
    expect(uploads).toHaveLength(1);
    expect(waits).toHaveLength(2);
    // Jittered around the 2s and 5s steps.
    expect(waits[0]).toBeGreaterThanOrEqual(1_600);
    expect(waits[0]).toBeLessThanOrEqual(2_400);
    expect(waits[1]).toBeGreaterThanOrEqual(4_000);
    expect(waits[1]).toBeLessThanOrEqual(6_000);
  });

  it('does not retry non-retryable errors', async () => {
    const waits: number[] = [];
    const { adapter } = fakeAdapter({
      failTimes: 5,
      error: new AppError('DEVICE_PROFILE_UNSUPPORTED', 'nope', { retryable: false }),
    });
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter,
      minimumIntervalMs: 0,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const outcome = await queue.enqueue(frame('a', 'sha-1'));

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('DEVICE_PROFILE_UNSUPPORTED');
      expect(outcome.attempts).toBe(1);
    }
    expect(waits).toHaveLength(0);
  });

  it('enforces the minimum interval between successful writes', async () => {
    const waits: number[] = [];
    let clock = 1_000_000;
    const { adapter } = fakeAdapter();
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter,
      minimumIntervalMs: 15_000,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });

    await queue.enqueue(frame('a', 'sha-1'));
    clock += 3_000;
    await queue.enqueue(frame('b', 'sha-2'));

    // 15s required, 3s elapsed, so 12s of waiting.
    expect(waits).toEqual([12_000]);
  });

  it('serializes writes so two frames never upload concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const { adapter } = fakeAdapter();
    const trackingAdapter: DeviceAdapter = {
      ...adapter,
      uploadFrame: async (input) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return adapter.uploadFrame(input);
      },
    };
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter: trackingAdapter,
      minimumIntervalMs: 0,
    });

    await Promise.all([
      queue.enqueue(frame('a', 'sha-1')),
      queue.enqueue(frame('b', 'sha-2')),
      queue.enqueue(frame('c', 'sha-3')),
    ]);
    await queue.idle();

    expect(peak).toBe(1);
  });

  it('emits lifecycle events for observability', async () => {
    const events: string[] = [];
    const { adapter } = fakeAdapter({ failTimes: 1 });
    const queue = new DeviceUploadQueue({
      deviceId: 'd1',
      adapter,
      minimumIntervalMs: 0,
      wait: async () => undefined,
      onEvent: (event) => events.push(event.type),
    });

    await queue.enqueue(frame('a', 'sha-1'));

    expect(events).toEqual(['upload-start', 'upload-retry', 'upload-start', 'upload-success']);
  });

  it('stops cleanly and rejects further work', async () => {
    const { adapter } = fakeAdapter();
    const queue = new DeviceUploadQueue({ deviceId: 'd1', adapter, minimumIntervalMs: 0 });
    queue.stop();

    const outcome = await queue.enqueue(frame('a', 'sha-1'));
    expect(outcome.status).toBe('failed');
  });

  it('prepares managed display before each upload attempt', async () => {
    const { adapter, prepares } = fakeAdapter();
    const spy = vi.spyOn(adapter, 'prepareManagedDisplay');
    const queue = new DeviceUploadQueue({ deviceId: 'd1', adapter, minimumIntervalMs: 0 });

    await queue.enqueue(frame('a', 'sha-1'));

    expect(spy).toHaveBeenCalledWith({ albumManagementConsent: true });
    expect(prepares).toHaveLength(1);
  });
});
