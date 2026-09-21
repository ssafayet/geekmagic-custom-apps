import { afterEach, describe, expect, it } from 'vitest';
import { draft, SchedulerHarness } from './scheduler-harness.js';

let harness: SchedulerHarness;

function setup(): SchedulerHarness {
  harness = new SchedulerHarness();
  return harness;
}

afterEach(() => {
  harness?.close();
});

describe('display rotation', () => {
  it('shows the first item, then advances after its dwell time', async () => {
    const h = setup();
    h.addModule('claude', [draft('claude-frame', 'Claude')]);
    h.addModule('adsb', [draft('adsb-frame', 'ADS-B')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [
      { moduleInstanceId: 'claude', viewId: 'main', dwellSeconds: 20 },
      { moduleInstanceId: 'adsb', viewId: 'main', dwellSeconds: 20 },
    ]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame']);

    // Still inside the dwell window: nothing new is pushed.
    h.advance(10_000);
    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame']);

    h.advance(11_000);
    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame', 'adsb-frame']);
  });

  it('wraps back to the start of the playlist', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addModule('b', [draft('b-frame', 'B')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [
      { moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 10 },
      { moduleInstanceId: 'b', viewId: 'main', dwellSeconds: 10 },
    ]);
    h.scheduler.rebuildSchedules();

    for (let i = 0; i < 4; i += 1) {
      await h.scheduler.tick();
      h.advance(11_000);
    }

    expect(h.uploadsFor('dev1')).toEqual(['a-frame', 'b-frame', 'a-frame', 'b-frame']);
  });

  it('does not re-upload an unchanged frame while it stays on screen', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [{ moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 20 }]);
    h.scheduler.rebuildSchedules();

    for (let i = 0; i < 30; i += 1) {
      await h.scheduler.tick();
      h.advance(1_000);
    }

    // A single-item playlist whose content never changes writes exactly once.
    expect(h.uploadsFor('dev1')).toEqual(['a-frame']);
  });

  it('pushes again when the module content changes', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'First')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [{ moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 60 }]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    h.setFrame('a', 'main', draft('a-frame', 'Second'));
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.uploads.filter((upload) => upload.deviceId === 'dev1')).toHaveLength(2);
    expect(h.uploads[0]?.fingerprint).not.toBe(h.uploads[1]?.fingerprint);
  });

  it('does nothing for a device with an empty playlist', async () => {
    const h = setup();
    h.addDevice('dev1');
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toEqual([]);
    expect(h.scheduler.describeDevice('dev1')).toMatchObject({ current: null, interrupted: false });
  });

  it('skips a playlist entry whose module is no longer running', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    // Configured in the database but not loaded by the runtime manager.
    h.addOrphanInstance('ghost');
    h.addDevice('dev1');
    h.setPlaylist('dev1', [
      { moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 10 },
      { moduleInstanceId: 'ghost', viewId: 'main', dwellSeconds: 10 },
    ]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    h.advance(11_000);
    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toEqual(['a-frame']);
  });
});

describe('attention interruption', () => {
  function interruptingSetup(): SchedulerHarness {
    const h = setup();
    h.addModule('claude', [draft('claude-frame', 'Claude')]);
    h.addModule('adsb', [
      draft('adsb-frame', 'ADS-B'),
      draft('adsb-overhead', 'Overhead', 'overhead'),
    ]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [
      { moduleInstanceId: 'claude', viewId: 'main', dwellSeconds: 20 },
      { moduleInstanceId: 'adsb', viewId: 'main', dwellSeconds: 20 },
    ]);
    h.scheduler.rebuildSchedules();
    return h;
  }

  function raise(h: SchedulerHarness, key = 'overhead:abc', holdSeconds = 30): void {
    h.events.emit('module.attention', {
      instanceId: 'adsb',
      moduleId: 'adsb-monitor',
      viewId: 'overhead',
      key,
      holdSeconds,
      reason: 'aircraft overhead',
    });
  }

  it('interrupts the rotation with the attention view', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame']);

    raise(h);
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toEqual(['claude-frame', 'adsb-overhead']);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
  });

  it('holds the interruption while the aircraft remains overhead', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();
    raise(h, 'overhead:abc', 30);

    for (let i = 0; i < 120; i += 1) {
      h.advance(1_000);
      await h.scheduler.tick();
    }

    // Two minutes of rotation time has passed, but the key was never released.
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame', 'adsb-overhead']);
  });

  it('resumes the previous playlist item after the aircraft leaves', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();
    raise(h);
    h.advance(1_000);
    await h.scheduler.tick();

    h.events.emit('module.attention-released', { instanceId: 'adsb', key: 'overhead:abc' });
    // The minimum hold is still in force immediately after release.
    h.advance(1_000);
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);

    h.advance(30_000);
    await h.scheduler.tick();

    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);
    // Rotation picks up at the item that was showing, not at the top of the list.
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame', 'adsb-overhead', 'claude-frame']);
  });

  it('suppresses a second interruption inside the per-device cooldown', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();

    raise(h, 'overhead:first', 10);
    h.advance(1_000);
    await h.scheduler.tick();
    h.events.emit('module.attention-released', { instanceId: 'adsb', key: 'overhead:first' });
    h.advance(11_000);
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);

    // A new aircraft two seconds later must not immediately take over again.
    h.advance(2_000);
    raise(h, 'overhead:second', 30);
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);

    // After the cooldown elapses, the next event is honoured.
    h.advance(16_000);
    raise(h, 'overhead:third', 30);
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
  });

  it('extends the hold when the same key is raised again', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();
    raise(h, 'overhead:abc', 10);
    h.advance(1_000);
    await h.scheduler.tick();

    h.events.emit('module.attention-released', { instanceId: 'adsb', key: 'overhead:abc' });
    h.advance(5_000);
    raise(h, 'overhead:abc', 30);
    h.advance(6_000);
    await h.scheduler.tick();

    // Without the extension the original 10s hold would already have expired.
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
  });

  it('only interrupts devices that already show the raising module', async () => {
    const h = interruptingSetup();
    h.addDevice('dev2');
    h.setPlaylist('dev2', [{ moduleInstanceId: 'claude', viewId: 'main', dwellSeconds: 20 }]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    raise(h);
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
    expect(h.scheduler.describeDevice('dev2').interrupted).toBe(false);
    expect(h.uploadsFor('dev2')).toEqual(['claude-frame']);
  });

  it('falls back to rotation when the attention view produces no frame', async () => {
    const h = interruptingSetup();
    await h.scheduler.tick();
    h.setFrame('adsb', 'overhead', null);

    raise(h);
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);
  });
});

