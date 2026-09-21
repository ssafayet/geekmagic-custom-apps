import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@gca/shared';
import { SdProAdapter } from '../src/adapters/sd-pro.js';
import { StockProAdapter } from '../src/adapters/stock-pro.js';
import { StockUltraAdapter } from '../src/adapters/stock-ultra.js';
import { UnsupportedAdapter } from '../src/adapters/unsupported.js';
import { DeviceTransport } from '../src/http.js';
import { DeviceSimulator, type SimulatorProfile } from './simulator/index.js';

const running: DeviceSimulator[] = [];

async function connect(profile: SimulatorProfile, files: string[] = []) {
  const simulator = new DeviceSimulator({ profile, files });
  running.push(simulator);
  const host = await simulator.start();
  const transport = new DeviceTransport({
    host,
    policy: { allowlist: [], allowLoopback: true, allowPublic: false },
    defaultTimeoutMs: 3_000,
  });
  return { simulator, transport };
}

function frame(content = 'frame-bytes') {
  const bytes = Buffer.from(content);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'image/jpeg',
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((simulator) => simulator.stop()));
});

describe('stock Ultra adapter', () => {
  it('uploads with multipart field "file", selects theme 3, then selects the image', async () => {
    const { simulator, transport } = await connect('stock-ultra');
    const adapter = new StockUltraAdapter(transport);

    const result = await adapter.uploadFrame(frame());

    expect(result.uploaded).toBe(true);
    expect(result.verified).toBe(true);

    const upload = simulator.requests.find((request) => request.path === '/doUpload');
    expect(upload?.method).toBe('POST');
    expect(upload?.query['dir']).toBe('/image/');
    expect(upload?.parts[0]).toMatchObject({
      name: 'file',
      filename: 'dashboard.jpg',
      contentType: 'image/jpeg',
    });

    // Order matters: upload, then theme, then image selection.
    const sets = simulator.requests.filter((request) => request.path === '/set');
    expect(sets[0]?.query['theme']).toBe('3');
    expect(sets[1]?.query['img']).toBe('/image/dashboard.jpg');
    expect(simulator.theme).toBe(3);
    expect(simulator.currentImage).toBe('/image/dashboard.jpg');
  });

  it('treats a FAIL image selection as a warning when device state confirms the image', async () => {
    const { transport } = await connect('stock-ultra-select-fail');
    const adapter = new StockUltraAdapter(transport);

    const result = await adapter.uploadFrame(frame());

    // The upload itself worked; re-uploading on every cycle would burn device flash.
    expect(result.uploaded).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.warning).toMatch(/FAIL/);
  });

  it('applies the custom-image theme only once unless forced', async () => {
    const { simulator, transport } = await connect('stock-ultra');
    const adapter = new StockUltraAdapter(transport);

    await adapter.prepareManagedDisplay({ albumManagementConsent: true });
    await adapter.prepareManagedDisplay({ albumManagementConsent: true });
    const themeWrites = simulator.requests.filter(
      (request) => request.query['theme'] !== undefined,
    );
    expect(themeWrites).toHaveLength(1);

    await adapter.prepareManagedDisplay({ albumManagementConsent: true, force: true });
    expect(
      simulator.requests.filter((request) => request.query['theme'] !== undefined),
    ).toHaveLength(2);
  });

  it('clamps brightness into the 0-100 range', async () => {
    const { simulator, transport } = await connect('stock-ultra');
    const adapter = new StockUltraAdapter(transport);

    await adapter.setBrightness(140);
    expect(simulator.brightness).toBe(100);
    await adapter.setBrightness(-20);
    expect(simulator.brightness).toBe(0);
  });
});

