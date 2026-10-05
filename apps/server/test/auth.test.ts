import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, jsonBody, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Binding beyond loopback is what turns authentication on, unless overridden. */
async function exposedApp(overrides: Partial<TestApp['ctx']['config']> = {}): Promise<TestApp> {
  return createTestApp({
    configOverrides: { host: '0.0.0.0', isExposed: true, authRequired: true, ...overrides },
  });
}

const PASSWORD = 'a-long-enough-password';

/** Sets the first password the way an operator does: with the code from the log. */
async function bootstrap(target: TestApp, password = PASSWORD) {
  return target.app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    payload: { password, setupToken: target.app.auth.setupToken },
  });
}

async function signIn(target: TestApp): Promise<{ cookie: string; csrf: string }> {
  await bootstrap(target);
  const login = await target.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: PASSWORD },
  });
  const cookies = login.cookies as Array<{ name: string; value: string }>;
  const session = cookies.find((cookie) => cookie.name === 'gca_session')?.value ?? '';
  const csrf = cookies.find((cookie) => cookie.name === 'gca_csrf')?.value ?? '';
  return { cookie: `gca_session=${session}; gca_csrf=${csrf}`, csrf };
}

describe('loopback deployment', () => {
  it('does not require authentication', async () => {
    harness = await createTestApp();

    const state = jsonBody<{ required: boolean; configured: boolean }>(
      await harness.app.inject({ method: 'GET', url: '/api/v1/auth/state' }),
    );
    expect(state.required).toBe(false);

    const devices = await harness.app.inject({ method: 'GET', url: '/api/v1/devices' });
    expect(devices.statusCode).toBe(200);
  });
});

describe('exposed deployment', () => {
  it('requires authentication for the API', async () => {
    harness = await exposedApp();

    const state = jsonBody<{ required: boolean; configured: boolean }>(
      await harness.app.inject({ method: 'GET', url: '/api/v1/auth/state' }),
    );
    expect(state).toMatchObject({ required: true, configured: false });

    const devices = await harness.app.inject({ method: 'GET', url: '/api/v1/devices' });
    expect(devices.statusCode).toBe(401);
  });

  it('leaves health reachable so a container healthcheck still works', async () => {
    harness = await exposedApp();
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
  });

  it('allows the very first password to be set, then locks that route down', async () => {
    harness = await exposedApp();

    // Without this bootstrap the deployment could never authenticate itself.
    const first = await bootstrap(harness);
    expect(first.statusCode).toBe(200);

    // A second change now needs the current password.
    const withoutCurrent = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: 'another-long-password' },
    });
    expect(withoutCurrent.statusCode).toBe(401);
  });

  it('rejects a short password', async () => {
    harness = await exposedApp();
    const response = await bootstrap(harness, 'short');
    expect(response.statusCode).toBe(400);
  });

  it('issues a session and CSRF token on login, and enforces CSRF on writes', async () => {
    harness = await exposedApp();
    await bootstrap(harness);

    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'a-long-enough-password' },
    });
    expect(login.statusCode).toBe(200);

    const cookies = login.cookies as Array<{
      name: string;
      value: string;
      httpOnly?: boolean;
      sameSite?: string;
    }>;
    const session = cookies.find((cookie) => cookie.name === 'gca_session');
    const csrf = cookies.find((cookie) => cookie.name === 'gca_csrf');

    expect(session?.httpOnly).toBe(true);
    // The CSRF cookie is deliberately readable: the UI echoes it back in a header.
    expect(csrf?.httpOnly).not.toBe(true);

    const cookieHeader = `gca_session=${session?.value}; gca_csrf=${csrf?.value}`;

    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { cookie: cookieHeader },
    });
    expect(read.statusCode).toBe(200);

    // A write without the CSRF header is refused even with a valid session.
    const writeWithoutCsrf = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader },
      payload: { jpegQuality: 88 },
    });
    expect(writeWithoutCsrf.statusCode).toBe(403);

    const writeWithCsrf = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: cookieHeader, 'x-gca-csrf': csrf?.value ?? '' },
      payload: { jpegQuality: 88 },
    });
    expect(writeWithCsrf.statusCode).toBe(200);
  });

  it('rejects a wrong password', async () => {
    harness = await exposedApp();
    await bootstrap(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong-password-entirely' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps the loopback bridge endpoint outside the browser auth scheme', async () => {
    harness = await exposedApp();
    const token = harness.ctx.claudeSettings.readOrCreateToken();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: '2.1.0' },
      remoteAddress: '127.0.0.1',
    });

    // No session cookie, no CSRF header, yet accepted: it has its own controls.
    expect(response.statusCode).toBe(200);
  });
});

describe('route matching', () => {
  // The router decodes percent-escapes before matching, so any check on the raw URL
  // is bypassed by spelling the same path differently. These reached handlers once.
  it.each([
    '/api/v1/devices',
    '/%61pi/v1/devices',
    '/api/v1/%64evices',
    '/api/v1/devices/',
    '/./api/v1/devices',
    '/api/v1/health/../devices',
  ])('refuses %s without a session', async (url) => {
    harness ??= await exposedApp();
    await bootstrap(harness);

    const response = await harness.app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an encoded write without a session', async () => {
    harness = await exposedApp();
    await bootstrap(harness);

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/%61pi/v1/settings',
      payload: { discoveryEnabled: false },
    });

    expect(response.statusCode).toBe(401);
    expect(harness.ctx.coreSettings().discoveryEnabled).toBe(true);
  });

  it('never answers an unmatched spelling with API data', async () => {
    harness = await exposedApp();
    await bootstrap(harness);

    for (const url of ['/API/v1/devices', '/api%2Fv1/devices', '/%2561pi/v1/devices']) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.body).not.toBe('[]');
    }
  });
});

