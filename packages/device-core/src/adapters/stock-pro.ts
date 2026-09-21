import { createHash } from 'node:crypto';
import { AppError } from '@gca/shared';
import { capabilitiesFor } from '../capabilities.js';
import { detectProfile, type DetectionResult } from '../detection.js';
import { encodeQueryComponent, type DeviceTransport } from '../http.js';
import { numberOrNull, safeJson } from './stock-ultra.js';
import {
  MANAGED_FILENAME,
  MANAGED_IMAGE_DIR,
  type DeviceAdapter,
  type DeviceContentBackup,
  type DeviceFileEntry,
  type DeviceState,
  type EncodedFrameInput,
  type PrepareOptions,
  type UploadResult,
  type VerificationResult,
} from './types.js';

const PICTURE_THEME = 4;
const ALBUM_SETTINGS_PATH = '/set?i_i=1&gif_loop=1&autoplay=1';
/** Refuse to download a single album file larger than this during backup. */
const MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BACKUP_FILES = 64;

/**
 * Stock SmallTV-PRO.
 *
 * Picture mode is an album slideshow, so a deterministic dashboard means the managed
 * image has to be the only file in the album. That is destructive, which is why
 * takeover requires explicit consent and a verified backup first.
 */
export class StockProAdapter implements DeviceAdapter {
  readonly profile = 'stock-pro' as const;
  readonly capabilities = capabilitiesFor('stock-pro');
  #albumSettingsApplied = false;
  #themeApplied = false;

  constructor(private readonly transport: DeviceTransport) {}

  async probe(signal?: AbortSignal): Promise<DetectionResult> {
    return detectProfile(this.transport, signal ? { signal } : {});
  }

  async getState(signal?: AbortSignal): Promise<DeviceState> {
    // Stock PRO moved the manifest under /.sys; fall back for older builds.
    for (const path of ['/.sys/app.json', '/app.json']) {
      try {
        const response = await this.transport.get(path, signal ? { signal } : {});
        const raw = safeJson(response.text);
        if (Object.keys(raw).length === 0) continue;
        return {
          reachable: true,
          themeId: numberOrNull(raw['theme']),
          brightness: numberOrNull(raw['brt']),
          currentImage: typeof raw['img'] === 'string' ? raw['img'] : null,
          raw,
        };
      } catch {
        // Try the next path before declaring the device unreachable.
      }
    }
    return { reachable: false, themeId: null, brightness: null, currentImage: null, raw: {} };
  }

  async getBrightness(signal?: AbortSignal): Promise<number | null> {
    return (await this.getState(signal)).brightness;
  }

