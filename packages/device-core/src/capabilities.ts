import type { DeviceCapabilities, DeviceProfileId } from '@gca/shared';

const BASE: DeviceCapabilities = {
  canUploadImage: false,
  canSetBrightness: false,
  canListFiles: false,
  canDeleteFiles: false,
  requiresAlbumManagement: false,
  canReadState: false,
  supportsBackup: false,
  notes: [],
};

export const PROFILE_CAPABILITIES: Record<DeviceProfileId, DeviceCapabilities> = {
  'stock-ultra': {
    ...BASE,
    canUploadImage: true,
    canSetBrightness: true,
    canReadState: true,
    notes: ['Custom image theme (3) with direct image selection.'],
  },
  'stock-pro': {
    ...BASE,
    canUploadImage: true,
    canSetBrightness: true,
    canListFiles: true,
    canDeleteFiles: true,
    requiresAlbumManagement: true,
    canReadState: true,
    supportsBackup: true,
    notes: [
      'Picture mode is an album slideshow; deterministic output needs managed-album consent.',
      'The Picture app must be selected once by hand on the device.',
    ],
  },
  'sd-pro': {
    ...BASE,
    canUploadImage: true,
    canSetBrightness: true,
    canListFiles: true,
    canDeleteFiles: false,
    requiresAlbumManagement: true,
    canReadState: true,
    supportsBackup: false,
    notes: [
      'Photo/theme API rather than the stock endpoints.',
      'Managed mode enables only the dashboard photo and restores prior flags on exit.',
    ],
  },
  'weather-clock-legacy': {
    ...BASE,
    canReadState: false,
    notes: ['Detected for diagnostics only. Version 1 performs no writes to this firmware.'],
  },
  unknown: {
    ...BASE,
    notes: ['Firmware not recognised. All write actions are disabled.'],
  },
};

export const WRITABLE_PROFILES: DeviceProfileId[] = ['stock-ultra', 'stock-pro', 'sd-pro'];

export function isWritableProfile(profile: DeviceProfileId): boolean {
  return WRITABLE_PROFILES.includes(profile);
}

export function capabilitiesFor(profile: DeviceProfileId): DeviceCapabilities {
  const base = PROFILE_CAPABILITIES[profile];
  return { ...base, notes: [...base.notes] };
}
