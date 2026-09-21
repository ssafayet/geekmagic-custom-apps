import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed multipart parts, when the body was multipart/form-data. */
  parts: Array<{
    name: string;
    filename: string | null;
    contentType: string | null;
    bytes: number;
  }>;
  body: Buffer;
}

export type SimulatorProfile =
  | 'stock-ultra'
  | 'stock-pro'
  | 'stock-pro-upload-disconnect'
  | 'stock-pro-quirky-delete'
  | 'stock-ultra-select-fail'
  | 'sd-pro'
  | 'unknown'
  | 'legacy'
  | 'malformed-json'
  | 'slow'
  | 'oversized-filelist';

export interface SimulatorOptions {
  profile: SimulatorProfile;
  /** Files reported by the album/photo listing endpoints. */
  files?: string[];
  slowMs?: number;
}

/**
 * Fake GeekMagic firmware.
 *
 * Contract tests assert the exact method, path, multipart field name, filename and
 * operation order each adapter uses, so adapter behaviour is pinned without needing
 * physical hardware in CI. The awkward real-world behaviours — a PRO that drops the
 * upload connection after storing the file, an Ultra that answers FAIL to image
 * selection — are first-class profiles here rather than afterthoughts.
 */
export class DeviceSimulator {
  readonly requests: RecordedRequest[] = [];
  #server: Server | null = null;
  #files: Set<string>;
  #brightness = 50;
  #theme = 0;
  #currentImage: string | null = null;
  #photoStates = new Map<string, boolean>();
  #themeStates = new Map<string, boolean>([
    ['0', true],
    ['1', false],
    ['2', false],
  ]);

  constructor(private readonly options: SimulatorOptions) {
    this.#files = new Set(options.files ?? []);
    for (const file of this.#files) this.#photoStates.set(file, true);
  }

  get profile(): SimulatorProfile {
    return this.options.profile;
  }

  get files(): string[] {
    return [...this.#files];
  }

  get theme(): number {
    return this.#theme;
  }

  get brightness(): number {
    return this.#brightness;
  }

  get currentImage(): string | null {
    return this.#currentImage;
  }

  photoEnabled(name: string): boolean {
    return this.#photoStates.get(name) ?? false;
  }

  themeEnabled(id: string): boolean {
    return this.#themeStates.get(id) ?? false;
  }

  /** Ordered list of `METHOD /path` strings, for asserting operation order. */
  get trace(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }

  pathsMatching(pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => pattern.test(request.path));
  }

  reset(): void {
    this.requests.length = 0;
  }

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    const address = this.#server.address() as AddressInfo;
    return `127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const url = new URL(request.url ?? '/', 'http://device');
    const query = Object.fromEntries(url.searchParams.entries());

    this.requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value ?? ''),
        ]),
      ),
      parts: parseMultipart(body, String(request.headers['content-type'] ?? '')),
      body,
    });

    if (this.options.profile === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, this.options.slowMs ?? 10_000));
    }

    const route = `${request.method} ${url.pathname}`;
    const handled = this.route(route, url, query, body, response);
    if (!handled) notFound(response);
  }

  private route(
    route: string,
    url: URL,
    query: Record<string, string>,
    body: Buffer,
    response: ServerResponse,
  ): boolean {
    const profile = this.options.profile;

    // ---- identity endpoints (detection order matters) ----
    if (route === 'GET /v.json') {
      switch (profile) {
        case 'stock-ultra':
        case 'stock-ultra-select-fail':
          return json(response, { m: 'SmallTV Ultra', v: '1.4.2' });
        case 'stock-pro':
        case 'stock-pro-upload-disconnect':
        case 'stock-pro-quirky-delete':
          return json(response, { m: 'SmallTV PRO', v: 'V3.4.88EN' });
        case 'malformed-json':
          return raw(response, 200, 'application/json', '{"m": "SmallTV Ultra", ');
        default:
          return notFound(response);
      }
    }

    if (route === 'GET /.sys/app.json') {
      if (profile === 'stock-pro' || profile === 'stock-pro-upload-disconnect') {
        return json(response, {
          theme: this.#theme,
          brt: this.#brightness,
          img: this.#currentImage,
        });
      }
      return notFound(response);
    }

    if (route === 'GET /app.json') {
      if (profile === 'stock-ultra' || profile === 'stock-ultra-select-fail') {
        return json(response, {
          theme: this.#theme,
          brt: this.#brightness,
          img: this.#currentImage,
        });
      }
      return notFound(response);
    }

    if (route === 'GET /theme/list') {
      if (profile !== 'sd-pro') return notFound(response);
      return json(response, {
        themes: [...this.#themeStates.entries()].map(([id, state]) => ({
          id: Number(id),
          name: `Theme ${id}`,
          state: state ? 1 : 0,
        })),
      });
    }

    if (route === 'GET /' && profile === 'legacy') {
      return raw(
        response,
        200,
        'text/html',
        `<html><body><div id="giflist"></div><form action='/connect' method='post'></form></body></html>`,
      );
    }

    // ---- stock endpoints ----
    if (route === 'GET /set') {
      if (query['theme'] !== undefined) this.#theme = Number(query['theme']);
      if (query['brt'] !== undefined) this.#brightness = Number(query['brt']);
      if (query['img'] !== undefined) {
        if (profile === 'stock-ultra-select-fail') {
          // Firmware reports FAIL but has in fact swapped the displayed file.
          this.#currentImage = query['img'];
          return raw(response, 200, 'text/plain', 'FAIL');
        }
        this.#currentImage = query['img'];
      }
      return raw(response, 200, 'text/plain', 'OK');
    }

    if (route === 'POST /doUpload') {
      const parts = parseMultipart(body, 'multipart/form-data');
      const filename = parts[0]?.filename ?? 'unknown';
      this.#files.add(filename);
      this.#photoStates.set(filename, true);

      if (profile === 'stock-pro-upload-disconnect') {
        // Store the file, then hang up without a complete response.
        response.socket?.destroy();
        return true;
      }
      return raw(response, 200, 'text/plain', 'OK');
    }

    if (route === 'GET /filelist') {
      if (profile === 'oversized-filelist') {
        const filler = Array.from(
          { length: 40_000 },
          (_, i) => `<a href="/image/pad${i}.jpg">pad${i}.jpg</a>`,
        );
        return raw(response, 200, 'text/html', `<html><body>${filler.join('')}</body></html>`);
      }
      const dir = query['dir'] ?? '/image/';
      // Real stock PRO firmware emits a doubled slash here, and its delete handler
      // only honours that same form.
      const links = [...this.#files].map((file) => `<a href='${dir}/${file}'>${file}</a>`);
      return raw(response, 200, 'text/html', `<html><body>${links.join('<br>')}</body></html>`);
    }

    if (route === 'GET /delete') {
      const target = query['file'] ?? '';
      const name = target.split('/').filter(Boolean).pop() ?? '';

      if (profile === 'stock-pro-quirky-delete') {
        // Observed on V3.4.88EN: the single-slash form answers OK and deletes
        // nothing, while the doubled-slash form answers Failed and deletes the
        // file. The body is therefore worthless; only a re-listing is truthful.
        if (target.includes('//')) {
          this.#files.delete(name);
          this.#photoStates.delete(name);
          return raw(response, 200, 'text/plain', 'Failed');
        }
        return raw(response, 200, 'text/plain', 'OK');
      }

      this.#files.delete(name);
      this.#photoStates.delete(name);
      return raw(response, 200, 'text/plain', 'OK');
    }

    if (route === 'GET /.sys/album.json') {
      if (profile !== 'stock-pro' && profile !== 'stock-pro-upload-disconnect')
        return notFound(response);
      return json(response, { i_i: 1, gif_loop: 1, autoplay: 1 });
    }

    // Album file download during backup.
    if (url.pathname.startsWith('/image/') && route.startsWith('GET ')) {
      const name = url.pathname.split('/').filter(Boolean).pop() ?? '';
      if (!this.#files.has(name)) return notFound(response);
      return rawBuffer(response, 200, 'image/jpeg', Buffer.from(`fake-image-bytes:${name}`));
    }

    // ---- SD_PRO endpoints ----
    if (route === 'GET /config') {
      if (profile !== 'sd-pro') return notFound(response);
      return json(response, { theme: this.#theme, lcd_brightness: this.#brightness });
    }

    if (route === 'POST /photo/upload') {
      const parts = parseMultipart(body, 'multipart/form-data');
      const filename = parts[0]?.filename ?? 'unknown';
      this.#files.add(filename);
      this.#photoStates.set(filename, this.#photoStates.get(filename) ?? false);
      return json(response, { ok: true });
    }

    if (route === 'GET /photo/list') {
      return json(response, {
        photos: [...this.#files].map((name) => ({
          name,
          state: this.#photoStates.get(name) ? 1 : 0,
          size: 1024,
        })),
      });
    }

    if (route === 'GET /photo/toggle') {
      const name = query['name'] ?? '';
      this.#photoStates.set(name, query['state'] === '1');
      return json(response, { ok: true });
    }

    if (route === 'GET /photo/interval') return json(response, { ok: true });

    if (route === 'GET /theme/toggle') {
      this.#themeStates.set(String(query['id'] ?? ''), query['state'] === '1');
      return json(response, { ok: true });
    }

    if (route === 'GET /api/set') {
      if (query['key'] === 'theme') this.#theme = Number(query['value']);
      if (query['key'] === 'lcd_brightness') this.#brightness = Number(query['value']);
      return json(response, { ok: true });
    }

    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseMultipart(body: Buffer, contentType: string): RecordedRequest['parts'] {
  if (!contentType.includes('multipart/form-data')) return [];
  const text = body.toString('latin1');
  const boundaryMatch = text.match(/^--([^\r\n]+)\r\n/);
  if (!boundaryMatch?.[1]) return [];

  const boundary = `--${boundaryMatch[1]}`;
  const segments = text.split(boundary).slice(1, -1);

  return segments.map((segment) => {
    const headerEnd = segment.indexOf('\r\n\r\n');
    const headerBlock = segment.slice(0, headerEnd);
    const content = segment.slice(headerEnd + 4, segment.length - 2);
    const name = headerBlock.match(/name="([^"]*)"/)?.[1] ?? '';
    const filename = headerBlock.match(/filename="([^"]*)"/)?.[1] ?? null;
    const partContentType = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] ?? null;
    return {
      name,
      filename,
      contentType: partContentType,
      bytes: Buffer.from(content, 'latin1').length,
    };
  });
}

function json(response: ServerResponse, value: unknown): boolean {
  return raw(response, 200, 'application/json', JSON.stringify(value));
}

function raw(response: ServerResponse, status: number, contentType: string, body: string): boolean {
  return rawBuffer(response, status, contentType, Buffer.from(body, 'utf8'));
}

function rawBuffer(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
): boolean {
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  response.end(body);
  return true;
}

function notFound(response: ServerResponse): boolean {
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not Found');
  return true;
}
