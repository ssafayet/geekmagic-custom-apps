import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, jsonBody, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Binding beyond loopback is what turns authentication on, unless overridden. */
async function exposedApp(): Promise<TestApp> {
  return createTestApp({
    configOverrides: { host: '0.0.0.0', isExposed: true, authRequired: true },
  });
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
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: 'a-long-enough-password' },
    });
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
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('issues a session and CSRF token on login, and enforces CSRF on writes', async () => {
    harness = await exposedApp();
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: 'a-long-enough-password' },
    });

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
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { password: 'a-long-enough-password' },
    });

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
