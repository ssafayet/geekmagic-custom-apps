import type { DeviceProfileId } from '@gca/shared';
import type { DeviceTransport } from '../http.js';
import { SdProAdapter } from './sd-pro.js';
import { StockProAdapter } from './stock-pro.js';
import { StockUltraAdapter } from './stock-ultra.js';
import { UnsupportedAdapter } from './unsupported.js';
import type { DeviceAdapter } from './types.js';

export * from './types.js';
export { StockUltraAdapter } from './stock-ultra.js';
export { StockProAdapter, parseFileList } from './stock-pro.js';
export { SdProAdapter, parsePhotoList, parsePhotoListDetailed } from './sd-pro.js';
export { UnsupportedAdapter } from './unsupported.js';

/** The only place a profile turns into behaviour. Modules never reach an adapter. */
export function createAdapter(profile: DeviceProfileId, transport: DeviceTransport): DeviceAdapter {
  switch (profile) {
    case 'stock-ultra':
      return new StockUltraAdapter(transport);
    case 'stock-pro':
      return new StockProAdapter(transport);
    case 'sd-pro':
      return new SdProAdapter(transport);
    default:
      return new UnsupportedAdapter(profile, transport);
  }
}