  async setBrightness(value: number, signal?: AbortSignal): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    await this.transport.get(`/set?brt=${clamped}`, signal ? { signal } : {});
  }

  async getAlbumSettings(signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await this.transport.get('/.sys/album.json', signal ? { signal } : {});
      return safeJson(response.text);
    } catch {
      return {};
    }
  }

  async prepareManagedDisplay(options: PrepareOptions): Promise<void> {
    if (!options.albumManagementConsent) {
      throw new AppError(
        'PRO_ALBUM_CONSENT_REQUIRED',
        'Managed album mode needs explicit consent because it removes other pictures from the device album.',
      );
    }
    const signal = options.signal;
    // Album settings and theme rarely change; rewriting them every cycle would burn
    // device flash for nothing, so they are applied once unless forced.
    if (!this.#albumSettingsApplied || options.force) {
      await this.transport.get(ALBUM_SETTINGS_PATH, signal ? { signal } : {});
      this.#albumSettingsApplied = true;
    }
    if (!this.#themeApplied || options.force) {
      await this.transport.get(`/set?theme=${PICTURE_THEME}`, signal ? { signal } : {});
      this.#themeApplied = true;
    }
  }

  async uploadFrame(
    frame: EncodedFrameInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    const startedAt = Date.now();
    let disconnected = false;
    let response: Awaited<ReturnType<DeviceTransport['uploadFile']>> | null = null;

    try {
      response = await this.transport.uploadFile({
        path: `/doUpload?dir=${encodeQueryComponent(MANAGED_IMAGE_DIR)}`,
        fieldName: 'file',
        filename: MANAGED_FILENAME,
        contentType: 'image/jpeg',
        data: frame.bytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // PRO firmware often drops the connection after storing the file. That is not
      // a failure by itself, but it is only success once the file is actually there.
      if (options.signal?.aborted) throw error;
      disconnected = true;
    }

    const malformed = response !== null && (!response.ok || response.truncated);
    if (disconnected || malformed) {
      const verification = await this.verifyFrame(MANAGED_FILENAME, options.signal);
      if (!verification.present) {
        throw new AppError(
          'DEVICE_UPLOAD_UNVERIFIED',
          `Upload connection ${disconnected ? 'dropped' : 'returned an unexpected response'} and ${MANAGED_FILENAME} is not present in the album.`,
          { details: { detail: verification.detail }, retryable: true },
        );
      }
      return {
        uploaded: true,
        verified: true,
        warning: disconnected
          ? 'Device closed the upload connection early; file presence confirmed in the album.'
          : 'Device returned a malformed upload response; file presence confirmed in the album.',
        filename: MANAGED_FILENAME,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      uploaded: true,
      verified: true,
      filename: MANAGED_FILENAME,
      durationMs: Date.now() - startedAt,
    };
  }

  async verifyFrame(filename: string, signal?: AbortSignal): Promise<VerificationResult> {
    try {
      const files = await this.listFiles(signal);
      const match = files.find((file) => file.name === filename);
      return match
        ? { present: true, detail: `${filename} present in ${MANAGED_IMAGE_DIR}.` }
        : { present: false, detail: `${filename} not listed in ${MANAGED_IMAGE_DIR}.` };
    } catch (error) {
      return {
        present: false,
        detail: error instanceof Error ? error.message : 'File list unavailable.',
      };
    }
  }

  async listFiles(signal?: AbortSignal): Promise<DeviceFileEntry[]> {
    const response = await this.transport.get(
      `/filelist?dir=${encodeQueryComponent(MANAGED_IMAGE_DIR)}`,
      { maxBytes: 256 * 1024, ...(signal ? { signal } : {}) },
    );
    return parseFileList(response.text, MANAGED_IMAGE_DIR);
  }

  /**
   * Deletes everything in the album except the managed frame.
   *
   * This firmware's delete response cannot be trusted: on V3.4.88EN a single-slash
   * path returns `OK` and deletes nothing, while the device's own doubled-slash form
   * returns `Failed` and deletes the file. Success is therefore decided by re-listing
   * the album, never by the status or body.
   */
  async pruneAlbum(signal?: AbortSignal): Promise<{ deleted: string[]; failed: string[] }> {
    const before = await this.listFiles(signal);
    const targets = before.filter((file) => file.name !== MANAGED_FILENAME);
    if (targets.length === 0) return { deleted: [], failed: [] };

    for (const file of targets) {
      try {
        await this.transport.get(
          `/delete?file=${encodeQueryComponent(file.devicePath)}`,
          signal ? { signal } : {},
        );
      } catch {
        // Ignored: the re-listing below is what decides the outcome.
      }
    }

    const remaining = new Set((await this.listFiles(signal)).map((file) => file.name));
    const deleted = targets.filter((file) => !remaining.has(file.name)).map((file) => file.name);
    const failed = targets.filter((file) => remaining.has(file.name)).map((file) => file.name);
    return { deleted, failed };
  }

  async backupUserContent(signal?: AbortSignal): Promise<DeviceContentBackup> {
    const files = await this.listFiles(signal);
    const notes: string[] = [];
    let partial = false;
    const out: DeviceContentBackup['files'] = [];

    const candidates = files.filter((file) => file.name !== MANAGED_FILENAME);
    if (candidates.length > MAX_BACKUP_FILES) {
      partial = true;
      notes.push(
        `Album contains ${candidates.length} files; only the first ${MAX_BACKUP_FILES} were backed up.`,
      );
    }

    for (const file of candidates.slice(0, MAX_BACKUP_FILES)) {
      try {
        const response = await this.transport.get(encodePath(file.devicePath), {
          maxBytes: MAX_BACKUP_FILE_BYTES,
          timeoutMs: 20_000,
          ...(signal ? { signal } : {}),
        });
        if (response.truncated) {
          partial = true;
          notes.push(
            `${file.name} exceeded the ${MAX_BACKUP_FILE_BYTES} byte backup limit and was skipped.`,
          );
          continue;
        }
        out.push({
          filename: file.name,
          originalPath: file.path,
          bytes: response.body.length,
          sha256: createHash('sha256').update(response.body).digest('hex'),
          data: response.body,
        });
      } catch (error) {
        partial = true;
        notes.push(
          `${file.name} could not be downloaded: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    return { files: out, partial, notes };
  }

  async restoreUserContent(
    files: Array<{ filename: string; data: Buffer }>,
    signal?: AbortSignal,
  ): Promise<{ restored: string[]; failed: Array<{ filename: string; reason: string }> }> {
    const restored: string[] = [];
    const failed: Array<{ filename: string; reason: string }> = [];
    for (const file of files) {
      try {
        await this.transport.uploadFile({
          path: `/doUpload?dir=${encodeQueryComponent(MANAGED_IMAGE_DIR)}`,
          fieldName: 'file',
          filename: file.filename,
          contentType: guessContentType(file.filename),
          data: file.data,
          ...(signal ? { signal } : {}),
        });
        const verification = await this.verifyFrame(file.filename, signal);
        if (verification.present) restored.push(file.filename);
        else failed.push({ filename: file.filename, reason: verification.detail });
      } catch (error) {
        failed.push({
          filename: file.filename,
          reason: error instanceof Error ? error.message : 'Upload failed',
        });
      }
    }
    return { restored, failed };
  }
}

/**
 * Parses the firmware's HTML file listing.
 *
 * The response is device-controlled HTML, so only filenames are extracted and each is
 * re-encoded before it is ever sent back in a query string. The raw HTML is never
 * surfaced to the UI.
 */
export function parseFileList(html: string, dir: string): DeviceFileEntry[] {
  const entries = new Map<string, DeviceFileEntry>();

  // JSON listing on some builds.
  const trimmed = html.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)['files'])
          ? ((parsed as Record<string, unknown>)['files'] as unknown[])
          : [];
      for (const item of list) {
        if (typeof item === 'string') {
          addEntry(entries, item, dir, null);
        } else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const name = typeof record['name'] === 'string' ? record['name'] : null;
          if (name) addEntry(entries, name, dir, numberOrNull(record['size']));
        }
      }
      if (entries.size > 0) return [...entries.values()];
    } catch {
      // Fall through to HTML parsing.
    }
  }

  // Anchor hrefs are the common stock format: <a href="/image/foo.jpg">foo.jpg</a>
  for (const match of html.matchAll(/href\s*=\s*["']([^"'>]+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    const decoded = safeDecode(href);
    if (!decoded.toLowerCase().includes(dir.toLowerCase())) continue;
    const name = decoded.split('/').filter(Boolean).pop();
    if (name) addEntry(entries, name, dir, null, decoded);
  }

  if (entries.size === 0) {
    // Last resort: bare filenames with a known image extension.
    for (const match of html.matchAll(/([A-Za-z0-9._-]+\.(?:jpe?g|png|gif|bmp))/gi)) {
      const name = match[1];
      if (name) addEntry(entries, name, dir, null);
    }
  }

  return [...entries.values()];
}

function addEntry(
  target: Map<string, DeviceFileEntry>,
  rawName: string,
  dir: string,
  bytes: number | null,
  devicePath?: string,
): void {
  // Strip any directory traversal a device could put in a listing.
  const name = rawName.split('/').filter(Boolean).pop()?.replace(/\.\./g, '') ?? '';
  if (!name || name === '.' || name === '..') return;
  if (target.has(name)) return;

  // Keep the device's own spelling when it is safe, because its delete handler only
  // honours that exact form. Anything with traversal falls back to the tidy path.
  const safeDevicePath =
    devicePath && !devicePath.includes('..') && devicePath.endsWith(name)
      ? devicePath
      : `${dir}${name}`;

  target.set(name, { name, path: `${dir}${name}`, devicePath: safeDevicePath, bytes });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : ''))
    .join('/');
}

function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/jpeg';
  }
}
