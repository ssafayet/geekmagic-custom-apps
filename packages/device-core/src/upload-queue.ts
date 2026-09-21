import { AppError, sleep, toAppError } from '@gca/shared';
import type { DeviceAdapter, EncodedFrameInput, UploadResult } from './adapters/types.js';

export interface UploadRequest {
  frameId: string;
  viewId: string;
  frame: EncodedFrameInput;
  priority: 'normal' | 'attention' | 'urgent';
  /** Bypasses the unchanged-bytes check, for a user-triggered "render now". */
  force?: boolean;
  albumManagementConsent: boolean;
}

export type UploadOutcome =
  | { status: 'uploaded'; result: UploadResult; sha256: string }
  | { status: 'skipped-unchanged'; sha256: string }
  | { status: 'skipped-superseded' }
  | { status: 'failed'; error: AppError; attempts: number };

export interface UploadQueueOptions {
  deviceId: string;
  adapter: DeviceAdapter;
  /** Minimum gap between successful writes. Protects device flash. */
  minimumIntervalMs: number;
  lastUploadedSha256?: string | null;
  maxAttempts?: number;
  onEvent?: (event: UploadQueueEvent) => void;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type UploadQueueEvent =
  | { type: 'upload-start'; deviceId: string; frameId: string; attempt: number }
  | { type: 'upload-success'; deviceId: string; frameId: string; result: UploadResult }
  | {
      type: 'upload-skipped';
      deviceId: string;
      frameId: string;
      reason: 'unchanged' | 'superseded';
    }
  | {
      type: 'upload-retry';
      deviceId: string;
      frameId: string;
      attempt: number;
      delayMs: number;
      code: string;
    }
  | { type: 'upload-failed'; deviceId: string; frameId: string; code: string; message: string };

/** Jittered backoff schedule from the spec, capped at two minutes. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 120_000];

/**
 * One serialized write pipeline per device.
 *
 * Three protections matter here and they compose: only the newest pending frame
 * survives (coalescing), identical bytes are never re-sent (hash suppression), and
 * successful writes are spaced out (minimum interval). Together they keep a 15-second
 * refresh loop from writing to device flash 5,760 times a day.
 */
export class DeviceUploadQueue {
  readonly deviceId: string;
  #adapter: DeviceAdapter;
  #pending: UploadRequest | null = null;
  #running: Promise<void> | null = null;
  #draining = false;
  #lastSha: string | null;
  #lastSuccessAt = 0;
  #stopped = false;
  #waiters: Array<(outcome: UploadOutcome) => void> = [];
  #pendingResolve: ((outcome: UploadOutcome) => void) | null = null;

  readonly #minimumIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #onEvent: (event: UploadQueueEvent) => void;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: UploadQueueOptions) {
    this.deviceId = options.deviceId;
    this.#adapter = options.adapter;
    this.#minimumIntervalMs = Math.max(0, options.minimumIntervalMs);
    this.#lastSha = options.lastUploadedSha256 ?? null;
    this.#maxAttempts = options.maxAttempts ?? BACKOFF_MS.length;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#now = options.now ?? (() => Date.now());
    this.#wait = options.wait ?? sleep;
  }

  get adapter(): DeviceAdapter {
    return this.#adapter;
  }

  setAdapter(adapter: DeviceAdapter): void {
    this.#adapter = adapter;
  }

  get lastSha256(): string | null {
    return this.#lastSha;
  }

