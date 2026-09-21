import type { FastifyRequest } from 'fastify';

import { AppError } from '@gca/shared';
import { MAX_STATUSLINE_BYTES } from '@gca/module-claude-usage';
import type { AppContext } from '../context.js';
import type { AppServer } from '../fastify-types.js';

/**
 * Loopback-only ingestion endpoint for the Claude Code status-line bridge.
 *
 * Not part of the browser API: no cookies, no CSRF, its own bearer token, its own
 * rate limit, and a hard body cap. It is reachable only from the local machine.
 */
export function registerInternalRoutes(app: AppServer, ctx: AppContext): void {
  app.post(
    '/internal/claude/statusline',
    {
      bodyLimit: MAX_STATUSLINE_BYTES,
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!isLoopback(request)) {
        ctx.logger.warn({ ip: request.ip }, 'Rejected non-loopback bridge request');
        throw new AppError('UNAUTHORIZED', 'This endpoint only accepts local connections.');
      }

      const token = readBearer(request.headers.authorization);
      if (!ctx.bridgeInbox.verifyToken(token)) {
        throw new AppError('UNAUTHORIZED', 'Invalid bridge token.');
      }

      if (!ctx.bridgeInbox.checkRateLimit()) {
        throw new AppError('RATE_LIMITED', 'Too many status-line updates.');
      }

      const byteLength = Number(request.headers['content-length'] ?? 0);
      const result = ctx.bridgeInbox.ingest(request.body, { byteLength });

      if (!result.accepted) {
        // 202 rather than 400: the bridge must not treat this as something to retry,
        // and a rejected payload is a normal occurrence outside an active session.
        reply.status(202);
        return { accepted: false, reason: result.reason };
      }

      return {
        accepted: true,
        windows: {
          fiveHour: result.payload?.fiveHour !== null,
          sevenDay: result.payload?.sevenDay !== null,
        },
        ...(result.warnings.length > 0 ? { notes: result.warnings } : {}),
      };
    },
  );

  app.get('/internal/claude/status', async (request) => {
    if (!isLoopback(request)) {
      throw new AppError('UNAUTHORIZED', 'This endpoint only accepts local connections.');
    }
    return ctx.bridgeInbox.describe();
  });
}

function isLoopback(request: FastifyRequest): boolean {
  const ip = request.ip;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function readBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}
