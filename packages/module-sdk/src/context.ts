import type { HealthStatus } from '@gca/shared';
import type { ModuleFrame, ModuleFrameDraft, SemanticColor } from './frame.js';
import type { JsonSchema, ModuleManifest, ModuleUiSchema } from './manifest.js';

export type RefreshReason =
  'startup' | 'scheduled' | 'manual' | 'settings-changed' | 'event' | 'recovery';

export interface ModuleLogger {
  debug(payload: Record<string, unknown> | string, message?: string): void;
  info(payload: Record<string, unknown> | string, message?: string): void;
  warn(payload: Record<string, unknown> | string, message?: string): void;
  error(payload: Record<string, unknown> | string, message?: string): void;
}

export interface ScopedFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hard cap on the response body; oversized responses reject instead of buffering. */
  maxBytes?: number;
}

export interface ScopedResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  json<T = unknown>(): T;
}

/**
 * HTTP client limited to the hosts a module declared. Requests to any other host throw,
 * which is how `network:*` permissions are actually enforced rather than merely described.
 */
export interface ScopedHttpClient {
  request(url: string, options?: ScopedFetchOptions): Promise<ScopedResponse>;
}

/** Decrypted on read, for the duration of the call only; never cached by the module. */
export interface ScopedSecrets {
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
}

/**
 * Small durable key/value area scoped to one module instance. Used for things like
 * ADS-B overhead hysteresis that must survive a restart but are not user settings.
 */
export interface ScopedStateStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AttentionRequest {
  viewId: string;
  /** De-duplication key; repeat events with the same key are suppressed until released. */
  key: string;
  holdSeconds: number;
  reason: string;
}

export interface ModuleEvents {
  /** Ask the scheduler to re-render and push this module's current frame now. */
  requestDisplayRefresh(reason: string): void;
  /** Raise an interrupting frame (ADS-B overhead). Honours per-device cooldowns. */
  requestAttention(request: AttentionRequest): void;
  /** Release a previously raised attention key. */
  releaseAttention(key: string): void;
  /** Report a health transition outside of a refresh cycle. */
  reportHealth(status: HealthStatus, message?: string, code?: string): void;
}

export interface ModuleContext<TSettings> {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly instanceName: string;
  readonly settings: TSettings;
  readonly logger: ModuleLogger;
  readonly http: ScopedHttpClient;
  readonly secrets: ScopedSecrets;
  readonly state: ScopedStateStore;
  readonly events: ModuleEvents;
  /** Injected for deterministic tests. */
  readonly now: () => Date;
  /** Services the host grants only to modules holding the matching permission. */
  readonly host: HostServices;
}

/**
 * Host-level capabilities that cannot be expressed as plain HTTP. Each member is
 * present only when the module declared the corresponding permission.
 */
export interface HostServices {
  claudeCli?: ClaudeCliService;
  claudeSettings?: ClaudeSettingsService;
  /** Loopback bridge ingestion, exposed so the Claude module can read what arrived. */
  bridgeInbox?: BridgeInboxService;
}

export interface ClaudeCliDetection {
  found: boolean;
  binaryPath: string | null;
  version: string | null;
  authenticated: boolean | null;
  detail: string;
}

export interface ClaudeCliService {
  detect(signal?: AbortSignal): Promise<ClaudeCliDetection>;
}

export interface ClaudeBridgeInstallState {
  installed: boolean;
  settingsPath: string;
  chainedCommand: string | null;
  installedAt: string | null;
  backupPath: string | null;
  conflict: string | null;
}

export interface ClaudeSettingsService {
  inspect(): Promise<ClaudeBridgeInstallState>;
  install(): Promise<ClaudeBridgeInstallState>;
  uninstall(): Promise<ClaudeBridgeInstallState>;
}

export interface BridgeInboxService {
  /** Most recent sanitized status-line payload, or null if none has arrived. */
  latest(): Promise<BridgePayload | null>;
}

export interface BridgePayload {
  receivedAt: string;
  claudeCodeVersion: string | null;
  sessionKey: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
  fiveHour: { usedPercentage: number; resetsAt: string } | null;
  sevenDay: { usedPercentage: number; resetsAt: string } | null;
  spendLimit: { usedPercentage: number; resetsAt: string } | null;
  sessionCostUsd: number | null;
}

export interface FrameContext {
  /** Views the caller wants; empty means all selectable views. */
  viewIds?: string[];
  now: Date;
  timezone: string;
  accent: SemanticColor;
}

export interface ModuleHealth {
  status: HealthStatus;
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface ModuleActionResult {
  ok: boolean;
  message: string;
  code?: string;
  data?: Record<string, unknown>;
  panel?: {
    title: string;
    rows: Array<{
      label: string;
      value: string;
      tone?: 'neutral' | 'good' | 'warn' | 'bad';
      hint?: string;
    }>;
  };
  /** Set when the action changed persisted settings and the instance should reload. */
  settingsPatch?: Record<string, unknown>;
}

export interface ValidationContext {
  instanceId: string | null;
  /** True when a secret is configured, so schemas can require "key or local mode". */
  secretConfigured: (key: string) => boolean;
}

export type ValidationResult<T> =
  | { ok: true; value: T; warnings?: string[] }
  | { ok: false; errors: Array<{ path: string; message: string }> };

export interface ModuleRuntime<TSnapshot> {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(reason: RefreshReason, signal: AbortSignal): Promise<TSnapshot>;
  getSnapshot(): TSnapshot | null;
  /** Restores a persisted snapshot after a restart. Must tolerate unknown shapes. */
  hydrate?(snapshot: unknown, capturedAt: string): void;
  getFrames(ctx: FrameContext): Promise<ModuleFrameDraft[]>;
  getHealth(): Promise<ModuleHealth>;
  /** Read-only panel shown at the top of the settings form. */
  getStatusPanel?(): Promise<ModuleActionResult['panel'] | null>;
  runAction?(actionId: string, input: unknown, signal: AbortSignal): Promise<ModuleActionResult>;
}

export interface AppModule<TSettings, TSnapshot> {
  manifest: ModuleManifest;
  settingsSchema: JsonSchema;
  uiSchema: ModuleUiSchema;
  defaultSettings: TSettings;
  /** Secret field keys. These live in the vault, never in `settings_json`. */
  secretKeys: string[];
  validateSettings(settings: unknown, ctx: ValidationContext): Promise<ValidationResult<TSettings>>;
  migrateSettings(
    fromVersion: number,
    settings: unknown,
  ): Promise<{ version: number; settings: unknown }>;
  createRuntime(ctx: ModuleContext<TSettings>): ModuleRuntime<TSnapshot>;
  /** Optional runtime guard for persisted snapshots; invalid snapshots are discarded. */
  snapshotIsValid?(snapshot: unknown): boolean;
}

export type AnyAppModule = AppModule<any, any>;
export type AnyModuleRuntime = ModuleRuntime<any>;
export type { ModuleFrame };
