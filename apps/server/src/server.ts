import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { AppContext } from './context.js';
import { AuthService, registerAuth } from './auth.js';
import { registerRequestGuard } from './request-guard.js';
import { apiNotFound, registerErrorHandler } from './errors.js';
import {
  registerCoreRoutes,
  registerDeviceRoutes,
  registerInternalRoutes,
  registerModuleRoutes,
  registerPlaylistRoutes,
  registerResetRoutes,
} from './routes/index.js';
import { ConfirmationService } from './services/confirmation.js';
import { DeviceService } from './services/device-service.js';
import { ModuleService } from './services/module-service.js';
import { ResetService } from './services/reset-service.js';
import type { AppServer } from './fastify-types.js';

const API_BODY_LIMIT = 1024 * 1024;

/**
 * The UI is a same-origin bundle: scripts, styles, fonts and preview images all come
 * from this server. Inline styles stay allowed because React and Tailwind set them.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildServer(ctx: AppContext): Promise<AppServer> {
  const app = Fastify({
    loggerInstance: ctx.logger,
    bodyLimit: API_BODY_LIMIT,
    trustProxy: ctx.config.trustProxy,
    // Per-request access logs add noise without value for a local control panel that
    // the UI polls every few seconds; routes log what matters themselves.
    logController: new LogController({ disableRequestLogging: true }),
  });

  registerErrorHandler(app);
  // Before anything else, so a rebound hostname never reaches a route or the UI.
  registerRequestGuard(app, ctx.config);

  // JSON is the only body the API accepts. A text/plain body is what a cross-site
  // form or no-cors fetch can send without a preflight, so refusing it (415) closes
  // that door independently of the Origin check.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie, {});
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  // Same-origin only: the UI is served by this process, so there is no legitimate
  // cross-origin caller and no CORS plugin is registered on purpose.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    reply.header('cross-origin-opener-policy', 'same-origin');
    // API responses carry settings and device state; nothing should cache them.
    if (isApiPath(request.url) && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  const services = {
    devices: new DeviceService(ctx),
    modules: new ModuleService(ctx),
    confirmations: new ConfirmationService(),
    reset: new ResetService(ctx),
  };

  const auth = new AuthService(ctx);
  registerAuth(app, ctx, auth);

  registerCoreRoutes(app, ctx, services);
  registerDeviceRoutes(app, ctx, services);
  registerModuleRoutes(app, ctx, services);
  registerPlaylistRoutes(app, ctx);
  registerResetRoutes(app, ctx, services);
  registerInternalRoutes(app, ctx);

  await registerWebUi(app);

  return app;
}

/** Serves the built React UI when present; in development Vite serves it instead. */
async function registerWebUi(app: AppServer): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'web', 'dist'),
    resolve(here, '..', '..', '..', 'apps', 'web', 'dist'),
    resolve(here, '..', 'public'),
  ];
  const root = candidates.find((candidate) => existsSync(candidate));

  if (!root) {
    app.setNotFoundHandler(async (request, reply) => {
      if (isApiPath(request.url)) return apiNotFound(request, reply);
      reply.type('text/plain');
      return 'geekmagic-custom-apps is running. Build the web UI with `pnpm build`, or run `pnpm dev:web` for the development server.';
    });
    return;
  }

  await app.register(fastifyStatic, { root, prefix: '/' });

  // Client-side routing: any non-API path falls back to the SPA entry point.
  app.setNotFoundHandler(async (request, reply) => {
    if (isApiPath(request.url)) return apiNotFound(request, reply);
    return reply.sendFile('index.html');
  });
}

function isApiPath(url: string): boolean {
  return url.startsWith('/api/') || url.startsWith('/internal/');
}
