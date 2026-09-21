import type { DeviceCapabilities } from '@gca/shared';

export function capabilitiesStub(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
  return {
    canUploadImage: true,
    canSetBrightness: true,
    canListFiles: true,
    canDeleteFiles: true,
    requiresAlbumManagement: true,
    canReadState: true,
    supportsBackup: true,
    notes: ['test'],
    ...overrides,
  };
}
