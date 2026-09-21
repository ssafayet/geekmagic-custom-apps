import { EventEmitter } from 'node:events';
import type { HealthStatus } from '@gca/shared';

export interface AppEvents {
  'module.snapshot': { instanceId: string; moduleId: string; at: string };
  'module.health': {
    instanceId: string;
    moduleId: string;
    status: HealthStatus;
    message?: string;
    code?: string;
  };
  'module.attention': {
    instanceId: string;
    moduleId: string;
    viewId: string;
    key: string;
    holdSeconds: number;
    reason: string;
  };
  'module.attention-released': { instanceId: string; key: string };
  'module.display-refresh': { instanceId: string; reason: string };
  'module.settings-changed': { instanceId: string };
  'device.state': { deviceId: string; online: boolean; health: HealthStatus };
  'device.uploaded': { deviceId: string; frameId: string; sha256: string };
  'device.error': { deviceId: string; code: string; message: string };
  'bridge.payload': { receivedAt: string };
}

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void;

/**
 * Typed in-process event bus.
 *
 * Modules never touch this directly; the runtime manager translates their scoped
 * `events` calls into bus emissions, which keeps the surface a module can reach small.
 */
export class EventBus {
  readonly #emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    // A listener that throws must not take the process down.
    this.#emitter.setMaxListeners(100);
    this.#emitter.on('error', () => undefined);
  }

  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    this.#emitter.emit(event, payload);
  }

  on<K extends keyof AppEvents>(event: K, handler: Handler<K>): () => void {
    this.#emitter.on(event, handler as (payload: unknown) => void);
    return () => this.#emitter.off(event, handler as (payload: unknown) => void);
  }

  once<K extends keyof AppEvents>(event: K, handler: Handler<K>): void {
    this.#emitter.once(event, handler as (payload: unknown) => void);
  }

  removeAll(): void {
    this.#emitter.removeAllListeners();
  }
}
