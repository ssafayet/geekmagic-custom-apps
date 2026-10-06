export const MODULE_PERMISSIONS = [
  'network:anthropic',
  'network:adsb-fi',
  'network:opensky',
  'network:adsbdb',
  'network:open-meteo',
  'network:airgradient',
  'host:claude-cli-status',
  'host:claude-settings-write',
  'secrets:read-own',
  'location:configured',
] as const;
export type ModulePermission = (typeof MODULE_PERMISSIONS)[number];

export const MODULE_CATEGORIES = ['monitoring', 'productivity', 'system', 'other'] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

export interface ModuleViewDefinition {
  id: string;
  displayName: string;
  description?: string;
  /** Rotation views appear in playlists; `attention` views only interrupt. */
  selectable?: boolean;
}

export type ActionConfirmation = 'none' | 'confirm' | 'destructive';

export interface ModuleActionDefinition {
  id: string;
  displayName: string;
  description?: string;
  confirmation: ActionConfirmation;
  timeoutMs: number;
  inputSchema?: JsonSchema;
  /** Declared so the UI can warn before an action writes outside the app. */
  writes?: boolean;
}

export interface ModuleManifest {
  id: string;
  version: string;
  settingsVersion: number;
  displayName: string;
  description: string;
  icon: string;
  category: ModuleCategory;
  singleton: boolean;
  refresh: {
    defaultSeconds: number;
    minimumSeconds: number;
    maximumSeconds: number;
  };
  permissions: ModulePermission[];
  views: ModuleViewDefinition[];
  actions?: ModuleActionDefinition[];
}

/** Loose JSON Schema 2020-12 shape; Ajv performs the real validation. */
export type JsonSchema = Record<string, unknown>;

export type FieldWidget =
  | 'text'
  | 'password'
  | 'number'
  | 'switch'
  | 'select'
  | 'slider'
  | 'location'
  | 'duration'
  | 'textarea';

export interface ModuleUiSchema {
  sections: Array<{ id: string; title: string; description?: string }>;
  fields: Record<
    string,
    {
      section: string;
      order: number;
      label?: string;
      widget?: FieldWidget;
      placeholder?: string;
      help?: string;
      secret?: boolean;
      unit?: string;
      /** Renders an inline action button beside the field. */
      actionId?: string;
      /** Only show the field when another field equals one of these values. */
      visibleWhen?: { field: string; equals: unknown[] };
      options?: Array<{ value: string; label: string; description?: string }>;
      min?: number;
      max?: number;
      step?: number;
    }
  >;
  /** Actions shown as standalone buttons at the bottom of a section. */
  sectionActions?: Record<string, string[]>;
}
