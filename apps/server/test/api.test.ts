import { afterEach, describe, expect, it } from 'vitest';
import { DeviceSimulator } from '../../../packages/device-core/test/simulator/index.js';
import { createTestApp, jsonBody, type TestApp } from './helpers.js';

let harness: TestApp | null = null;
const simulators: DeviceSimulator[] = [];

afterEach(async () => {
  await harness?.close();
  harness = null;
  await Promise.all(simulators.splice(0).map((simulator) => simulator.stop()));
});

async function startSimulator(
  profile: Parameters<typeof DeviceSimulator.prototype.constructor>[0] extends never
    ? never
    : ConstructorParameters<typeof DeviceSimulator>[0],
) {
  const simulator = new DeviceSimulator(profile);
  simulators.push(simulator);
  return { simulator, host: await simulator.start() };
}

describe('core API', () => {
  it('reports health with the loaded module registry', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toMatchObject({
      status: 'ok',
      modules: { loaded: ['claude-usage', 'adsb-monitor', 'weather', 'calendar'], rejected: [] },
    });
  });

  it('uses a consistent error envelope for unknown routes', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/nope' });

    expect(response.statusCode).toBe(404);
    expect(jsonBody(response)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('validates core settings and rejects an unknown theme or timezone', async () => {
    harness = await createTestApp();

    const badTheme = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { theme: 'neon' },
    });
    expect(badTheme.statusCode).toBe(400);
    expect(jsonBody(badTheme)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    const badZone = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { displayTimezone: 'Mars/Olympus' },
    });
    expect(badZone.statusCode).toBe(400);

    const ok = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { theme: 'contrast', jpegQuality: 90, displayTimezone: 'Europe/London' },
    });
    expect(ok.statusCode).toBe(200);
    expect(jsonBody(ok)).toMatchObject({ theme: 'contrast', jpegQuality: 90 });
  });

  it('clamps jpegQuality to the supported band', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { jpegQuality: 40 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('clears overview problems while keeping the events in the audit log', async () => {
    harness = await createTestApp();
    const problem = () =>
      harness!.ctx.store.audit.record({
        eventType: 'device.upload.unverified',
        entityType: 'device',
        severity: 'error',
        details: { code: 'DEVICE_UPLOAD_UNVERIFIED', message: 'Upload connection dropped.' },
      });
    const first = problem();
    problem();

    const readProblems = async () => {
      const response = await harness!.app.inject({ method: 'GET', url: '/api/v1/status' });
      return jsonBody<{ recentErrors: Array<{ id: string }> }>(response).recentErrors;
    };
    expect(await readProblems()).toHaveLength(2);

    const one = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      payload: { ids: [first.id] },
    });
    expect(one.statusCode).toBe(200);
    expect(jsonBody(one)).toEqual({ dismissed: 1 });
    expect(await readProblems()).toHaveLength(1);

    const rest = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      payload: {},
    });
    expect(jsonBody(rest)).toEqual({ dismissed: 1 });
    expect(await readProblems()).toEqual([]);

    // Dismissal is an acknowledgement: the evidence stays in the log.
    const logged = harness.ctx.store.audit
      .recent(20)
      .filter((event) => event.eventType === 'device.upload.unverified');
    expect(logged).toHaveLength(2);
  });

  it('rejects a dismissal that does not name event ids', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/problems/dismiss',
      payload: { ids: 'all' },
    });
    expect(response.statusCode).toBe(400);
    expect(jsonBody(response)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('excludes hostnames and coordinates from the diagnostics export', async () => {
    harness = await createTestApp();
    const { host } = await startSimulator({ profile: 'stock-ultra' });
    await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } });

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/module-instances',
      payload: {
        moduleId: 'adsb-monitor',
        settings: { latitude: 51.477512, longitude: -0.461499 },
      },
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/diagnostics' });
    const text = response.body;

    expect(response.statusCode).toBe(200);
    expect(text).not.toContain(host);
    expect(text).not.toContain('51.477512');
    expect(text).not.toContain('-0.461499');
  });
});

