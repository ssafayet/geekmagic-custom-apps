import { AppError } from '@gca/shared';
import { capabilitiesFor } from '../capabilities.js';
import { detectProfile, type DetectionResult } from '../detection.js';
import { encodeQueryComponent, type DeviceTransport } from '../http.js';
import { numberOrNull, safeJson } from './stock-ultra.js';
import {
  MANAGED_FILENAME,
  type DeviceAdapter,
  type DeviceFileEntry,
  type DeviceState,
  type EncodedFrameInput,
  type PrepareOptions,
  type UploadResult,
  type VerificationResult,
} from './types.js';

const PHOTO_THEME_VALUE = 2;
/** This firmware clamps brightness to 2-99 rather than 0-100. */
const MIN_BRIGHTNESS = 2;
const MAX_BRIGHTNESS = 99;

interface ManagedFlags {
  photos: Record<string, boolean>;
  themes: Record<string, boolean>;
  activeTheme: number | null;
}

/**
 * SD_PRO-style firmware found on some Ultra-branded units.
 *
 * Product names alone do not identify firmware, so this is a separate adapter with its
 * own photo/theme API. Managed mode enables only the dashboard photo and remembers the
 * prior enabled flags so the user's own slideshow can be restored.
 */
export class SdProAdapter implements DeviceAdapter {
  readonly profile = 'sd-pro' as const;
  readonly capabilities = capabilitiesFor('sd-pro');
  #priorFlags: ManagedFlags | null = null;
  #managedApplied = false;

  constructor(private readonly transport: DeviceTransport) {}

  async probe(signal?: AbortSignal): Promise<DetectionResult> {
    return detectProfile(this.transport, signal ? { signal } : {});
  }

  async getState(signal?: AbortSignal): Promise<DeviceState> {
    try {
      const response = await this.transport.get('/config', signal ? { signal } : {});
      const raw = safeJson(response.text);
      return {
        reachable: true,
        themeId: numberOrNull(raw['theme']),
        brightness: numberOrNull(raw['lcd_brightness'] ?? raw['brightness']),
        currentImage: typeof raw['photo'] === 'string' ? raw['photo'] : null,
        raw,
      };
    } catch {
      return { reachable: false, themeId: null, brightness: null, currentImage: null, raw: {} };
    }
  }

  async getBrightness(signal?: AbortSignal): Promise<number | null> {
    return (await this.getState(signal)).brightness;
  }