describe('stock PRO adapter', () => {
  it('refuses managed display without album consent', async () => {
    const { transport } = await connect('stock-pro');
    const adapter = new StockProAdapter(transport);

    await expect(adapter.prepareManagedDisplay({ albumManagementConsent: false })).rejects.toThrow(
      /consent/i,
    );
    await expect(
      adapter.prepareManagedDisplay({ albumManagementConsent: false }),
    ).rejects.toMatchObject({ code: 'PRO_ALBUM_CONSENT_REQUIRED' });
  });

  it('uses theme 4 and writes album settings once', async () => {
    const { simulator, transport } = await connect('stock-pro');
    const adapter = new StockProAdapter(transport);

    await adapter.prepareManagedDisplay({ albumManagementConsent: true });
    await adapter.prepareManagedDisplay({ albumManagementConsent: true });

    const albumWrites = simulator.requests.filter((request) => request.query['i_i'] !== undefined);
    expect(albumWrites).toHaveLength(1);
    expect(albumWrites[0]?.query).toMatchObject({ i_i: '1', gif_loop: '1', autoplay: '1' });
    expect(simulator.theme).toBe(4);
  });

  it('treats an upload disconnect as success once file presence is verified', async () => {
    const { simulator, transport } = await connect('stock-pro-upload-disconnect');
    const adapter = new StockProAdapter(transport);

    const result = await adapter.uploadFrame(frame());

    expect(result.uploaded).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.warning).toMatch(/closed the upload connection/i);
    // Verification must be an actual file-list check, not an assumption.
    expect(simulator.requests.some((request) => request.path === '/filelist')).toBe(true);
    expect(simulator.files).toContain('dashboard.jpg');
  });

  it('fails with DEVICE_UPLOAD_UNVERIFIED when the file is absent after a disconnect', async () => {
    const simulator = new DeviceSimulator({ profile: 'stock-pro-upload-disconnect' });
    running.push(simulator);
    const host = await simulator.start();
    const transport = new DeviceTransport({
      host,
      policy: { allowlist: [], allowLoopback: true, allowPublic: false },
      defaultTimeoutMs: 3_000,
    });
    const adapter = new StockProAdapter(transport);

    // Make the listing lie about the file to simulate a store that did not happen.
    const original = adapter.listFiles.bind(adapter);
    adapter.listFiles = async () =>
      (await original()).filter((file) => file.name !== 'dashboard.jpg');

    await expect(adapter.uploadFrame(frame())).rejects.toMatchObject({
      code: 'DEVICE_UPLOAD_UNVERIFIED',
    });
  });

  it('backs up album contents with checksums before anything is deleted', async () => {
    const { transport } = await connect('stock-pro', ['holiday.jpg', 'cat.png']);
    const adapter = new StockProAdapter(transport);

    const backup = await adapter.backupUserContent();

    expect(backup.partial).toBe(false);
    expect(backup.files.map((file) => file.filename).sort()).toEqual(['cat.png', 'holiday.jpg']);
    for (const file of backup.files) {
      expect(file.sha256).toBe(createHash('sha256').update(file.data).digest('hex'));
      expect(file.bytes).toBe(file.data.length);
    }
  });

  it('prunes every album file except the managed one', async () => {
    const { simulator, transport } = await connect('stock-pro', [
      'holiday.jpg',
      'dashboard.jpg',
      'cat.png',
    ]);
    const adapter = new StockProAdapter(transport);

    const result = await adapter.pruneAlbum();

    expect(result.deleted.sort()).toEqual(['cat.png', 'holiday.jpg']);
    expect(result.failed).toEqual([]);
    expect(simulator.files).toEqual(['dashboard.jpg']);
  });

  it('percent-encodes file paths taken from a device listing', async () => {
    const { simulator, transport } = await connect('stock-pro', [
      'my photo & more.jpg',
      'dashboard.jpg',
    ]);
    const adapter = new StockProAdapter(transport);

    await adapter.pruneAlbum();

    const deleteRequest = simulator.requests.find((request) => request.path === '/delete');
    // Encoding is what matters: an unencoded `&` would split the query string, so
    // the value must survive a full round trip. The doubled slash is the device's
    // own spelling, which its delete handler requires.
    expect(deleteRequest?.body.toString()).not.toContain('my photo & more');
    expect(deleteRequest?.query['file']).toBe('/image//my photo & more.jpg');
  });
});

