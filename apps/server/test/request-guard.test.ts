import { afterEach, describe, expect, it } from 'vitest';
import { hostnameOf, isAcceptableHost, isSameOrigin } from '../src/request-guard.js';
import { createTestApp, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/**
 * DNS rebinding: a page on an attacker's domain re-points that domain at
 * 127.0.0.1 and talks to the unauthenticated loopback server as if same-origin. The
 * browser still sends the attacker's name as Host, which is what these refuse.
 */
describe('Host header', () => {
  it('refuses a public name it was not told about', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { host: 'rebind.attacker.example:3210' },
    });

    expect(response.statusCode).toBe(421);
    // The public base URL comes first, because it also turns on the login.
    expect(response.json().error.message).toMatch(/set GCA_PUBLIC_BASE_URL/);
  });

  // None of these can be pointed at this machine by an outside party, so a local
  // or LAN install works with no configuration at all.
  it.each([
    'localhost:3210',
    '127.0.0.1:3210',
    '[::1]:3210',
    '192.168.1.20:3210',
    '[fd00::20]:3210',
    'raspberrypi:3210',
    'nas.local:3210',
    'displays.home.arpa',
    'pi.lan',
  ])('answers %s without configuration', async (host) => {
    harness ??= await createTestApp();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { host },
    });

    expect(response.statusCode).toBe(200);
  });

  it('answers a public name once it is declared', async () => {
    harness = await createTestApp({
      configOverrides: {
        allowedHosts: ['displays.example.com'],
        publicBaseUrl: 'https://panel.example.org',
      },
    });

    for (const host of ['displays.example.com', 'panel.example.org']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/devices',
        headers: { host },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('guards the bridge endpoint too', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: {
        host: 'rebind.attacker.example',
        authorization: `Bearer ${harness.ctx.claudeSettings.readOrCreateToken()}`,
      },
      payload: { version: '2.1.0' },
    });

    expect(response.statusCode).toBe(421);
  });
});

describe('cross-origin writes', () => {
  it('refuses a write whose Origin names another site', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { host: 'localhost:3210', origin: 'https://attacker.example' },
      payload: { discoveryEnabled: false },
    });

    expect(response.statusCode).toBe(403);
    expect(harness.ctx.coreSettings().discoveryEnabled).toBe(true);
  });

  it('refuses the opaque "null" origin', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      headers: { origin: 'null' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts the UI writing to its own origin', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { host: '192.168.1.20:3210', origin: 'http://192.168.1.20:3210' },
      payload: { discoveryEnabled: false },
    });

    expect(response.statusCode).toBe(200);
  });

  // The Vite dev server proxies from :5173 to :3210 without rewriting Host.
  it('treats loopback as one origin across ports', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      headers: { host: '127.0.0.1:3210', origin: 'http://localhost:5173' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('leaves clients that send no Origin to the other controls', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  // text/plain is what a cross-site form or no-cors fetch can send without a
  // preflight; the API only ever takes JSON.
  it('refuses a text/plain body', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(415);
  });
});

describe('response headers', () => {
  it('sends a content security policy and keeps API answers out of caches', async () => {
    harness = await createTestApp();

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/settings' });

    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('helpers', () => {
  it('extracts the hostname from a Host header', () => {
    expect(hostnameOf('Example.COM:8080')).toBe('example.com');
    expect(hostnameOf('[::1]:3210')).toBe('::1');
    expect(hostnameOf('nas.local.')).toBe('nas.local');
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('bad host')).toBeNull();
  });

  it('does not mistake a lookalike public name for a private one', () => {
    const none = new Set<string>();
    expect(isAcceptableHost('local.attacker.example', none)).toBe(false);
    expect(isAcceptableHost('attacker-local.com', none)).toBe(false);
    expect(isAcceptableHost('localhost.attacker.example', none)).toBe(false);
  });

  it('matches origins on host and port', () => {
    expect(isSameOrigin('http://nas.local:3210', 'nas.local:3210', null)).toBe(true);
    expect(isSameOrigin('http://nas.local:9999', 'nas.local:3210', null)).toBe(false);
    expect(isSameOrigin('https://panel.example.org', 'internal:3210', 'panel.example.org')).toBe(
      true,
    );
    expect(isSameOrigin('not a url', 'localhost', null)).toBe(false);
  });
});
