import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, jsonBody, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Binding beyond loopback is what turns authentication on. */
async function exposedApp(): Promise<TestApp> {
  return createTestApp({ configOverrides: { host: '0.0.0.0', isExposed: true } });
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
