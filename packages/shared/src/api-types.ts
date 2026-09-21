import type { HealthStatus } from './health.js';

export const DEVICE_PROFILES = [
  'stock-ultra',
  'stock-pro',
  'sd-pro',
  'weather-clock-legacy',
  'unknown',
] as const;
export type DeviceProfileId = (typeof DEVICE_PROFILES)[number];

export interface DeviceCapabilities {
  /** The adapter can push a rendered frame to the device. */
  canUploadImage: boolean;
  canSetBrightness: boolean;
  canListFiles: boolean;
  canDeleteFiles: boolean;
  /** Device shows an album slideshow, so deterministic output needs album management. */
  requiresAlbumManagement: boolean;
  canReadState: boolean;
  /** Album contents can be downloaded and restored later. */
  supportsBackup: boolean;
  notes: string[];
}

export interface DeviceDto {
  id: string;
  name: string;
  host: string;
  profileId: DeviceProfileId;
  modelName: string | null;
  firmwareVersion: string | null;
  capabilities: DeviceCapabilities;
  albumManagementConsent: boolean;
  active: boolean;
  minimumUploadIntervalSeconds: number;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  online: boolean;
  health: HealthStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  brightness: number | null;
  backupCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceProbeDto {
  host: string;
  reachable: boolean;
  profileId: DeviceProfileId;
  modelName: string | null;
  firmwareVersion: string | null;
  capabilities: DeviceCapabilities;
  supported: boolean;
  /** Ordered, redacted record of what detection tried — surfaced on the diagnostics page. */
  transcript: ProbeTranscriptEntry[];
  warnings: string[];
}

export interface ProbeTranscriptEntry {
  step: string;
  path: string;
  status: number | null;
  outcome: 'match' | 'no-match' | 'error' | 'skipped';
  detail?: string;
  durationMs: number;
}

export interface ModuleDefinitionDto {
  id: string;
  version: string;
  settingsVersion: number;
  displayName: string;
  description: string;
  icon: string;
  category: string;
  singleton: boolean;
  refresh: { defaultSeconds: number; minimumSeconds: number; maximumSeconds: number };
  permissions: string[];
  views: Array<{ id: string; displayName: string; description?: string }>;
  actions: Array<{
    id: string;
    displayName: string;
    description?: string;
    confirmation: 'none' | 'confirm' | 'destructive';
    inputSchema?: unknown;
  }>;
  settingsSchema: unknown;
  uiSchema: unknown;
  defaultSettings: Record<string, unknown>;
  instanceCount: number;
}

export interface SecretFieldStateDto {
  configured: boolean;
  lastFour: string | null;
  updatedAt: string | null;
}

export interface ModuleInstanceDto {
  id: string;
  moduleId: string;
  name: string;
  enabled: boolean;
  settingsVersion: number;
  /** Never contains secret values; secrets are described by `secrets` instead. */
  settings: Record<string, unknown>;
  secrets: Record<string, SecretFieldStateDto>;
  healthStatus: HealthStatus;
  healthMessage: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  /** Module-supplied read-only status panel, rendered generically by the UI. */
  statusPanel: StatusPanelDto | null;
  views: Array<{ id: string; displayName: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface StatusPanelDto {
  title: string;
  rows: Array<{
    label: string;
    value: string;
    tone?: 'neutral' | 'good' | 'warn' | 'bad';
    hint?: string;
  }>;
}

export interface PlaylistItemDto {
  id: string;
  deviceId: string;
  moduleInstanceId: string;
  moduleId: string;
  moduleInstanceName: string;
  viewId: string;
  viewDisplayName: string;
  order: number;
  dwellSeconds: number;
  enabled: boolean;
}

export interface StatusSummaryDto {
  devices: Array<{
    id: string;
    name: string;
    host: string;
    profileId: DeviceProfileId;
    online: boolean;
    health: HealthStatus;
    lastUploadAt: string | null;
    currentFrame: { moduleInstanceId: string; viewId: string; title: string } | null;
    nextFrame: { moduleInstanceId: string; viewId: string; title: string } | null;
    interrupted: boolean;
  }>;
  modules: Array<{
    id: string;
    moduleId: string;
    name: string;
    enabled: boolean;
    health: HealthStatus;
    healthMessage: string | null;
    lastSuccessAt: string | null;
  }>;
  recentErrors: Array<{
    at: string;
    code: string;
    message: string;
    entityType: string;
    entityId: string | null;
  }>;
  server: {
    version: string;
    startedAt: string;
    boundHost: string;
    authenticationRequired: boolean;
  };
}

export interface CoreSettingsDto {
  displayTimezone: string;
  defaultDwellSeconds: number;
  minimumUploadIntervalSeconds: number;
  jpegQuality: number;
  theme: string;
  discoveryEnabled: boolean;
  logLevel: string;
}

export interface BackupDto {
  id: string;
  deviceId: string;
  profileId: DeviceProfileId;
  createdAt: string;
  status: 'complete' | 'partial' | 'failed';
  fileCount: number;
  totalBytes: number;
  files: Array<{ filename: string; originalPath: string; bytes: number; sha256: string }>;
}

export interface ActionResultDto {
  ok: boolean;
  message: string;
  code?: string;
  data?: Record<string, unknown>;
  /** Rendered by the generic form under the action button. */
  panel?: StatusPanelDto;
}
