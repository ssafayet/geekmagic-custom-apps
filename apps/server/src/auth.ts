import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, randomToken } from '@gca/shared';
import type { AppContext } from './context.js';
import type { AppServer } from './fastify-types.js';

const SESSION_COOKIE = 'gca_session';
const CSRF_COOKIE = 'gca_csrf';
const CSRF_HEADER = 'x-gca-csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_KEY = 'auth.passwordHash';

interface Session {
  id: string;
  csrf: string;
  expiresAt: number;
}

/**
 * Local single-administrator authentication.
 *
 * Only enforced when the server binds beyond loopback. On 127.0.0.1 the OS already
 * limits reach to the local machine, and forcing a login there would be friction
 * without a matching threat.
 */
export class AuthService {
  readonly #sessions = new Map<string, Session>();

  constructor(private readonly ctx: AppContext) {}

  get required(): boolean {
    return this.ctx.config.isExposed;
  }

  get configured(): boolean {
    return this.ctx.store.appSettings.get<string>(PASSWORD_HASH_KEY) !== null;
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < 12) {
      throw new AppError('VALIDATION_FAILED', 'Choose a password of at least 12 characters.');
    }
    // Argon2id with defaults tuned by the library for interactive logins.
    const digest = await argonHash(password, { algorithm: 2 });
    this.ctx.store.appSettings.set(PASSWORD_HASH_KEY, digest);
    this.#sessions.clear();
    this.ctx.store.audit.record({
      eventType: 'auth.password-set',
      entityType: 'app',
      severity: 'warn',
    });
  }

  async login(password: string): Promise<Session> {
    const digest = this.ctx.store.appSettings.get<string>(PASSWORD_HASH_KEY);
    if (!digest) throw new AppError('UNAUTHORIZED', 'No administrator password has been set.');

    const valid = await argonVerify(digest, password).catch(() => false);
    if (!valid) {
      this.ctx.store.audit.record({
        eventType: 'auth.failed',
        entityType: 'app',
        severity: 'warn',
      });
      throw new AppError('UNAUTHORIZED', 'Incorrect password.');
    }

    const session: Session = {
      id: randomToken(32),
      csrf: randomToken(24),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) this.#sessions.delete(sessionId);
  }

  verify(sessionId: string | undefined): Session | null {
    if (!sessionId) return null;
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return session;
  }
}

export function registerAuth(app: AppServer, ctx: AppContext, auth: AuthService): void {
  app.decorate('auth', auth);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0] ?? '';

    // The bridge endpoint carries its own bearer token and is loopback-only.
    if (url.startsWith('/internal/')) return;
    if (!url.startsWith('/api/')) return;
    if (url === '/api/v1/health' || url === '/api/v1/auth/state' || url === '/api/v1/auth/login')
      return;
    // Bootstrap: an exposed server with no password yet must still be able to set
    // its first one, or the deployment is permanently locked out of itself. Once a
    // password exists, this route requires the current one like any other change.
    if (url === '/api/v1/auth/password' && !auth.configured) return;
    if (!auth.required) return;

    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const session = auth.verify(cookies?.[SESSION_COOKIE]);
    if (!session) {
      await reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in to use this API.' },
      });
      return;
    }

    // Double-submit CSRF: a cross-site form cannot read the cookie to set the header.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || header !== session.csrf) {
        await reply.status(403).send({
          error: { code: 'UNAUTHORIZED', message: 'Missing or invalid CSRF token.' },
        });
        return;
      }
    }
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { password?: string };
    const session = await auth.login(String(body.password ?? ''));
    setSessionCookies(reply, session.id, session.csrf, ctx.config.isExposed);
    return { ok: true, csrf: session.csrf };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    auth.logout(cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/state', async () => ({
    required: auth.required,
    configured: auth.configured,
  }));

  app.post('/api/v1/auth/password', async (request) => {
    const body = (request.body ?? {}) as { password?: string; currentPassword?: string };
    if (auth.configured) {
      await auth.login(String(body.currentPassword ?? ''));
    }
    await auth.setPassword(String(body.password ?? ''));
    return { ok: true };
  });
}

function setSessionCookies(
  reply: FastifyReply,
  sessionId: string,
  csrf: string,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    // Only mark Secure when exposed; on plain-HTTP loopback it would break login.
    secure,
    maxAge: SESSION_TTL_MS / 1000,
  });
  // Readable by the UI on purpose: it must echo the value back in a header.
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: '/',
    httpOnly: false,
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService;
  }
}
