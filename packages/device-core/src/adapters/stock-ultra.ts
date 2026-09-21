import { AppError } from '@gca/shared';
import { capabilitiesFor } from '../capabilities.js';
import { detectProfile, type DetectionResult } from '../detection.js';
import { encodeQueryComponent, type DeviceTransport } from '../http.js';
import {
  MANAGED_FILENAME,
  MANAGED_IMAGE_DIR,
  MANAGED_IMAGE_PATH,
  type DeviceAdapter,
  type DeviceState,
  type EncodedFrameInput,
  type PrepareOptions,
  type UploadResult,
  type VerificationResult,
} from './types.js';

const CUSTOM_IMAGE_THEME = 3;

/**
 * Stock SmallTV Ultra.
 *
 * Simplest of the three: upload to the image directory, select the custom-image theme,
 * then point the device at the uploaded file. There is no album to manage.
 */
export class StockUltraAdapter implements DeviceAdapter {
  readonly profile = 'stock-ultra' as const;
  readonly capabilities = capabilitiesFor('stock-ultra');
  #themePrepared = false;

  constructor(private readonly transport: DeviceTransport) {}

  async probe(signal?: AbortSignal): Promise<DetectionResult> {
    return detectProfile(this.transport, signal ? { signal } : {});
  }

  async getState(signal?: AbortSignal): Promise<DeviceState> {
    try {
      const response = await this.transport.get('/app.json', signal ? { signal } : {});
      const raw = safeJson(response.text);
      return {
        reachable: true,
        themeId: numberOrNull(raw['theme']),
        brightness: numberOrNull(raw['brt']),
        currentImage: typeof raw['img'] === 'string' ? raw['img'] : null,
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
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    await this.transport.get(`/set?brt=${clamped}`, signal ? { signal } : {});
  }

  async prepareManagedDisplay(options: PrepareOptions): Promise<void> {
    if (this.#themePrepared && !options.force) return;
    await this.transport.get(
      `/set?theme=${CUSTOM_IMAGE_THEME}`,
      options.signal ? { signal: options.signal } : {},
    );
    this.#themePrepared = true;
  }

  async uploadFrame(
    frame: EncodedFrameInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    const startedAt = Date.now();
    const response = await this.transport.uploadFile({
      path: `/doUpload?dir=${encodeQueryComponent(MANAGED_IMAGE_DIR)}`,
      fieldName: 'file',
      filename: MANAGED_FILENAME,
      contentType: 'image/jpeg',
      data: frame.bytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok && !response.truncated) {
      throw new AppError('DEVICE_UPLOAD_FAILED', `Upload rejected with HTTP ${response.status}.`, {
        details: { status: response.status },
        retryable: true,
      });
    }

    await this.prepareManagedDisplay({ albumManagementConsent: true, signal: options.signal });

    // Selection can report FAIL on some builds even though the displayed file was
    // replaced in place. Treat that as a warning, not a reason to keep re-uploading.
    const selection = await this.transport.get(
      `/set?img=${encodeQueryComponent(MANAGED_IMAGE_PATH)}`,
      options.signal ? { signal: options.signal } : {},
    );
    const selectionFailed = !selection.ok || /fail/i.test(selection.text);

    let warning: string | undefined;
    let verified = !selectionFailed;
    if (selectionFailed) {
      const state = await this.getState(options.signal);
      verified = state.currentImage === MANAGED_IMAGE_PATH || state.themeId === CUSTOM_IMAGE_THEME;
      warning = verified
        ? 'Firmware reported FAIL for image selection, but device state shows the managed image is active.'
        : 'Firmware reported FAIL for image selection and device state could not confirm it. The upload itself succeeded.';
    }

    return {
      uploaded: true,
      verified,
      ...(warning ? { warning } : {}),
      filename: MANAGED_FILENAME,
      durationMs: Date.now() - startedAt,
    };
  }

  async verifyFrame(filename: string, signal?: AbortSignal): Promise<VerificationResult> {
    const state = await this.getState(signal);
    if (!state.reachable) return { present: false, detail: 'Device state unavailable.' };
    const expected = `${MANAGED_IMAGE_DIR}${filename}`;
    return state.currentImage === expected
      ? { present: true, detail: `Device reports ${expected} as the active image.` }
      : {
          present: false,
          detail: `Device reports active image "${state.currentImage ?? 'none'}".`,
        };
  }
}

export function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
