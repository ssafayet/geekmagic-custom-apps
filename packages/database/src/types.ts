import type { DeviceCapabilities, DeviceProfileId, HealthStatus } from '@gca/shared';

export interface DeviceRecord {
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
  lastUploadHash: string | null;
  lastUploadAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleInstanceRecord {
  id: string;
  moduleId: string;
  name: string;
  enabled: boolean;
  settingsVersion: number;
  settings: Record<string, unknown>;
  healthStatus: HealthStatus;
  healthMessage: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRecord {
  moduleInstanceId: string;
  key: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  moduleInstanceId: string;
  schemaVersion: number;
  snapshot: unknown;
  capturedAt: string;
  expiresAt: string;
}

export interface PlaylistItemRecord {
  id: string;
  deviceId: string;
  moduleInstanceId: string;
  viewId: string;
  order: number;
  dwellSeconds: number;
  enabled: boolean;
}

export interface BackupFileEntry {
  filename: string;
  originalPath: string;
  bytes: number;
  sha256: string;
}

export interface BackupRecord {
  id: string;
  deviceId: string;
  profileId: DeviceProfileId;
  createdAt: string;
  manifest: { files: BackupFileEntry[]; note?: string };
  directory: string;
  status: 'complete' | 'partial' | 'failed';
}

export interface AuditEventRecord {
  id: string;
  eventType: string;
  actor: string;
  entityType: string;
  entityId: string | null;
  severity: 'info' | 'warn' | 'error';
  details: Record<string, unknown>;
  createdAt: string;
  /** Set once an operator has cleared the event from the overview. */
  acknowledgedAt: string | null;
}