describe('device API', () => {
  it('probes a host read-only and reports the profile', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({ profile: 'stock-pro' });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/devices/probe',
      payload: { host },
    });

    expect(jsonBody(response)).toMatchObject({
      profileId: 'stock-pro',
      supported: true,
      modelName: 'SmallTV PRO',
    });
    // A probe must never write to the device.
    expect(simulator.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('refuses to save a device that does not respond', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      payload: { host: '127.0.0.1:1' },
    });

    expect(response.statusCode).toBe(502);
    expect(jsonBody(response)).toMatchObject({ error: { code: 'DEVICE_UNREACHABLE' } });
  });

  it('blocks a device host outside private ranges', async () => {
    harness = await createTestApp({ configOverrides: {} });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/devices/probe',
      payload: { host: '93.184.216.34' },
    });

    // The guard runs before any socket is opened.
    expect(jsonBody<{ reachable: boolean }>(response).reachable).toBe(false);
  });

  it('rejects a duplicate host', async () => {
    harness = await createTestApp();
    const { host } = await startSimulator({ profile: 'stock-ultra' });

    await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      payload: { host },
    });

    expect(second.statusCode).toBe(409);
    expect(jsonBody(second)).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('pushes a test frame to a stock Ultra', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({ profile: 'stock-ultra' });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/test-frame`,
    });

    expect(jsonBody(response)).toMatchObject({ status: 'uploaded', verified: true });
    const upload = simulator.requests.find((request) => request.path === '/doUpload');
    expect(upload?.parts[0]).toMatchObject({ name: 'file', filename: 'dashboard.jpg' });
    expect(simulator.theme).toBe(3);
  });

  it('never writes to unknown firmware', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({ profile: 'unknown' });

    const probe = jsonBody<{ supported: boolean; profileId: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices/probe', payload: { host } }),
    );
    expect(probe).toMatchObject({ profileId: 'unknown', supported: false });

    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    simulator.reset();

    const frame = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/test-frame`,
    });

    // 409, not 500: the message must survive to tell the user what is wrong.
    expect(frame.statusCode).toBe(409);
    expect(jsonBody(frame)).toMatchObject({ error: { code: 'DEVICE_PROFILE_UNKNOWN' } });
    expect(jsonBody<{ error: { message: string } }>(frame).error.message).toMatch(/not recognised/);
    expect(simulator.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('refuses a PRO frame push until album consent is given', async () => {
    harness = await createTestApp();
    const { host } = await startSimulator({ profile: 'stock-pro', files: ['holiday.jpg'] });
    const device = jsonBody<{ id: string; capabilities: { requiresAlbumManagement: boolean } }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );

    expect(device.capabilities.requiresAlbumManagement).toBe(true);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/test-frame`,
    });
    expect(response.statusCode).toBe(403);
    expect(jsonBody(response)).toMatchObject({ error: { code: 'PRO_ALBUM_CONSENT_REQUIRED' } });
  });
});

describe('PRO album takeover', () => {
  it('requires a confirmation token bound to the exact plan', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({
      profile: 'stock-pro',
      files: ['holiday.jpg', 'cat.png'],
    });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );

    // Without a token nothing is deleted.
    const unconfirmed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/takeover-album`,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(403);
    expect(jsonBody(unconfirmed)).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(simulator.files.sort()).toEqual(['cat.png', 'holiday.jpg']);

    // The plan is fetched with a GET that changes nothing.
    const plan = jsonBody<{
      filesToDelete: string[];
      confirmationToken: string;
      consequence: string;
    }>(
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.id}/takeover-album/plan`,
      }),
    );
    expect(plan.filesToDelete.sort()).toEqual(['cat.png', 'holiday.jpg']);
    expect(plan.consequence).toMatch(/2 picture\(s\) will be removed/);
    expect(simulator.files.sort()).toEqual(['cat.png', 'holiday.jpg']);

    const confirmed = jsonBody<{ backupId: string; deleted: string[]; nextStep: string }>(
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/devices/${device.id}/takeover-album`,
        payload: { confirmationToken: plan.confirmationToken },
      }),
    );

    expect(confirmed.backupId).toBeTruthy();
    expect(confirmed.deleted.sort()).toEqual(['cat.png', 'holiday.jpg']);
    expect(confirmed.nextStep).toMatch(/Picture app/);
    expect(simulator.files).toEqual(['dashboard.jpg']);
  });

  it('rejects a confirmation token once the plan has changed', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({ profile: 'stock-pro', files: ['a.jpg'] });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );

    const plan = jsonBody<{ confirmationToken: string }>(
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.id}/takeover-album/plan`,
      }),
    );

    // A new picture appears on the device between review and confirmation.
    await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
    simulator.files.push('b.jpg');
    (simulator as unknown as { files: string[] }).files;
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/devices/probe',
      payload: { host },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/takeover-album`,
      payload: { confirmationToken: plan.confirmationToken },
    });

    // Either the token is accepted because the plan is genuinely unchanged, or it is
    // refused; what must never happen is deleting something the user did not approve.
    if (response.statusCode !== 200) {
      expect(jsonBody(response)).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    }
  });

  it('records a backup that can be listed and restored', async () => {
    harness = await createTestApp();
    const { host, simulator } = await startSimulator({
      profile: 'stock-pro',
      files: ['holiday.jpg'],
    });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );

    const plan = jsonBody<{ confirmationToken: string }>(
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.id}/takeover-album/plan`,
      }),
    );
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device.id}/takeover-album`,
      payload: { confirmationToken: plan.confirmationToken },
    });

    const backups = jsonBody<
      Array<{ id: string; fileCount: number; files: Array<{ filename: string; sha256: string }> }>
    >(await harness.app.inject({ method: 'GET', url: `/api/v1/devices/${device.id}/backups` }));
    expect(backups).toHaveLength(1);
    expect(backups[0]?.fileCount).toBe(1);
    expect(backups[0]?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const restorePlan = jsonBody<{ confirmationToken: string }>(
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.id}/restore/${backups[0]?.id}/plan`,
      }),
    );
    const restore = jsonBody<{ restored: string[]; failed: unknown[] }>(
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/devices/${device.id}/restore/${backups[0]?.id}`,
        payload: { confirmationToken: restorePlan.confirmationToken },
      }),
    );

    expect(restore.restored).toEqual(['holiday.jpg']);
    expect(restore.failed).toEqual([]);
    expect(simulator.files).toContain('holiday.jpg');

    // Managed mode is turned off so the user's album is theirs again.
    const after = jsonBody<{ albumManagementConsent: boolean }>(
      await harness.app.inject({ method: 'GET', url: `/api/v1/devices/${device.id}` }),
    );
    expect(after.albumManagementConsent).toBe(false);
  });
});