describe('first password', () => {
  it('needs the setup code on an exposed server', async () => {
    harness = await exposedApp();

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: PASSWORD },
    });
    const wrong = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: PASSWORD, setupToken: 'not-the-setup-code' },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(harness.app.auth.configured).toBe(false);
  });

  it('writes the code owner-only and removes it once used', async () => {
    harness = await exposedApp();
    const path = harness.app.auth.setupTokenPath;
    expect(readFileSync(path, 'utf8')).toBe(harness.app.auth.setupToken);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);

    await bootstrap(harness);

    expect(existsSync(path)).toBe(false);
    expect(harness.app.auth.setupToken).toBeNull();
  });

  // Loopback needs no login, so a code would guard nothing the caller lacks.
  it('is not asked for when login is not enforced', async () => {
    harness = await createTestApp();

    expect(harness.app.auth.setupToken).toBeNull();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('sessions', () => {
  it('reports whether this browser is signed in', async () => {
    harness = await exposedApp();
    const { cookie } = await signIn(harness);

    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/state' });
    const signedIn = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/state',
      headers: { cookie },
    });

    expect(jsonBody(anonymous)).toMatchObject({ required: true, authenticated: false });
    expect(jsonBody(signedIn)).toMatchObject({ required: true, authenticated: true });
  });

  // A browser discards a Secure cookie that arrives over plain HTTP, which is how
  // a LAN address is normally reached; marking it there makes signing in impossible.
  it('marks cookies Secure only when the request arrived over HTTPS', async () => {
    harness = await exposedApp({ trustProxy: ['loopback'] });
    await bootstrap(harness);

    const plain = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD },
    });
    const proxied = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { password: PASSWORD },
    });

    const secureOf = (response: typeof plain) =>
      (response.cookies as Array<{ name: string; secure?: boolean }>).find(
        (cookie) => cookie.name === 'gca_session',
      )?.secure;
    expect(secureOf(plain)).not.toBe(true);
    expect(secureOf(proxied)).toBe(true);
  });

  it('rate-limits password attempts per address', async () => {
    harness = await exposedApp();
    await bootstrap(harness);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'wrong-password-entirely' },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('health', () => {
  it('tells an anonymous caller only that the server is up', async () => {
    harness = await exposedApp();
    const { cookie } = await signIn(harness);

    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
    const signedIn = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { cookie },
    });

    expect(jsonBody(anonymous)).toEqual({ status: 'ok' });
    expect(jsonBody(signedIn)).toHaveProperty('modules');
  });

  it('keeps full details where login is not enforced', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(jsonBody(response)).toHaveProperty('version');
  });
});

/**
 * Docker publishes the port through NAT, so a post from the host arrives from the
 * bridge gateway rather than 127.0.0.1. Verified against a real container: without
 * the allowance the request is rejected with "Rejected non-local bridge request".
 */
describe('authentication override', () => {
  // A container publishing 127.0.0.1:3210 binds 0.0.0.0 internally but is reachable
  // only from the host. Without this the UI is locked behind a password that no
  // screen exists to set.
  it('serves the API on an exposed bind when auth is explicitly disabled', async () => {
    harness = await createTestApp({
      configOverrides: { host: '0.0.0.0', isExposed: true, authRequired: false },
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(200);
  });

  it('can demand a login on a loopback bind', async () => {
    harness = await createTestApp({ configOverrides: { authRequired: true } });

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/status' });

    expect(response.statusCode).toBe(401);
  });
});

describe('bridge ingestion source policy', () => {
  const GATEWAY = '172.17.0.1';

  function payload(harness: TestApp) {
    return {
      method: 'POST' as const,
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${harness.ctx.claudeSettings.readOrCreateToken()}` },
      payload: { version: '2.1.0' },
      remoteAddress: GATEWAY,
    };
  }

  it('rejects a non-loopback source by default', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject(payload(harness));

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('local connections');
  });

  it('accepts a private source once the allowance is set', async () => {
    harness = await createTestApp({
      configOverrides: { bridgeAllowPrivateSources: true },
    });

    const response = await harness.app.inject(payload(harness));

    expect(response.statusCode).toBe(200);
  });

  it('still rejects a public source with the allowance set', async () => {
    harness = await createTestApp({
      configOverrides: { bridgeAllowPrivateSources: true },
    });

    const response = await harness.app.inject({
      ...payload(harness),
      remoteAddress: '203.0.113.7',
    });

    expect(response.statusCode).toBe(401);
  });

  // The allowance widens which addresses may connect; it is not a way in.
  it('still requires the token with the allowance set', async () => {
    harness = await createTestApp({
      configOverrides: { bridgeAllowPrivateSources: true },
    });

    const response = await harness.app.inject({
      ...payload(harness),
      headers: { authorization: 'Bearer not-the-token-at-all' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Invalid bridge token');
  });
});
