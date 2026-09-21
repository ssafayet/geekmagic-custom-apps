/**
 * Stable, user-facing error codes. These cross the API boundary and appear in the UI,
 * so treat them as part of the public contract: add codes, never repurpose them.
 */
export const ERROR_CODES = [
  'DEVICE_UNREACHABLE',
  'DEVICE_PROFILE_UNKNOWN',
  'DEVICE_PROFILE_UNSUPPORTED',
  'DEVICE_UPLOAD_FAILED',
  'DEVICE_UPLOAD_UNVERIFIED',
  'DEVICE_ADDRESS_BLOCKED',
  'DEVICE_NOT_FOUND',
  'PRO_ALBUM_CONSENT_REQUIRED',
  'PRO_ALBUM_BACKUP_FAILED',
  'CLAUDE_CLI_NOT_FOUND',
  'CLAUDE_NOT_AUTHENTICATED',
  'CLAUDE_BRIDGE_NOT_CONNECTED',
  'CLAUDE_RATE_LIMITS_ABSENT',
  'CLAUDE_BRIDGE_INSTALL_FAILED',
  'ANTHROPIC_USAGE_CREDENTIAL_INVALID',
  'ANTHROPIC_USAGE_FORBIDDEN',
  'ANTHROPIC_USAGE_UNAVAILABLE',
  'ADSB_PROVIDER_RATE_LIMITED',
  'ADSB_PROVIDER_UNAVAILABLE',
  'ADSB_LOCATION_INVALID',
  'MODULE_SETTINGS_INVALID',
  'MODULE_NOT_FOUND',
  'MODULE_ACTION_UNKNOWN',
  'MODULE_REFRESH_TIMEOUT',
  'SECRET_DECRYPTION_FAILED',
  'CONFIRMATION_REQUIRED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** An error carrying a stable code and an HTTP status, safe to serialize to clients. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;
  /** Set when the error should not be retried by the caller (auth, validation, unsupported). */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      statusCode?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
      retryable?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatusFor(code);
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? defaultRetryableFor(code);
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
      },
    };
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'MODULE_SETTINGS_INVALID':
    case 'ADSB_LOCATION_INVALID':
    case 'DEVICE_ADDRESS_BLOCKED':
    case 'ANTHROPIC_USAGE_CREDENTIAL_INVALID':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'ANTHROPIC_USAGE_FORBIDDEN':
    case 'PRO_ALBUM_CONSENT_REQUIRED':
    case 'CONFIRMATION_REQUIRED':
      return 403;
    case 'NOT_FOUND':
    case 'DEVICE_NOT_FOUND':
    case 'MODULE_NOT_FOUND':
    case 'MODULE_ACTION_UNKNOWN':
      return 404;
    // These are actionable configuration states, not server faults. Keeping them
    // under 500 matters: the error handler replaces 5xx messages with a generic
    // string, which would hide the one sentence telling the user what to do.
    case 'CONFLICT':
    case 'DEVICE_PROFILE_UNKNOWN':
    case 'DEVICE_PROFILE_UNSUPPORTED':
    case 'CLAUDE_CLI_NOT_FOUND':
    case 'CLAUDE_NOT_AUTHENTICATED':
    case 'CLAUDE_BRIDGE_NOT_CONNECTED':
    case 'CLAUDE_RATE_LIMITS_ABSENT':
    case 'CLAUDE_BRIDGE_INSTALL_FAILED':
      return 409;
    case 'RATE_LIMITED':
    case 'ADSB_PROVIDER_RATE_LIMITED':
      return 429;
    case 'DEVICE_UNREACHABLE':
    case 'DEVICE_UPLOAD_FAILED':
    case 'DEVICE_UPLOAD_UNVERIFIED':
    case 'PRO_ALBUM_BACKUP_FAILED':
    case 'ADSB_PROVIDER_UNAVAILABLE':
    case 'ANTHROPIC_USAGE_UNAVAILABLE':
      return 502;
    case 'MODULE_REFRESH_TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

function defaultRetryableFor(code: ErrorCode): boolean {
  switch (code) {
    case 'DEVICE_UNREACHABLE':
    case 'DEVICE_UPLOAD_FAILED':
    case 'ADSB_PROVIDER_UNAVAILABLE':
    case 'ANTHROPIC_USAGE_UNAVAILABLE':
    case 'MODULE_REFRESH_TIMEOUT':
    case 'INTERNAL_ERROR':
      return true;
    default:
      return false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalizes anything thrown into an AppError without leaking internals to clients. */
export function toAppError(value: unknown, fallbackMessage = 'Unexpected error'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError('INTERNAL_ERROR', value.message || fallbackMessage, { cause: value });
  }
  return new AppError('INTERNAL_ERROR', fallbackMessage, { details: { value: String(value) } });
}
