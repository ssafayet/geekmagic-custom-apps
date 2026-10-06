export type {
  ActionResultDto,
  BackupDto,
  CoreSettingsDto,
  DeviceCapabilities,
  DeviceDto,
  DeviceProbeDto,
  DeviceProfileId,
  ModuleDefinitionDto,
  ModuleInstanceDto,
  PlaylistItemDto,
  ProbeTranscriptEntry,
  SecretFieldStateDto,
  StatusPanelDto,
  StatusSummaryDto,
  HealthStatus,
  ErrorCode,
} from '@gca/shared';

/** UI metadata shapes, mirrored from the module SDK without importing server code. */
export interface UiSchema {
  sections: Array<{ id: string; title: string; description?: string }>;
  fields: Record<string, UiFieldMeta>;
  sectionActions?: Record<string, string[]>;
}

export interface UiFieldMeta {
  section: string;
  order: number;
  label?: string;
  widget?:
    | 'text'
    | 'password'
    | 'number'
    | 'switch'
    | 'select'
    | 'slider'
    | 'location'
    | 'duration'
    | 'textarea';
  placeholder?: string;
  help?: string;
  secret?: boolean;
  unit?: string;
  actionId?: string;
  visibleWhen?: { field: string; equals: unknown[] };
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
  else?: JsonSchemaNode;
  oneOf?: JsonSchemaNode[];
  const?: unknown;
}

export interface ValidationResponse {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: string[];
}

export interface AlbumPlan {
  deviceId: string;
  filesToDelete: string[];
  willBackUp: boolean;
  consequence: string;
  confirmationToken: string;
}

export interface RestorePlan {
  backupId: string;
  files: string[];
  consequence: string;
  confirmationToken: string;
}

export interface ResetPlan {
  devices: Array<{ id: string; name: string; backups: number }>;
  modules: Array<{ id: string; name: string }>;
  /** Album backups whose files stay on disk after the reset. */
  backups: number;
  backupDirectory: string | null;
  confirmationToken: string;
}

export interface SubnetsResponse {
  enabled: boolean;
  subnets: Array<{ interfaceName: string; address: string; cidr: string; hostCount: number }>;
}

export interface DiscoverResponse {
  scanned: number;
  found: Array<{
    host: string;
    profileId: string;
    modelName: string | null;
    firmwareVersion: string | null;
    supported: boolean;
  }>;
}

export interface AuthState {
  /** The server demands a signed-in session for its API. */
  required: boolean;
  /** An administrator password exists. */
  configured: boolean;
  /** This browser holds a valid session. */
  authenticated: boolean;
}

export interface HealthResponse {
  status: string;
  version: string;
  startedAt: string;
  modules: { loaded: string[]; rejected: Array<{ id: string; reason: string }> };
  devices: number;
  bridge: { connected: boolean; lastReceivedAt: string | null; tokenConfigured: boolean };
}
