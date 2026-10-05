import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError, randomToken } from '@gca/shared';
import type { AppContext } from './context.js';
import type { AppServer } from './fastify-types.js';

const SESSION_COOKIE = 'gca_session';
const CSRF_COOKIE = 'gca_csrf';
const CSRF_HEADER = 'x-gca-csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSWORD_HASH_KEY = 'auth.passwordHash';
const SETUP_TOKEN_FILENAME = 'setup-token';

/**
 * Argon2 is deliberately expensive, which makes an unthrottled login route a way to
 * pin the CPU. Past this many concurrent hashes, callers are told to back off.
 */
const MAX_CONCURRENT_HASHES = 2;

/** Per-address budget for routes that check a password. */
export const PASSWORD_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

interface Session {
  id: string;
  csrf: string;
  expiresAt: number;
}

/**
 * Local single-administrator authentication.
 *
 * Only enforced when the server can be reached from beyond this machine. On
 * 127.0.0.1 the OS already limits reach to the local machine, and forcing a login
 * there would be friction without a matching threat.
 */
export class AuthService {
  readonly #sessions = new Map<string, Session>();
  readonly #setupTokenPath: string;
  #setupToken: string | null = null;
  #hashesInFlight = 0;

  constructor(private readonly ctx: AppContext) {
    this.#setupTokenPath = setupTokenPath(ctx.config.dataDir);
    if (this.required && !this.configured) {
      this.#setupToken = readOrCreateSetupToken(this.#setupTokenPath);
    }
  }

  get required(): boolean {
    return this.ctx.config.authRequired;
  }

  get configured(): boolean {
    return this.ctx.store.appSettings.get<string>(PASSWORD_HASH_KEY) !== null;
  }

  /**
   * One-time secret that authorises choosing the first password.
   *
   * Without it, whoever reaches a fresh exposed server first could claim it. The
   * token is only ever shown where the operator already has access: the startup log
   * and an owner-only file in the data directory.
   */
  get setupToken(): string | null {
    return this.#setupToken;
  }

  get setupTokenPath(): string {
    return this.#setupTokenPath;
  }

  /** Sets the first password, which needs the setup token when login is enforced. */
  async bootstrap(password: string, setupToken: string | undefined): Promise<void> {
    if (this.configured) {
      throw new AppError('CONFLICT', 'An administrator password is already set.');
    }
    // Keyed on whether login is enforced, not on a code having been made at startup:
    // `pnpm auth:reset` can clear the password while the server is running, and the
    // first-password route must not then fall open to whoever asks first.
    if (this.required) this.#setupToken ??= readOrCreateSetupToken(this.#setupTokenPath);
    if (this.#setupToken !== null && !safeEqual(setupToken ?? '', this.#setupToken)) {
      this.ctx.store.audit.record({
        eventType: 'auth.setup-token-rejected',
        entityType: 'app',
        severity: 'warn',
      });
      throw new AppError(
        'UNAUTHORIZED',
        'The setup code is missing or wrong. It is printed in the server log at startup, and by `pnpm auth:reset`.',
      );
    }
    await this.setPassword(password);
    this.clearSetupToken();
  }

  async changePassword(currentPassword: string, password: string): Promise<void> {
    await this.checkPassword(currentPassword);
    await this.setPassword(password);
  }