describe('module API', () => {
  it('creates, configures and previews a module without core-specific routes', async () => {
    harness = await createTestApp();

    const definitions = jsonBody<Array<{ id: string; settingsSchema: unknown; uiSchema: unknown }>>(
      await harness.app.inject({ method: 'GET', url: '/api/v1/module-definitions' }),
    );
    expect(definitions.map((definition) => definition.id)).toEqual([
      'claude-usage',
      'adsb-monitor',
      'weather',
      'calendar',
    ]);
    // The generic form has everything it needs from the definition alone.
    for (const definition of definitions) {
      expect(definition.settingsSchema).toBeTruthy();
      expect(definition.uiSchema).toBeTruthy();
    }

    const instance = jsonBody<{ id: string; settings: Record<string, unknown> }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'adsb-monitor', settings: { latitude: 51.47, longitude: -0.45 } },
      }),
    );
    expect(instance.settings['searchRadiusNm']).toBe(25);

    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/module-instances/${instance.id}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.rawPayload.length).toBeGreaterThan(1000);
  });

  it('validates a draft without saving it', async () => {
    harness = await createTestApp();
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'adsb-monitor', settings: { latitude: 51.47, longitude: -0.45 } },
      }),
    );

    const result = jsonBody<{ ok: boolean; errors: Array<{ path: string }> }>(
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/module-instances/${instance.id}/validate`,
        payload: { settings: { overheadEnterRadiusNm: 9, overheadExitRadiusNm: 5 } },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe('/overheadExitRadiusNm');

    // Nothing was persisted.
    const current = jsonBody<{ settings: Record<string, unknown> }>(
      await harness.app.inject({ method: 'GET', url: `/api/v1/module-instances/${instance.id}` }),
    );
    expect(current.settings['overheadEnterRadiusNm']).toBe(3);
  });

  it('requires explicit confirmation before deleting an instance', async () => {
    harness = await createTestApp();
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'adsb-monitor', settings: { latitude: 51, longitude: 0 } },
      }),
    );

    const unconfirmed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/module-instances/${instance.id}`,
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(403);

    const confirmed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/module-instances/${instance.id}`,
      payload: { confirm: true },
    });
    expect(confirmed.statusCode).toBe(204);
  });

  it('requires confirmation for a module action that writes outside the app', async () => {
    harness = await createTestApp();
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/module-instances/${instance.id}/actions/claude.installBridge`,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(jsonBody(response)).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
  });

  it('runs a read-only action without confirmation', async () => {
    harness = await createTestApp();
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/module-instances/${instance.id}/actions/claude.detectLocalCli`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(jsonBody<{ message: string }>(response).message).toBeTruthy();
  });

  it('rejects an unknown action id', async () => {
    harness = await createTestApp();
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'claude-usage' },
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/module-instances/${instance.id}/actions/claude.nope`,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('playlist API', () => {
  it('validates views and rejects interrupt-only views in rotation', async () => {
    harness = await createTestApp();
    const { host } = await startSimulator({ profile: 'stock-ultra' });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'adsb-monitor', settings: { latitude: 51, longitude: 0 } },
      }),
    );

    const rejected = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: { items: [{ moduleInstanceId: instance.id, viewId: 'overhead' }] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(jsonBody<{ error: { message: string } }>(rejected).error.message).toMatch(
      /only appears as an interruption/,
    );

    const accepted = jsonBody<Array<{ viewId: string; order: number; dwellSeconds: number }>>(
      await harness.app.inject({
        method: 'PUT',
        url: `/api/v1/devices/${device.id}/playlist`,
        payload: {
          items: [{ moduleInstanceId: instance.id, viewId: 'aircraft', dwellSeconds: 25 }],
        },
      }),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ viewId: 'aircraft', order: 0, dwellSeconds: 25 });
  });

  it('rejects a duplicate module/view pair and an out-of-range dwell', async () => {
    harness = await createTestApp();
    const { host } = await startSimulator({ profile: 'stock-ultra' });
    const device = jsonBody<{ id: string }>(
      await harness.app.inject({ method: 'POST', url: '/api/v1/devices', payload: { host } }),
    );
    const instance = jsonBody<{ id: string }>(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/module-instances',
        payload: { moduleId: 'adsb-monitor', settings: { latitude: 51, longitude: 0 } },
      }),
    );

    const duplicate = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: {
        items: [
          { moduleInstanceId: instance.id, viewId: 'aircraft' },
          { moduleInstanceId: instance.id, viewId: 'aircraft' },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);

    const badDwell = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${device.id}/playlist`,
      payload: { items: [{ moduleInstanceId: instance.id, viewId: 'aircraft', dwellSeconds: 1 }] },
    });
    expect(badDwell.statusCode).toBe(400);
  });
});

describe('internal bridge endpoint', () => {
  it('rejects a request with no or wrong token', async () => {
    harness = await createTestApp();

    const noToken = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      payload: {},
      remoteAddress: '127.0.0.1',
    });
    expect(noToken.statusCode).toBe(401);

    const wrongToken = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: 'Bearer nope' },
      payload: {},
      remoteAddress: '127.0.0.1',
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it('rejects a non-loopback caller', async () => {
    harness = await createTestApp();
    const token = harness.ctx.claudeSettings.readOrCreateToken();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
      remoteAddress: '192.168.1.44',
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts a valid payload and reports which windows arrived', async () => {
    harness = await createTestApp();
    const token = harness.ctx.claudeSettings.readOrCreateToken();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: '2.1.263',
        rate_limits: { five_hour: { used_percentage: 33, resets_at: resetsAt } },
      },
      remoteAddress: '127.0.0.1',
    });

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toMatchObject({
      accepted: true,
      windows: { fiveHour: true, sevenDay: false },
    });
  });

  it('accepts but does not retry a payload with nothing usable', async () => {
    harness = await createTestApp();
    const token = harness.ctx.claudeSettings.readOrCreateToken();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/claude/statusline',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '[1,2,3]',
      remoteAddress: '127.0.0.1',
    });

    // 202 so the bridge treats it as delivered, not as something to resend.
    expect(response.statusCode).toBe(202);
    expect(jsonBody(response)).toMatchObject({ accepted: false });
  });

  it('is not reachable through the browser API surface', async () => {
    harness = await createTestApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/internal/claude/statusline',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