  async setBrightness(value: number, signal?: AbortSignal): Promise<void> {
    const clamped = Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, Math.round(value)));
    await this.transport.get(
      `/api/set?key=lcd_brightness&value=${clamped}`,
      signal ? { signal } : {},
    );
  }

  async listFiles(signal?: AbortSignal): Promise<DeviceFileEntry[]> {
    const response = await this.transport.get('/photo/list', {
      maxBytes: 256 * 1024,
      ...(signal ? { signal } : {}),
    });
    return parsePhotoList(response.text);
  }

  async prepareManagedDisplay(options: PrepareOptions): Promise<void> {
    if (!options.albumManagementConsent) {
      throw new AppError(
        'PRO_ALBUM_CONSENT_REQUIRED',
        'Managed mode needs consent because it disables the other photos and themes currently enabled on this device.',
      );
    }
    if (this.#managedApplied && !options.force) return;
    const signal = options.signal;
    const signalOpt = signal ? { signal } : {};

    // Capture what the user had enabled before we change anything, so exiting
    // managed mode can put the device back the way it was.
    if (!this.#priorFlags) this.#priorFlags = await this.captureFlags(signal);

    const photos = await this.listFiles(signal);
    for (const photo of photos) {
      const enable = photo.name === MANAGED_FILENAME;
      await this.transport.get(
        `/photo/toggle?name=${encodeQueryComponent(photo.name)}&state=${enable ? 1 : 0}`,
        signalOpt,
      );
    }

    await this.transport.get('/photo/interval?val=1', signalOpt);
    await this.transport.get(`/api/set?key=theme&value=${PHOTO_THEME_VALUE}`, signalOpt);
    this.#managedApplied = true;
  }

  async uploadFrame(
    frame: EncodedFrameInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    const startedAt = Date.now();
    const response = await this.transport.uploadFile({
      path: '/photo/upload',
      fieldName: 'file',
      filename: MANAGED_FILENAME,
      contentType: 'image/jpeg',
      data: frame.bytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok && !response.truncated) {
      throw new AppError(
        'DEVICE_UPLOAD_FAILED',
        `Photo upload rejected with HTTP ${response.status}.`,
        {
          details: { status: response.status },
          retryable: true,
        },
      );
    }

    const verification = await this.verifyFrame(MANAGED_FILENAME, options.signal);
    if (!verification.present) {
      throw new AppError(
        'DEVICE_UPLOAD_UNVERIFIED',
        `Uploaded ${MANAGED_FILENAME} is not listed by the device.`,
        {
          details: { detail: verification.detail },
          retryable: true,
        },
      );
    }

    // The photo must be enabled to appear in the slideshow; re-asserting is cheap and
    // recovers from a device that dropped the flag after a reboot.
    await this.transport.get(
      `/photo/toggle?name=${encodeQueryComponent(MANAGED_FILENAME)}&state=1`,
      options.signal ? { signal: options.signal } : {},
    );

    return {
      uploaded: true,
      verified: true,
      filename: MANAGED_FILENAME,
      durationMs: Date.now() - startedAt,
    };
  }

  async verifyFrame(filename: string, signal?: AbortSignal): Promise<VerificationResult> {
    try {
      const photos = await this.listFiles(signal);
      return photos.some((photo) => photo.name === filename)
        ? { present: true, detail: `${filename} is listed by /photo/list.` }
        : { present: false, detail: `${filename} is not listed by /photo/list.` };
    } catch (error) {
      return {
        present: false,
        detail: error instanceof Error ? error.message : 'Photo list unavailable.',
      };
    }
  }

  /** Restores the enabled photo/theme flags captured before managed mode began. */
  async exitManagedMode(signal?: AbortSignal): Promise<void> {
    const prior = this.#priorFlags;
    if (!prior) return;
    const signalOpt = signal ? { signal } : {};
    for (const [name, enabled] of Object.entries(prior.photos)) {
      await this.transport.get(
        `/photo/toggle?name=${encodeQueryComponent(name)}&state=${enabled ? 1 : 0}`,
        signalOpt,
      );
    }
    for (const [id, enabled] of Object.entries(prior.themes)) {
      await this.transport.get(
        `/theme/toggle?id=${encodeQueryComponent(id)}&state=${enabled ? 1 : 0}`,
        signalOpt,
      );
    }
    if (prior.activeTheme !== null) {
      await this.transport.get(`/api/set?key=theme&value=${prior.activeTheme}`, signalOpt);
    }
    this.#priorFlags = null;
    this.#managedApplied = false;
  }

  private async captureFlags(signal?: AbortSignal): Promise<ManagedFlags> {
    const flags: ManagedFlags = { photos: {}, themes: {}, activeTheme: null };
    try {
      const response = await this.transport.get('/photo/list', signal ? { signal } : {});
      for (const entry of parsePhotoListDetailed(response.text)) {
        flags.photos[entry.name] = entry.enabled;
      }
    } catch {
      // A missing listing means nothing to restore, which is safe.
    }
    try {
      const response = await this.transport.get('/theme/list', signal ? { signal } : {});
      const parsed = safeJson(response.text);
      const themes = Array.isArray(parsed['themes']) ? (parsed['themes'] as unknown[]) : [];
      for (const item of themes) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const id = record['id'];
        if (id === undefined || id === null) continue;
        flags.themes[String(id)] = toBoolean(record['state'] ?? record['enabled']);
      }
    } catch {
      // Same rationale as above.
    }
    flags.activeTheme = (await this.getState(signal)).themeId;
    return flags;
  }
}

interface PhotoEntry {
  name: string;
  enabled: boolean;
  bytes: number | null;
}

export function parsePhotoListDetailed(text: string): PhotoEntry[] {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(text.trim());
    } catch {
      return null;
    }
  })();

  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>)['photos'])
      ? ((parsed as Record<string, unknown>)['photos'] as unknown[])
      : [];

  const out: PhotoEntry[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ name: sanitizeName(item), enabled: false, bytes: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : null;
    if (!name) continue;
    out.push({
      name: sanitizeName(name),
      enabled: toBoolean(record['state'] ?? record['enabled']),
      bytes: numberOrNull(record['size']),
    });
  }
  return out.filter((entry) => entry.name.length > 0);
}

export function parsePhotoList(text: string): DeviceFileEntry[] {
  return parsePhotoListDetailed(text).map((entry) => ({
    name: entry.name,
    path: `/photo/${entry.name}`,
    // This firmware addresses photos by name, so both forms coincide.
    devicePath: `/photo/${entry.name}`,
    bytes: entry.bytes,
  }));
}

function sanitizeName(value: string): string {
  return value.split('/').filter(Boolean).pop()?.replace(/\.\./g, '') ?? '';
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}