describe('refresh jobs', () => {
  it('refreshes each instance on its own interval', async () => {
    const h = setup();
    const module = h.addModule('a', [draft('a-frame', 'A')]);
    h.scheduler.rebuildJobs();

    await h.scheduler.tick();
    expect(module.refreshCount).toBeLessThanOrEqual(1);

    h.advance(10_000);
    await h.scheduler.tick();
    const afterFirst = module.refreshCount;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // The 15s interval plus jitter has not elapsed yet.
    h.advance(2_000);
    await h.scheduler.tick();
    expect(module.refreshCount).toBe(afterFirst);

    h.advance(20_000);
    await h.scheduler.tick();
    expect(module.refreshCount).toBe(afterFirst + 1);
  });

  it('never runs two refreshes of the same instance concurrently', async () => {
    const h = setup();
    const module = h.addModule('slow', [draft('slow-frame', 'Slow')], { refreshDelayMs: 40 });
    h.scheduler.rebuildJobs();

    await h.scheduler.tick();
    // Drive several ticks while the first refresh is still in flight.
    for (let i = 0; i < 5; i += 1) {
      h.advance(30_000);
      await h.scheduler.tick();
    }

    expect(module.refreshCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  it('backs a failing module off instead of hammering it', async () => {
    const h = setup();
    const module = h.addModule('flaky', [draft('flaky-frame', 'Flaky')]);
    module.failures = 3;
    h.scheduler.rebuildJobs();

    await h.scheduler.tick();
    h.advance(20_000);
    await h.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const afterFailure = module.refreshCount;

    // Interval alone would be due again, but the backoff is not yet satisfied.
    h.advance(16_000);
    await h.scheduler.tick();
    expect(module.refreshCount).toBe(afterFailure);

    h.advance(30_000);
    await h.scheduler.tick();
    expect(module.refreshCount).toBeGreaterThan(afterFailure);
  });

  it('does not schedule a refresh for a module that is not running', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.modules.delete('a');
    h.scheduler.rebuildJobs();

    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.uploads).toEqual([]);
  });
});

describe('invalidation', () => {
  it('re-pushes after a snapshot event even when the frame is unchanged', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [{ moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 60 }]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toHaveLength(1);

    h.events.emit('module.snapshot', {
      instanceId: 'a',
      moduleId: 'a',
      at: new Date().toISOString(),
    });
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toHaveLength(2);
  });

  it('re-renders every device when the theme changes', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [{ moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 60 }]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    h.scheduler.setRenderOptions({ themeId: 'contrast' });
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toHaveLength(2);
  });

  it('retries a retryable push failure on the next tick', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [{ moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 60 }]);
    h.failUploadsFor.add('dev1');
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual([]);

    h.failUploadsFor.delete('dev1');
    h.advance(1_000);
    await h.scheduler.tick();

    expect(h.uploadsFor('dev1')).toEqual(['a-frame']);
  });
});

describe('describeDevice', () => {
  it('reports the current and next playlist entries', async () => {
    const h = setup();
    h.addModule('a', [draft('a-frame', 'A')]);
    h.addModule('b', [draft('b-frame', 'B')]);
    h.addDevice('dev1');
    h.setPlaylist('dev1', [
      { moduleInstanceId: 'a', viewId: 'main', dwellSeconds: 20 },
      { moduleInstanceId: 'b', viewId: 'main', dwellSeconds: 20 },
    ]);
    h.scheduler.rebuildSchedules();

    await h.scheduler.tick();

    expect(h.scheduler.describeDevice('dev1')).toMatchObject({
      current: { moduleInstanceId: 'a', viewId: 'main' },
      next: { moduleInstanceId: 'b', viewId: 'main' },
      interrupted: false,
    });
  });
});
