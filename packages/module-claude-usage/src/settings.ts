import type { JsonSchema, ModuleUiSchema } from '@gca/module-sdk';

export interface ClaudeUsageSettings {
  source: 'auto' | 'local-claude-code' | 'anthropic-usage-api';
  /** When the bridge is silent, fall back to the API credential if one is configured. */
  allowApiFallback: boolean;
  usageWindowDays: number;
  displayMode: 'auto' | 'rate-limits' | 'api-cost';
  showResetTime: boolean;
  showSessionCost: boolean;
  staleAfterMinutes: number;
  accent: 'purple' | 'blue' | 'cyan' | 'green' | 'magenta';
}

/** Vault key for the organization usage credential. Never stored in settings JSON. */
export const ADMIN_API_KEY_SECRET = 'adminApiKey';

export const CLAUDE_DEFAULT_SETTINGS: ClaudeUsageSettings = {
  source: 'auto',
  allowApiFallback: false,
  usageWindowDays: 7,
  displayMode: 'auto',
  showResetTime: true,
  showSessionCost: false,
  staleAfterMinutes: 30,
  accent: 'purple',
};

export const CLAUDE_SETTINGS_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    source: {
      type: 'string',
      enum: ['auto', 'local-claude-code', 'anthropic-usage-api'],
      default: 'auto',
    },
    allowApiFallback: { type: 'boolean', default: false },
    usageWindowDays: { type: 'integer', minimum: 1, maximum: 31, default: 7 },
    displayMode: { type: 'string', enum: ['auto', 'rate-limits', 'api-cost'], default: 'auto' },
    showResetTime: { type: 'boolean', default: true },
    showSessionCost: { type: 'boolean', default: false },
    staleAfterMinutes: { type: 'integer', minimum: 5, maximum: 240, default: 30 },
    accent: {
      type: 'string',
      enum: ['purple', 'blue', 'cyan', 'green', 'magenta'],
      default: 'purple',
    },
  },
  // The organization credential is only meaningful when the API source can be used.
  if: { properties: { source: { const: 'anthropic-usage-api' } }, required: ['source'] },
  then: { required: ['usageWindowDays'] },
};

export const CLAUDE_UI_SCHEMA: ModuleUiSchema = {
  sections: [
    {
      id: 'source',
      title: 'Data source',
      description:
        'Claude Code subscription limits and Anthropic organization API usage are different products. Subscription usage comes from your local Claude Code session; organization usage needs a credential authorized for usage reporting.',
    },
    { id: 'credential', title: 'Organization usage credential' },
    { id: 'display', title: 'Display' },
  ],
  fields: {
    source: {
      section: 'source',
      order: 1,
      label: 'Source',
      widget: 'select',
      options: [
        {
          value: 'auto',
          label: 'Auto',
          description: 'Prefer local Claude Code, then the API credential',
        },
        {
          value: 'local-claude-code',
          label: 'Local Claude Code',
          description: 'Subscription rate limits only',
        },
        {
          value: 'anthropic-usage-api',
          label: 'Organization usage API',
          description: 'Tokens and cost only',
        },
      ],
    },
    allowApiFallback: {
      section: 'source',
      order: 2,
      label: 'Fall back to the API credential when Claude Code is quiet',
      widget: 'switch',
      help: 'Off by default, so an idle session shows "waiting" instead of silently switching to a different measurement.',
      visibleWhen: { field: 'source', equals: ['auto'] },
    },
    adminApiKey: {
      section: 'credential',
      order: 1,
      label: 'Anthropic usage credential',
      widget: 'password',
      secret: true,
      placeholder: 'sk-ant-admin...',
      help: 'Must be authorized for organization usage and cost reporting. An ordinary API key that can call Claude is usually not.',
      actionId: 'claude.testCredential',
    },
    usageWindowDays: {
      section: 'credential',
      order: 2,
      label: 'Reporting window',
      widget: 'slider',
      unit: 'days',
      min: 1,
      max: 31,
      step: 1,
      visibleWhen: { field: 'source', equals: ['auto', 'anthropic-usage-api'] },
    },
    displayMode: {
      section: 'display',
      order: 1,
      label: 'What to show',
      widget: 'select',
      options: [
        { value: 'auto', label: 'Match the active source' },
        { value: 'rate-limits', label: 'Subscription rate limits' },
        { value: 'api-cost', label: 'API tokens and cost' },
      ],
    },
    showResetTime: { section: 'display', order: 2, label: 'Show reset time', widget: 'switch' },
    showSessionCost: {
      section: 'display',
      order: 3,
      label: 'Show session cost when Claude Code reports it',
      widget: 'switch',
    },
    staleAfterMinutes: {
      section: 'display',
      order: 4,
      label: 'Mark data stale after',
      widget: 'duration',
      unit: 'min',
      min: 5,
      max: 240,
    },
    accent: {
      section: 'display',
      order: 5,
      label: 'Accent colour',
      widget: 'select',
      options: [
        { value: 'purple', label: 'Purple' },
        { value: 'blue', label: 'Blue' },
        { value: 'cyan', label: 'Cyan' },
        { value: 'green', label: 'Green' },
        { value: 'magenta', label: 'Magenta' },
      ],
    },
  },
  sectionActions: {
    source: ['claude.detectLocalCli', 'claude.installBridge', 'claude.uninstallBridge'],
    credential: ['claude.testCredential'],
    display: ['core.refreshNow'],
  },
};
