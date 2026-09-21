import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceTransport } from '../src/http.js';
import { isContentLengthQuirk } from '../src/lenient-http.js';

const LOOPBACK_POLICY = { allowlist: [], allowLoopback: true, allowPublic: false };
const servers: Server[] = [];

/**
 * Raw TCP server so tests can emit responses a conforming HTTP server cannot,
 * which is exactly the situation real GeekMagic firmware puts us in.
 */
async function rawServer(respond: (path: string) => string): Promise<string> {
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const path = /^[A-Z]+ (\S+)/.exec(chunk.toString('latin1'))?.[1] ?? '/';
      socket.end(respond(path));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function transportFor(host: string): DeviceTransport {
  return new DeviceTransport({ host, policy: LOOPBACK_POLICY, defaultTimeoutMs: 3_000 });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('duplicate Content-Length firmware quirk', () => {
  // Reproduces GeekMagic SmallTV-PRO V3.4.88EN, which sends the header twice on
  // /filelist. undici rejects it outright, so without the fallback every album
  // operation on a real PRO fails.
  it('reads a response whose Content-Length is duplicated with identical values', async () => {
    const body = "<table id='list'><a href='/image//holiday.jpg'>holiday.jpg</a></table>";
    const host = await rawServer(
      () =>
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/html\r\n' +
        `Content-Length: ${body.length}\r\n` +
        `Content-Length: ${body.length}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );

    const response = await transportFor(host).get('/filelist?dir=/image/');

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.text).toContain('holiday.jpg');
    expect(response.headers['content-length']).toBe(String(body.length));
  });

  it('refuses a response whose Content-Length headers conflict', async () => {
    const body = 'hello world';
    const host = await rawServer(
      () =>
        'HTTP/1.1 200 OK\r\n' +
        'Content-Length: 11\r\n' +
        'Content-Length: 99\r\n' +
        'Connection: close\r\n\r\n' +
        body,
    );

    // Conflicting values are the request-smuggling case and must never be guessed at.
    await expect(transportFor(host).get('/filelist')).rejects.toMatchObject({
      code: 'DEVICE_UNREACHABLE',
    });
  });

  it('still reads a well-formed response through the normal client', async () => {
    const body = JSON.stringify({ m: 'SmallTV PRO', v: '3.4.88' });
    const host = await rawServer(
      () =>
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/json\r\n' +
        `Content-Length: ${body.length}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );

    const response = await transportFor(host).get('/v.json');
    expect(JSON.parse(response.text)).toMatchObject({ m: 'SmallTV PRO' });
  });

  it('caps an oversized body even on the lenient path', async () => {
    const body = 'x'.repeat(50_000);
    const host = await rawServer(
      () =>
        'HTTP/1.1 200 OK\r\n' +
        `Content-Length: ${body.length}\r\n` +
        `Content-Length: ${body.length}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );

    const response = await transportFor(host).get('/filelist', { maxBytes: 1_024 });

    expect(response.body.length).toBeLessThanOrEqual(1_024);
    expect(response.truncated).toBe(true);
  });

  it('propagates a non-2xx status from the lenient path', async () => {
    const host = await rawServer(
      () =>
        'HTTP/1.1 404 Not Found\r\n' +
        'Content-Length: 9\r\n' +
        'Content-Length: 9\r\n' +
        'Connection: close\r\n\r\n' +
        'not found',
    );

    const response = await transportFor(host).get('/missing');
    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
  });
});

describe('isContentLengthQuirk', () => {
  it('recognises the errors both clients raise', () => {
    expect(
      isContentLengthQuirk(new Error('Response body length does not match content-length header')),
    ).toBe(true);
    expect(isContentLengthQuirk(new Error('Parse Error: Duplicate Content-Length'))).toBe(true);
    expect(isContentLengthQuirk(new Error('socket hang up'))).toBe(false);
    expect(isContentLengthQuirk(new Error('content-length is fine'))).toBe(false);
  });
});
