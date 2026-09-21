import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, redactDeep, toAppError } from '@gca/shared';
import type { AppServer } from './fastify-types.js';

/**
 * Single error boundary for the API.
 *
 * Every response uses the same envelope, and internal errors are logged with their
 * cause but reported to the client as a generic message so no stack, path or upstream
 * body escapes.
 */
export function registerErrorHandler(app: AppServer): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const appError = normalize(error);

    if (appError.statusCode >= 500) {
      request.log.error({ err: error, url: request.url, code: appError.code }, 'Request failed');
      reply.status(appError.statusCode).send({
        error: { code: appError.code, message: 'Something went wrong on the server.' },
      });
      return;
    }

    request.log.debug({ url: request.url, code: appError.code }, 'Request rejected');
    reply.status(appError.statusCode).send(redactDeep(appError.toBody()));
  });
}

/**
 * The single 404 handler.
 *
 * Fastify allows only one per prefix, and the correct behaviour depends on whether
 * the built UI is present, so it is registered once by the web-UI setup rather than
 * here alongside the error handler.
 */
export function apiNotFound(request: FastifyRequest, reply: FastifyReply): void {
  reply.status(404).send({
    error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` },
  });
}

function normalize(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const fastifyError = error as { statusCode?: number; code?: string; message?: string };
  if (typeof fastifyError?.statusCode === 'number' && fastifyError.statusCode < 500) {
    if (fastifyError.code === 'FST_ERR_VALIDATION') {
      return new AppError(
        'VALIDATION_FAILED',
        fastifyError.message ?? 'Request validation failed.',
        {
          statusCode: 400,
        },
      );
    }
    if (fastifyError.statusCode === 429) {
      return new AppError('RATE_LIMITED', 'Too many requests.', { statusCode: 429 });
    }
    return new AppError('VALIDATION_FAILED', fastifyError.message ?? 'Bad request.', {
      statusCode: fastifyError.statusCode,
    });
  }

  return toAppError(error);
}