describe('SD_PRO adapter', () => {
  it('uploads via /photo/upload and enables only the managed photo', async () => {
    const { simulator, transport } = await connect('sd-pro', ['sunset.jpg', 'family.jpg']);
    const adapter = new SdProAdapter(transport);

    await adapter.prepareManagedDisplay({ albumManagementConsent: true });
    await adapter.uploadFrame(frame());

    const upload = simulator.requests.find((request) => request.path === '/photo/upload');
    expect(upload?.method).toBe('POST');
    expect(upload?.parts[0]).toMatchObject({ name: 'file', filename: 'dashboard.jpg' });

    expect(simulator.photoEnabled('dashboard.jpg')).toBe(true);
    expect(simulator.photoEnabled('sunset.jpg')).toBe(false);
    expect(simulator.photoEnabled('family.jpg')).toBe(false);

    // Photo theme and a 1-unit interval.
    expect(simulator.theme).toBe(2);
    expect(simulator.requests.some((request) => request.path === '/photo/interval')).toBe(true);
  });

  it('restores the previously enabled photos and themes when leaving managed mode', async () => {
    const { simulator, transport } = await connect('sd-pro', ['sunset.jpg', 'family.jpg']);
    const adapter = new SdProAdapter(transport);

    await adapter.prepareManagedDisplay({ albumManagementConsent: true });
    expect(simulator.photoEnabled('sunset.jpg')).toBe(false);

    await adapter.exitManagedMode();

    expect(simulator.photoEnabled('sunset.jpg')).toBe(true);
    expect(simulator.photoEnabled('family.jpg')).toBe(true);
    expect(simulator.themeEnabled('0')).toBe(true);
  });

  it('clamps brightness to the firmware 2-99 range', async () => {
    const { simulator, transport } = await connect('sd-pro');
    const adapter = new SdProAdapter(transport);

    await adapter.setBrightness(0);
    expect(simulator.brightness).toBe(2);
    await adapter.setBrightness(100);
    expect(simulator.brightness).toBe(99);
  });

  it('refuses managed mode without consent', async () => {
    const { transport } = await connect('sd-pro');
    const adapter = new SdProAdapter(transport);
    await expect(
      adapter.prepareManagedDisplay({ albumManagementConsent: false }),
    ).rejects.toMatchObject({
      code: 'PRO_ALBUM_CONSENT_REQUIRED',
    });
  });
});

describe('unsupported adapter', () => {
  it('refuses every write for unknown firmware', async () => {
    const { transport } = await connect('unknown');
    const adapter = new UnsupportedAdapter('unknown', transport);

    await expect(adapter.uploadFrame(frame())).rejects.toMatchObject({
      code: 'DEVICE_PROFILE_UNKNOWN',
    });
    await expect(adapter.setBrightness(50)).rejects.toBeInstanceOf(AppError);
    await expect(
      adapter.prepareManagedDisplay({ albumManagementConsent: true }),
    ).rejects.toMatchObject({ code: 'DEVICE_PROFILE_UNKNOWN' });
  });

  it('reports detected-but-unsupported firmware distinctly', async () => {
    const { transport } = await connect('legacy');
    const adapter = new UnsupportedAdapter('weather-clock-legacy', transport);

    await expect(adapter.uploadFrame(frame())).rejects.toMatchObject({
      code: 'DEVICE_PROFILE_UNSUPPORTED',
    });
  });
});

describe('stock PRO firmware whose delete response lies', () => {
  // Observed on a real SmallTV-PRO running V3.4.88EN: the single-slash path answers
  // "OK" and deletes nothing, while the device's own doubled-slash path answers
  // "Failed" and deletes the file. Trusting either body corrupts the result.
  it('deletes using the path the device itself published', async () => {
    const { simulator, transport } = await connect('stock-pro-quirky-delete', [
      'holiday.jpg',
      'dashboard.jpg',
      'cat.png',
    ]);
    const adapter = new StockProAdapter(transport);

    const result = await adapter.pruneAlbum();

    expect(result.deleted.sort()).toEqual(['cat.png', 'holiday.jpg']);
    expect(result.failed).toEqual([]);
    expect(simulator.files).toEqual(['dashboard.jpg']);
  });

  it('decides success by re-listing, not by the response body', async () => {
    const { simulator, transport } = await connect('stock-pro-quirky-delete', [
      'stubborn.gif',
      'dashboard.jpg',
    ]);
    const adapter = new StockProAdapter(transport);

    // Force the form the firmware ignores; the body will claim success.
    const original = adapter.listFiles.bind(adapter);
    adapter.listFiles = async () =>
      (await original()).map((file) => ({ ...file, devicePath: file.path }));

    const result = await adapter.pruneAlbum();

    // The device answered OK, but the file is still there, so it is reported failed.
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual(['stubborn.gif']);
    expect(simulator.files.sort()).toEqual(['dashboard.jpg', 'stubborn.gif']);
  });

  it('reports nothing to do for an album that holds only the managed frame', async () => {
    const { transport } = await connect('stock-pro-quirky-delete', ['dashboard.jpg']);
    const adapter = new StockProAdapter(transport);

    expect(await adapter.pruneAlbum()).toEqual({ deleted: [], failed: [] });
  });

  it('exposes the device path from a doubled-slash listing', async () => {
    const { transport } = await connect('stock-pro-quirky-delete', ['holiday.jpg']);
    const adapter = new StockProAdapter(transport);

    const [file] = await adapter.listFiles();

    expect(file).toMatchObject({
      name: 'holiday.jpg',
      path: '/image/holiday.jpg',
      devicePath: '/image//holiday.jpg',
    });
  });
});
