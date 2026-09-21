import type { DeviceCapabilities, DeviceProfileId } from '@gca/shared';
import type { DetectionResult } from '../detection.js';

export interface EncodedFrameInput {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

export interface DeviceState {
  reachable: boolean;
  themeId: number | null;
  brightness: number | null;
  currentImage: string | null;
  raw: Record<string, unknown>;
}

export interface UploadResult {
  uploaded: boolean;
  verified: boolean;
  /** Set when the upload landed but selection or verification was inconclusive. */
  warning?: string;
  filename: string;
  durationMs: number;
}

export interface VerificationResult {
  present: boolean;
  detail: string;
}

export interface PrepareOptions {
  /** Managed-album takeover requires this; adapters refuse without it. */
  albumManagementConsent: boolean;
  /** Skip settings writes that have not changed since the last cycle. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface DeviceFileEntry {
  name: string;
  /** Normalized `<dir><name>`, used for display and comparison. */
  path: string;
  /**
   * The exact path the device itself uses for this file.
   *
   * Stock PRO firmware lists and deletes via a doubled slash (`/image//photo.jpg`)
   * and silently ignores a delete for the single-slash form, so operations must use
   * what the device gave us rather than a tidied-up version of it.
   */
  devicePath: string;
  bytes: number | null;
}

export interface DeviceContentBackup {
  files: Array<{
    filename: string;
    originalPath: string;
    bytes: number;
    sha256: string;
    data: Buffer;
  }>;
  partial: boolean;
  notes: string[];
}

export interface DeviceAdapter {
  readonly profile: DeviceProfileId;
  readonly capabilities: DeviceCapabilities;
  probe(signal?: AbortSignal): Promise<DetectionResult>;
  getState(signal?: AbortSignal): Promise<DeviceState>;
  getBrightness(signal?: AbortSignal): Promise<number | null>;
  setBrightness(value: number, signal?: AbortSignal): Promise<void>;
  /** Puts the device into the mode where the managed frame is what is displayed. */
  prepareManagedDisplay(options: PrepareOptions): Promise<void>;
  uploadFrame(frame: EncodedFrameInput, options?: { signal?: AbortSignal }): Promise<UploadResult>;
  verifyFrame(filename: string, signal?: AbortSignal): Promise<VerificationResult>;
  listFiles?(signal?: AbortSignal): Promise<DeviceFileEntry[]>;
  backupUserContent?(signal?: AbortSignal): Promise<DeviceContentBackup>;
  restoreUserContent?(
    files: Array<{ filename: string; data: Buffer }>,
    signal?: AbortSignal,
  ): Promise<{ restored: string[]; failed: Array<{ filename: string; reason: string }> }>;
}

/** The single filename the application manages on every device. */
export const MANAGED_FILENAME = 'dashboard.jpg';
export const MANAGED_IMAGE_DIR = '/image/';
export const MANAGED_IMAGE_PATH = `${MANAGED_IMAGE_DIR}${MANAGED_FILENAME}`;
