import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { startBackground } from '../src/context.js';
import { DeviceSimulator } from '../../../packages/device-core/test/simulator/index.js';
import { createTestApp, jsonBody, type TestApp } from './helpers.js';

let harness: TestApp | null = null;
const simulators: DeviceSimulator[] = [];

afterEach(async () => {
  await harness?.close();
  harness = null;
  await Promise.all(simulators.splice(0).map((simulator) => simulator.stop()));
});

async function simulator(profile: 'stock-ultra' | 'stock-pro', files: string[] = []) {
  const instance = new DeviceSimulator({ profile, files });
  simulators.push(instance);
  return { instance, host: await instance.start() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

/**
 * The whole chain, with no test doubles between the module and the wire: a real
 * module produces a frame, the real renderer rasterizes it, the real scheduler and
 * upload queue push it, and a fake GeekMagic receives actual JPEG bytes.
 */
describe('module to device, end to end', () => {
  it('renders a real module frame and uploads valid JPEG bytes to a stock Ultra', async () => {
    harness = await createTestApp();
    const { instance, host } = await simulator('stock-ultra');

    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    // Claude Usage needs no network: with no bridge payload it renders a setup frame.
    const module = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: {
        items: [{ moduleInstanceId: module.id, viewId: 'rate-limits', dwellSeconds: 20 }],
      },
    });

    await startBackground(harness.ctx);

    const uploaded = await waitFor(() => instance.requests.some((r) => r.path === '/doUpload'));
    expect(uploaded, 'the scheduler never pushed a frame').toBe(true);

    const upload = instance.requests.find((request) => request.path === '/doUpload');
    expect(upload?.method).toBe('POST');
    expect(upload?.query['dir']).toBe('/image/');
    expect(upload?.parts[0]).toMatchObject({
      name: 'file',
      filename: 'dashboard.jpg',
      contentType: 'image/jpeg',
    });

    // The bytes on the wire must be a real 240x240 JPEG, not a placeholder.
    const body = upload?.body.toString('latin1') ?? '';
    const start = body.indexOf('\r\n\r\n') + 4;
    const jpeg = Buffer.from(body.slice(start, body.lastIndexOf('\r\n--')), 'latin1');
    const metadata = await sharp(jpeg).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(240);
    expect(metadata.height).toBe(240);
    expect(jpeg.length).toBeGreaterThan(2_000);

    expect(instance.theme).toBe(3);
    expect(instance.currentImage).toBe('/image/dashboard.jpg');
  });

  it('does not re-upload while the frame content is unchanged', async () => {
    harness = await createTestApp();
    const { instance, host } = await simulator('stock-ultra');

    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    const module = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: { items: [{ moduleInstanceId: module.id, viewId: 'rate-limits', dwellSeconds: 5 }] },
    });

    await startBackground(harness.ctx);
    await waitFor(() => instance.requests.some((r) => r.path === '/doUpload'));

    // Several dwell periods pass; the panel says the same thing throughout.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const uploads = instance.requests.filter((request) => request.path === '/doUpload');
    expect(uploads.length).toBe(1);
  }, 30_000);

  it('never writes to a device whose album consent is missing', async () => {
    harness = await createTestApp();
    const { instance, host } = await simulator('stock-pro', ['holiday.jpg']);

    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    const module = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: {
        items: [{ moduleInstanceId: module.id, viewId: 'rate-limits', dwellSeconds: 20 }],
      },
    });

    instance.reset();
    await startBackground(harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(instance.requests.filter((request) => request.method === 'POST')).toEqual([]);
    expect(instance.files).toEqual(['holiday.jpg']);
  }, 20_000);

  it('pushes a fresh frame after a bridge payload arrives', async () => {
    harness = await createTestApp();
    const { instance, host } = await simulator('stock-ultra');

    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    const module = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: {
        items: [{ moduleInstanceId: module.id, viewId: 'rate-limits', dwellSeconds: 30 }],
      },
    });
    // Shorten the per-device write spacing so this test measures the bridge-to-display
    // path rather than the flash-protection interval, which has its own tests.
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${device.id}`,
      payload: { minimumUploadIntervalSeconds: 5 },
    });

    await startBackground(harness.ctx);
    await waitFor(() => instance.requests.some((r) => r.path === '/doUpload'));
    const before = instance.requests.filter((request) => request.path === '/doUpload').length;

    // Real usage arrives out of band; the display must change without waiting for
    // the next scheduled refresh.
    const token = harness.ctx.claudeSettings.readOrCreateToken();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: '2.1.263',
        model: { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        rate_limits: {
          five_hour: { used_percentage: 41.6, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          seven_day: { used_percentage: 88.2, resets_at: Math.floor(Date.now() / 1000) + 172_800 },
        },
      },
      remoteAddress: '127.0.0.1',
    });
    expect(jsonBody(response)).toMatchObject({ accepted: true });

    const pushed = await waitFor(
      () => instance.requests.filter((request) => request.path === '/doUpload').length > before,
      20_000,
    );
    expect(pushed, 'the bridge payload did not reach the display').toBe(true);

    // And the new frame really is the usage panel, not the setup frame again.
    const uploads = instance.requests.filter((request) => request.path === '/doUpload');
    const first = uploads[0]?.body.toString('latin1');
    const latest = uploads.at(-1)?.body.toString('latin1');
    expect(latest).not.toBe(first);
  }, 45_000);
});

describe('saving module settings', () => {
  it('fetches with the new settings straight away instead of at the next poll', async () => {
    harness = await createTestApp({ background: true });

    const created = jsonBody<{ id: string; lastRefreshAt: string | null }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );
    // A new module has data before the response returns, not after the startup jitter.
    expect(created.lastRefreshAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const saved = jsonBody<{ lastRefreshAt: string | null }>(
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/module-instances/${created.id}`,
        payload: { settings: { accent: 'blue' } },
      }),
    );
    // Claude Usage polls every 60 seconds; this refresh came from the save.
    expect(Date.parse(saved.lastRefreshAt ?? '')).toBeGreaterThan(
      Date.parse(created.lastRefreshAt ?? ''),
    );
  });
});
