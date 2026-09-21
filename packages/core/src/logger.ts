import { createRequire } from 'node:module';
import { pino, stdSerializers, type Logger } from 'pino';
import { redactDeep } from '@gca/shared';

export type AppLogger = Logger;

const REDACT_PATHS = [
  'apiKey',
  'adminApiKey',
  'authorization',
  'token',
  'bridgeToken',
  'cookie',
  'secret',
  'password',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.apiKey',
  '*.token',
  '*.secret',
];

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  name?: string;
}

/**
 * Structured logger with two layers of secret protection: pino's own redaction paths
 * for known shapes, and a recursive serializer for anything nested that slipped past.
 */
export function createLogger(options: LoggerOptions = {}): AppLogger {
  const level = options.level ?? process.env['GCA_LOG_LEVEL'] ?? 'info';
  const pretty = options.pretty ?? process.env['NODE_ENV'] !== 'production';

  return pino({
    name: options.name ?? 'gca',
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: stdSerializers.err,
      // Anything attached as `details` is user- or device-derived, so scrub it.
      details: (value: unknown) => redactDeep(value),
      settings: (value: unknown) => redactDeep(value),
    },
    ...(pretty && prettyTransportAvailable()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

/**
 * Pretty output is a convenience, not a requirement. A slim production image may not
 * ship `pino-pretty`, and a missing formatter must never stop the service booting.
 */
function prettyTransportAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
