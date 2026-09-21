import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { AppLogger } from '@gca/core';

/**
 * Fastify instance type with our pino logger bound in.
 *
 * Passing `loggerInstance` narrows Fastify's logger generic, so every function that
 * receives the app must use this alias rather than the bare `FastifyInstance`.
 */
export type AppServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  AppLogger
>;
