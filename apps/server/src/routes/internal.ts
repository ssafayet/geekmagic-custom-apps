import type { FastifyRequest } from 'fastify';

import { isPrivate } from '@gca/device-core';
import { AppError } from '@gca/shared';
import { MAX_STATUSLINE_BYTES } from '@gca/module-claude-usage';
import type { AppContext } from '../context.js';
import type { AppServer } from '../fastify-types.js';

/**
 * Local-only ingestion endpoint for the Claude Code status-line bridge.
 *
 * Not part of the browser API: no cookies, no CSRF, its own bearer token, its own
 * rate limit, and a hard body cap.
 *
 * Loopback-only by default. A containerised server has to be able to widen that:
 * Docker publishes the port through NAT, so a post from the host arrives from the
 * bridge gateway and never looks like 127.0.0.1. `GCA_BRIDGE_ALLOW_PRIVATE_SOURCES`
 * accepts any private address instead — the bearer token remains the actual
 * authentication, and the host-side port binding decides who can connect at all.
 */
export function registerInternalRoutes(app: AppServer, ctx: AppContext): void {
  app.post(
    '/internal/claude/statusline',
    {
      bodyLimit: MAX_STATUSLINE_BYTES,
      config: { rawBody: true },
    },
    async (request, reply) => {
      if (!isAllowedSource(request, ctx)) {
        ctx.logger.warn({ ip: request.ip }, 'Rejected non-local bridge request');
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

  /**
   * Diagnostic counterpart to the ingestion route, used by `gca-claude-bridge doctor`.
   *
   * It verifies the same token as the POST, deliberately: a bridge that cannot get a
   * payload accepted needs to find out whether the source or the token is at fault,
   * and the bridge itself can never say so — it swallows every error so that a broken
   * bridge is never the reason a Claude Code session shows one.
   */
  app.get('/internal/claude/status', async (request) => {
    if (!isAllowedSource(request, ctx)) {
      throw new AppError('UNAUTHORIZED', 'This endpoint only accepts local connections.');
    }
    if (!ctx.bridgeInbox.verifyToken(readBearer(request.headers.authorization))) {
      throw new AppError('UNAUTHORIZED', 'Invalid bridge token.');
    }
    return ctx.bridgeInbox.describe();
  });
}

function isAllowedSource(request: FastifyRequest, ctx: AppContext): boolean {
  const ip = request.ip;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ctx.config.bridgeAllowPrivateSources && isPrivate(ip);
}

function readBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}
