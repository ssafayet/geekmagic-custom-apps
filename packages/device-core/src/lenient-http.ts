import { connect, type Socket } from 'node:net';

/**
 * Minimal HTTP/1.1 client for firmware that standard clients refuse to talk to.
 *
 * GeekMagic SmallTV-PRO firmware (observed on V3.4.88EN) emits a duplicated
 * `Content-Length` header on `/filelist`:
 *
 *     Content-Length: 1133
 *     Content-Length: 1133
 *
 * Node's llhttp parser and undici both reject that outright, and they are right to:
 * conflicting Content-Length headers are a classic request-smuggling vector. But here
 * the values are identical and match the body exactly, so there is no ambiguity to
 * exploit — the firmware is merely sloppy. Without tolerating it, every album
 * operation on a real PRO fails: listing, verification, backup and pruning.
 *
 * This reader is therefore deliberately narrow. It accepts duplicate `Content-Length`
 * only when every value agrees, and rejects conflicting values — which is the case
 * that actually matters for security. It keeps the same byte cap and timeout as the
 * primary transport, and never follows redirects because it does not implement them.
 */

export interface LenientRequestOptions {
  /** Already resolved and policy-validated by the caller. */
  address: string;
  port: number;
  /** Value for the Host header; may differ from `address`. */
  hostHeader: string;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface LenientResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_STATUS_LINE_BYTES = 8 * 1024;

export class LenientHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LenientHttpError';
  }
}

/** True when an error from the primary client is the duplicate/mismatched length case. */
export function isContentLengthQuirk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /content-length/i.test(message) && /(does not match|duplicate|mismatch)/i.test(message);
}

export async function lenientRequest(options: LenientRequestOptions): Promise<LenientResponse> {
  const { address, port, hostHeader, method, path, timeoutMs, maxBytes } = options;

  return new Promise<LenientResponse>((resolve, reject) => {
    let settled = false;
    let socket: Socket | null = null;

    const finish = (error: Error | null, value?: LenientResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value as LenientResponse);
    };

    const timer = setTimeout(() => finish(new LenientHttpError('Request timed out')), timeoutMs);
    const onAbort = () => finish(new LenientHttpError('Request aborted'));

    if (options.signal?.aborted) {
      clearTimeout(timer);
      reject(new LenientHttpError('Request aborted'));
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket = connect({ host: address, port });
    socket.setNoDelay(true);

    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;

    socket.on('connect', () => {
      const headerLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Connection: close',
        ...Object.entries(options.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
      ];
      socket?.write(`${headerLines.join('\r\n')}\r\n\r\n`);
      if (options.body) socket?.write(options.body);
    });

    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // Cap total bytes read, header block included, so a hostile or broken device
      // cannot make us buffer without limit.
      if (received > maxBytes + MAX_HEADER_BYTES) {
        truncated = true;
        chunks.push(chunk);
        socket?.destroy();
        return;
      }
      chunks.push(chunk);
    });

    socket.on('error', (error) => finish(new LenientHttpError(error.message)));

    socket.on('close', () => {
      if (settled) return;
      try {
        const parsed = parseResponse(Buffer.concat(chunks), maxBytes);
        finish(null, { ...parsed, truncated: truncated || parsed.truncated });
      } catch (error) {
        finish(error instanceof Error ? error : new LenientHttpError(String(error)));
      }
    });
  });
}

function parseResponse(raw: Buffer, maxBytes: number): LenientResponse {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new LenientHttpError('Response headers were never terminated');
  if (headerEnd > MAX_HEADER_BYTES) throw new LenientHttpError('Response headers are too large');

  const headerText = raw.subarray(0, headerEnd).toString('latin1');
  const lines = headerText.split('\r\n');
  const statusLine = lines[0] ?? '';
  if (statusLine.length > MAX_STATUS_LINE_BYTES) {
    throw new LenientHttpError('Response status line is too large');
  }

  const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!statusMatch?.[1])
    throw new LenientHttpError(`Malformed status line: ${statusLine.slice(0, 64)}`);
  const status = Number(statusMatch[1]);

  const headers: Record<string, string> = {};
  const contentLengths: string[] = [];

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'content-length') {
      contentLengths.push(value);
      continue;
    }
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }

  // The whole point of this client: identical duplicates are tolerated, conflicting
  // ones are refused. Conflicting values are the smuggling case and are never safe.
  if (contentLengths.length > 0) {
    const distinct = [...new Set(contentLengths)];
    if (distinct.length > 1) {
      throw new LenientHttpError(
        `Conflicting Content-Length headers (${distinct.join(', ')}); refusing to guess`,
      );
    }
    headers['content-length'] = distinct[0] as string;
  }

  let body = raw.subarray(headerEnd + 4);
  let truncated = false;

  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunked(body, maxBytes);
  } else {
    const declared = Number(headers['content-length']);
    // Trust the declared length only when it is sane and we actually received it.
    if (Number.isInteger(declared) && declared >= 0 && declared <= body.length) {
      body = body.subarray(0, declared);
    }
  }

  if (body.length > maxBytes) {
    body = body.subarray(0, maxBytes);
    truncated = true;
  }

  return { status, headers, body, truncated };
}

function decodeChunked(raw: Buffer, maxBytes: number): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  let total = 0;

  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) break;

    // A chunk-size line may carry extensions after a semicolon.
    const sizeText = raw.subarray(offset, lineEnd).toString('latin1').split(';')[0]?.trim() ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) break;
    if (size === 0) break;

    const start = lineEnd + 2;
    const end = Math.min(start + size, raw.length);
    out.push(raw.subarray(start, end));

    total += end - start;
    if (total > maxBytes) break;

    offset = end + 2;
  }

  return Buffer.concat(out);
}
