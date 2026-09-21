import { afterEach, describe, expect, it } from 'vitest';
import { detectProfile } from '../src/detection.js';
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
    defaultTimeoutMs: 2_000,
  });
  return { simulator, transport };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((simulator) => simulator.stop()));
});

describe('firmware detection', () => {
  it('identifies a stock Ultra from the model string in /v.json', async () => {
    const { transport, simulator } = await connect('stock-ultra');
    const result = await detectProfile(transport);

    expect(result.profileId).toBe('stock-ultra');
    expect(result.modelName).toBe('SmallTV Ultra');
    expect(result.firmwareVersion).toBe('1.4.2');
    expect(result.supported).toBe(true);
    // The model string is conclusive, so detection must stop at the first step.
    expect(simulator.trace).toEqual(['GET /v.json']);
  });

  it('identifies a stock PRO and prefers "pro" over "ultra" in the model string', async () => {
    const { transport } = await connect('stock-pro');
    const result = await detectProfile(transport);

    expect(result.profileId).toBe('stock-pro');
    expect(result.modelName).toBe('SmallTV PRO');
    expect(result.supported).toBe(true);
  });

  it('falls through to /.sys/app.json when /v.json is malformed', async () => {
    const simulator = new DeviceSimulator({ profile: 'malformed-json' });
    running.push(simulator);
    const host = await simulator.start();
    const transport = new DeviceTransport({
      host,
      policy: { allowlist: [], allowLoopback: true, allowPublic: false },
      defaultTimeoutMs: 2_000,
    });

    const result = await detectProfile(transport);

    expect(result.profileId).toBe('unknown');
    expect(result.reachable).toBe(true);
    expect(result.supported).toBe(false);
    // Every documented step is attempted before giving up.
    expect(simulator.trace).toEqual([
      'GET /v.json',
      'GET /.sys/app.json',
      'GET /app.json',
      'GET /theme/list',
      'GET /',
    ]);
  });

  it('identifies SD_PRO firmware from the theme list', async () => {
    const { transport, simulator } = await connect('sd-pro');
    const result = await detectProfile(transport);

    expect(result.profileId).toBe('sd-pro');
    expect(result.supported).toBe(true);
    expect(simulator.trace).toEqual([
      'GET /v.json',
      'GET /.sys/app.json',
      'GET /app.json',
      'GET /theme/list',
    ]);
  });

  it('recognises legacy weather-clock firmware but marks it unsupported', async () => {
    const { transport } = await connect('legacy');
    const result = await detectProfile(transport);

    expect(result.profileId).toBe('weather-clock-legacy');
    expect(result.supported).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/diagnostics only/i);
  });

  it('reports unknown firmware without marking the device unreachable', async () => {
    const { transport } = await connect('unknown');
    const result = await detectProfile(transport);

    expect(result.profileId).toBe('unknown');
    expect(result.reachable).toBe(true);
    expect(result.supported).toBe(false);
  });

  it('records a redacted transcript for every attempted step', async () => {
    const { transport } = await connect('sd-pro');
    const result = await detectProfile(transport);

    expect(result.transcript).toHaveLength(4);
    expect(result.transcript.at(-1)).toMatchObject({ step: 'theme-list', outcome: 'match' });
    expect(result.transcript[0]).toMatchObject({ path: '/v.json', outcome: 'no-match' });
    for (const entry of result.transcript) {
      expect(typeof entry.durationMs).toBe('number');
    }
  });

  it('marks the device unreachable when nothing responds', async () => {
    // Port 1 on loopback has nothing listening.
    const transport = new DeviceTransport({
      host: '127.0.0.1:1',
      policy: { allowlist: [], allowLoopback: true, allowPublic: false },
      defaultTimeoutMs: 400,
    });

    const result = await detectProfile(transport);

    expect(result.reachable).toBe(false);
    expect(result.profileId).toBe('unknown');
    expect(result.transcript.every((entry) => entry.outcome === 'error')).toBe(true);
  });
});
