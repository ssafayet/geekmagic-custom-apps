import { AppError, type DeviceProfileId } from '@gca/shared';
import { capabilitiesFor } from '../capabilities.js';
import { detectProfile, type DetectionResult } from '../detection.js';
import type { DeviceTransport } from '../http.js';
import type {
  DeviceAdapter,
  DeviceState,
  EncodedFrameInput,
  PrepareOptions,
  UploadResult,
  VerificationResult,
} from './types.js';

/**
 * Stand-in for firmware we recognise but will not write to, and for firmware we do not
 * recognise at all. Every mutating call fails loudly rather than guessing an endpoint.
 */
export class UnsupportedAdapter implements DeviceAdapter {
  readonly capabilities;

  constructor(
    readonly profile: DeviceProfileId,
    private readonly transport: DeviceTransport,
  ) {
    this.capabilities = capabilitiesFor(profile);
  }

  async probe(signal?: AbortSignal): Promise<DetectionResult> {
    return detectProfile(this.transport, signal ? { signal } : {});
  }

  async getState(): Promise<DeviceState> {
    return { reachable: false, themeId: null, brightness: null, currentImage: null, raw: {} };
  }

  async getBrightness(): Promise<number | null> {
    return null;
  }

  async setBrightness(): Promise<void> {
    throw this.#refuse();
  }

  async prepareManagedDisplay(_options: PrepareOptions): Promise<void> {
    throw this.#refuse();
  }

  async uploadFrame(_frame: EncodedFrameInput): Promise<UploadResult> {
    throw this.#refuse();
  }

  async verifyFrame(): Promise<VerificationResult> {
    return { present: false, detail: 'Verification is not available for this firmware profile.' };
  }

  #refuse(): AppError {
    return this.profile === 'unknown'
      ? new AppError(
          'DEVICE_PROFILE_UNKNOWN',
          'This firmware was not recognised, so no write operations are permitted.',
        )
      : new AppError(
          'DEVICE_PROFILE_UNSUPPORTED',
          `Firmware profile "${this.profile}" is detected but not writable in this version.`,
        );
  }
}
