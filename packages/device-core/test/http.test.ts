import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DeviceTransport, encodeQueryComponent, splitHostPort } from '../src/http.js';

const LOOPBACK_POLICY = { allowlist: [], allowLoopback: true, allowPublic: false };
const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('splitHostPort', () => {
  it.each([
    ['192.168.1.5', { hostname: '192.168.1.5', port: 80 }],
    ['192.168.1.5:8080', { hostname: '192.168.1.5', port: 8080 }],
    ['http://192.168.1.5:8080/', { hostname: '192.168.1.5', port: 8080 }],
    ['http://display.local', { hostname: 'display.local', port: 80 }],
    ['[fe80::1]:8080', { hostname: 'fe80::1', port: 8080 }],
    ['fe80::1', { hostname: 'fe80::1', port: 80 }],
    ['display.local/', { hostname: 'display.local', port: 80 }],
  ])('parses %s', (input, expected) => {
    expect(splitHostPort(input, 80)).toEqual(expected);
  });
});

describe('encodeQueryComponent', () => {
  it('escapes characters that would otherwise break out of a query value', () => {
    expect(encodeQueryComponent('/image/my photo & more.jpg')).toBe(
      '%2Fimage%2Fmy%20photo%20%26%20more.jpg',
    );
    expect(encodeQueryComponent('a=b&c=d')).toBe('a%3Db%26c%3Dd');
  });
});

describe('DeviceTransport', () => {
  it('sends the configured hostname as the Host header while connecting by IP', async () => {
    let seenHost = '';
    const host = await serve((request, response) => {
      seenHost = String(request.headers.host);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY });
    const response = await transport.get('/ping');

    expect(response.ok).toBe(true);
    expect(seenHost).toContain('127.0.0.1');
  });

  it('does not follow redirects from a device', async () => {
    const host = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('should-not-be-reached');
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY });
    const response = await transport.get('/start');

    // A 3xx arrives as an ordinary non-OK response instead of being chased.
    expect(response.status).toBe(302);
    expect(response.text).not.toContain('should-not-be-reached');
  });

  it('caps oversized response bodies instead of buffering them', async () => {
    const host = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(200_000));
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY });
    const response = await transport.get('/big', { maxBytes: 1_024 });

    expect(response.truncated).toBe(true);
    expect(response.body.length).toBeLessThanOrEqual(1_024);
  });

  it('times out a slow device and reports DEVICE_UNREACHABLE', async () => {
    const host = await serve(() => {
      // Never respond.
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY, defaultTimeoutMs: 300 });

    await expect(transport.get('/hang')).rejects.toMatchObject({ code: 'DEVICE_UNREACHABLE' });
  });

  it('builds a single-part multipart body with the expected field and filename', async () => {
    let contentType = '';
    let body = Buffer.alloc(0);
    const host = await serve(async (request, response) => {
      contentType = String(request.headers['content-type']);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
      response.writeHead(200);
      response.end('OK');
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY });
    await transport.uploadFile({
      path: '/doUpload?dir=%2Fimage%2F',
      fieldName: 'file',
      filename: 'dashboard.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });

    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = body.toString('latin1');
    expect(text).toContain('name="file"');
    expect(text).toContain('filename="dashboard.jpg"');
    expect(text).toContain('Content-Type: image/jpeg');
  });

  it('sanitizes a filename before putting it in the multipart header', async () => {
    let body = Buffer.alloc(0);
    const host = await serve(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
      response.writeHead(200);
      response.end('OK');
    });

    const transport = new DeviceTransport({ host, policy: LOOPBACK_POLICY });
    await transport.uploadFile({
      path: '/doUpload',
      fieldName: 'file',
      filename: '../../etc/pa"sswd.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('x'),
    });

    const text = body.toString('latin1');
    expect(text).not.toContain('../../');
    expect(text).toMatch(/filename="[A-Za-z0-9._-]+"/);
  });

  it('refuses to contact a blocked address', async () => {
    const transport = new DeviceTransport({ host: '8.8.8.8' });
    await expect(transport.get('/')).rejects.toMatchObject({ code: 'DEVICE_ADDRESS_BLOCKED' });
  });
});