  /**
   * Queues a frame. A frame waiting behind the in-flight upload is replaced, because
   * showing the newest state matters more than showing every intermediate state.
   */
  enqueue(request: UploadRequest): Promise<UploadOutcome> {
    if (this.#stopped) {
      return Promise.resolve({
        status: 'failed',
        error: new AppError('DEVICE_UNREACHABLE', 'Upload queue is stopped.'),
        attempts: 0,
      });
    }

    if (this.#pending && this.#pendingResolve) {
      // An attention frame must not be displaced by a routine rotation frame.
      if (this.#pending.priority !== 'normal' && request.priority === 'normal') {
        return Promise.resolve({ status: 'skipped-superseded' });
      }
      this.#pendingResolve({ status: 'skipped-superseded' });
      this.#onEvent({
        type: 'upload-skipped',
        deviceId: this.deviceId,
        frameId: this.#pending.frameId,
        reason: 'superseded',
      });
    }

    this.#pending = request;
    const promise = new Promise<UploadOutcome>((resolve) => {
      this.#pendingResolve = resolve;
    });

    // `#draining` is cleared synchronously inside `#drain`'s finally block. Clearing it
    // from a `.finally()` on the promise instead would run a microtask *after* the
    // caller's own continuation, so a sequential `await enqueue(); enqueue();` would
    // queue a frame that nothing ever drains.
    if (!this.#draining) {
      this.#draining = true;
      this.#running = this.#drain();
    }
    return promise;
  }

  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  stop(): void {
    this.#stopped = true;
    this.#draining = false;
    this.#pendingResolve?.({ status: 'skipped-superseded' });
    this.#pending = null;
    this.#pendingResolve = null;
    for (const waiter of this.#waiters) waiter({ status: 'skipped-superseded' });
    this.#waiters = [];
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending && !this.#stopped) {
        const request = this.#pending;
        const resolve = this.#pendingResolve ?? (() => undefined);
        this.#pending = null;
        this.#pendingResolve = null;

        const outcome = await this.#process(request);
        resolve(outcome);
      }
    } finally {
      this.#draining = false;
      this.#running = null;
    }
  }

  async #process(request: UploadRequest): Promise<UploadOutcome> {
    if (!request.force && request.frame.sha256 === this.#lastSha) {
      this.#onEvent({
        type: 'upload-skipped',
        deviceId: this.deviceId,
        frameId: request.frameId,
        reason: 'unchanged',
      });
      return { status: 'skipped-unchanged', sha256: request.frame.sha256 };
    }

    const sinceLast = this.#now() - this.#lastSuccessAt;
    if (this.#lastSuccessAt > 0 && sinceLast < this.#minimumIntervalMs) {
      await this.#wait(this.#minimumIntervalMs - sinceLast);
      // A newer frame may have arrived while waiting; let it win.
      if (this.#pending) return { status: 'skipped-superseded' };
    }

    let attempt = 0;
    let lastError: AppError | null = null;

    while (attempt < this.#maxAttempts && !this.#stopped) {
      attempt += 1;
      this.#onEvent({
        type: 'upload-start',
        deviceId: this.deviceId,
        frameId: request.frameId,
        attempt,
      });
      try {
        await this.#adapter.prepareManagedDisplay({
          albumManagementConsent: request.albumManagementConsent,
        });
        const result = await this.#adapter.uploadFrame(request.frame);
        this.#lastSha = request.frame.sha256;
        this.#lastSuccessAt = this.#now();
        this.#onEvent({
          type: 'upload-success',
          deviceId: this.deviceId,
          frameId: request.frameId,
          result,
        });
        return { status: 'uploaded', result, sha256: request.frame.sha256 };
      } catch (error) {
        lastError = toAppError(error, 'Upload failed');
        // Validation, auth and unsupported-profile errors will not fix themselves.
        if (!lastError.retryable || attempt >= this.#maxAttempts) break;

        const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 30_000;
        const delayMs = Math.round(base * (0.8 + Math.random() * 0.4));
        this.#onEvent({
          type: 'upload-retry',
          deviceId: this.deviceId,
          frameId: request.frameId,
          attempt,
          delayMs,
          code: lastError.code,
        });
        await this.#wait(delayMs);
        if (this.#pending) return { status: 'skipped-superseded' };
      }
    }

    const error = lastError ?? new AppError('DEVICE_UPLOAD_FAILED', 'Upload failed.');
    this.#onEvent({
      type: 'upload-failed',
      deviceId: this.deviceId,
      frameId: request.frameId,
      code: error.code,
      message: error.message,
    });
    return { status: 'failed', error, attempts: attempt };
  }
}