  async login(password: string): Promise<Session> {
    await this.checkPassword(password);
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

  /** True when this request may see the API: login is off, or it carries a session. */
  isAuthorized(request: FastifyRequest): boolean {
    return !this.required || this.verify(sessionCookie(request)) !== null;
  }

  private async checkPassword(password: string): Promise<void> {
    const digest = this.ctx.store.appSettings.get<string>(PASSWORD_HASH_KEY);
    if (!digest) throw new AppError('UNAUTHORIZED', 'No administrator password has been set.');

    const valid = await this.withHashSlot(() => argonVerify(digest, password).catch(() => false));
    if (!valid) {
      this.ctx.store.audit.record({
        eventType: 'auth.failed',
        entityType: 'app',
        severity: 'warn',
      });
      throw new AppError('UNAUTHORIZED', 'Incorrect password.');
    }
  }

  private async setPassword(password: string): Promise<void> {
    if (password.length < 12) {
      throw new AppError('VALIDATION_FAILED', 'Choose a password of at least 12 characters.');
    }
    // Argon2id with defaults tuned by the library for interactive logins.
    const digest = await this.withHashSlot(() => argonHash(password, { algorithm: 2 }));
    this.ctx.store.appSettings.set(PASSWORD_HASH_KEY, digest);
    this.#sessions.clear();
    this.ctx.store.audit.record({
      eventType: 'auth.password-set',
      entityType: 'app',
      severity: 'warn',
    });
  }

  private async withHashSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#hashesInFlight >= MAX_CONCURRENT_HASHES) {
      throw new AppError('RATE_LIMITED', 'Too many sign-in attempts at once. Try again shortly.');
    }
    this.#hashesInFlight += 1;
    try {
      return await work();
    } finally {
      this.#hashesInFlight -= 1;
    }
  }

  private clearSetupToken(): void {
    this.#setupToken = null;
    try {
      unlinkSync(this.#setupTokenPath);
    } catch {
      // Already gone is the desired end state.
    }
  }
}

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILENAME);
}

/** Reuses a token across restarts so the one in an earlier log line keeps working. */
export function readOrCreateSetupToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomToken(18);
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export function registerAuth(app: AppServer, ctx: AppContext, auth: AuthService): void {
  app.decorate('auth', auth);

  /**
   * Default-deny for the browser API.
   *
   * The decision uses the route that actually matched, never the raw URL: the
   * router decodes percent-escapes before matching, so `/%61pi/v1/devices` reaches
   * the same handler as `/api/v1/devices`. A route opts out only by declaring
   * `config: { public: true }`.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url;
    // No route matched: the 404 handler answers, which exposes nothing.
    if (route === undefined) return;
    // The bridge endpoints carry their own bearer token and source check.
    if (!route.startsWith('/api/')) return;
    if (request.routeOptions.config?.public) return;
    if (!auth.required) return;

    const session = auth.verify(sessionCookie(request));
    if (!session) {
      await reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Sign in to use this API.' },
      });
      return;
    }

    // Double-submit CSRF: a cross-site form cannot read the cookie to set the header.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, session.csrf)) {
        await reply.status(403).send({
          error: { code: 'UNAUTHORIZED', message: 'Missing or invalid CSRF token.' },
        });
        return;
      }
    }
  });

  app.post(
    '/api/v1/auth/login',
    { config: { public: true, rateLimit: PASSWORD_RATE_LIMIT } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { password?: string };
      const session = await auth.login(String(body.password ?? ''));
      setSessionCookies(reply, session.id, session.csrf, request.protocol === 'https');
      return { ok: true, csrf: session.csrf };
    },
  );

  app.post('/api/v1/auth/logout', { config: { public: true } }, async (request, reply) => {
    auth.logout(sessionCookie(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/state', { config: { public: true } }, async (request) => ({
    required: auth.required,
    configured: auth.configured,
    authenticated: auth.verify(sessionCookie(request)) !== null,
  }));

  /**
   * Sets the first password, or changes it.
   *
   * Public so a fresh server can bootstrap itself, but never unguarded: the first
   * password needs the setup token when login is enforced, and every later change
   * needs the current password.
   */
  app.post(
    '/api/v1/auth/password',
    { config: { public: true, rateLimit: PASSWORD_RATE_LIMIT } },
    async (request) => {
      const body = (request.body ?? {}) as {
        password?: string;
        currentPassword?: string;
        setupToken?: string;
      };
      const password = String(body.password ?? '');
      if (auth.configured) {
        await auth.changePassword(String(body.currentPassword ?? ''), password);
      } else {
        await auth.bootstrap(password, body.setupToken);
      }
      return { ok: true };
    },
  );
}

function sessionCookie(request: FastifyRequest): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[SESSION_COOKIE];
}

function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
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
    // Decided per request: a browser discards a Secure cookie received over plain
    // HTTP, so marking it on a LAN address would make signing in impossible.
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
  interface FastifyContextConfig {
    /** Reachable without a session. Everything else under /api/ requires one. */
    public?: boolean;
  }
}
