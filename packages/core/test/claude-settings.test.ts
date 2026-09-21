import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deepEqual, LocalClaudeSettingsService } from '../src/host/claude-settings.js';

let dataDir: string;
let settingsPath: string;

function service(): LocalClaudeSettingsService {
  return new LocalClaudeSettingsService({
    dataDir,
    bridgeCommand: '/usr/bin/node /opt/gca/bridge.js',
    endpoint: 'http://127.0.0.1:3210/internal/claude/statusline',
    settingsPath,
  });
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gca-bridge-'));
  settingsPath = join(dataDir, 'claude-settings.json');
});

describe('install', () => {
  it('creates a settings file when none exists', async () => {
    const state = await service().install();

    expect(state.installed).toBe(true);
    expect(state.chainedCommand).toBeNull();
    expect(readSettings()['statusLine']).toMatchObject({ type: 'command' });
  });

  it('preserves every unrelated key in the settings file', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'claude-opus-5',
        permissions: { allow: ['Bash(npm test)'] },
        env: { FOO: 'bar' },
        hooks: { PostToolUse: [] },
      }),
    );

    await service().install();
    const settings = readSettings();

    expect(settings['model']).toBe('claude-opus-5');
    expect(settings['permissions']).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings['env']).toEqual({ FOO: 'bar' });
    expect(settings['hooks']).toEqual({ PostToolUse: [] });
  });

  it('records an existing status line verbatim and chains it', async () => {
    const existing = { type: 'command', command: '~/bin/my-statusline.sh --fancy', padding: 2 };
    writeFileSync(settingsPath, JSON.stringify({ statusLine: existing }));

    const state = await service().install();

    expect(state.chainedCommand).toBe('~/bin/my-statusline.sh --fancy');
    const manifest = service().readManifest();
    expect(manifest?.previousStatusLine).toEqual(existing);
    // Padding is carried over so the visible status line does not shift.
    expect((readSettings()['statusLine'] as Record<string, unknown>)['padding']).toBe(2);
  });

  it('writes a timestamped backup before modifying an existing file', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'x', statusLine: { type: 'command', command: 'old' } }),
    );

    const state = await service().install();

    expect(state.backupPath).toBeTruthy();
    expect(existsSync(state.backupPath as string)).toBe(true);
    const backup = JSON.parse(readFileSync(state.backupPath as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(backup['statusLine']).toEqual({ type: 'command', command: 'old' });
  });

  it('never writes the bridge token into Claude settings', async () => {
    const svc = service();
    await svc.install();
    const token = svc.readOrCreateToken();

    expect(token.length).toBeGreaterThan(16);
    expect(readFileSync(settingsPath, 'utf8')).not.toContain(token);
    // The command points at an owner-only token file instead.
    expect(readFileSync(settingsPath, 'utf8')).toContain('--config');
  });

  it('stores the token file with owner-only permissions', async () => {
    const svc = service();
    svc.readOrCreateToken();
    if (process.platform === 'win32') return;
    expect(statSync(svc.tokenPath).mode & 0o777).toBe(0o600);
  });

  it('returns a stable token across calls', () => {
    const svc = service();
    expect(svc.readOrCreateToken()).toBe(svc.readOrCreateToken());
  });

  it('refuses to rewrite a settings file that is not valid JSON', async () => {
    writeFileSync(settingsPath, '{ this is not json');
    await expect(service().install()).rejects.toMatchObject({
      code: 'CLAUDE_BRIDGE_INSTALL_FAILED',
    });
    // The user's file is left exactly as it was.
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not json');
  });

  it('treats an empty settings file as an empty object', async () => {
    writeFileSync(settingsPath, '   ');
    const state = await service().install();
    expect(state.installed).toBe(true);
  });
});

describe('inspect', () => {
  it('reports not installed before installation', async () => {
    const state = await service().inspect();
    expect(state.installed).toBe(false);
    expect(state.conflict).toBeNull();
  });

  it('reports installed while the status line still matches', async () => {
    await service().install();
    const state = await service().inspect();
    expect(state.installed).toBe(true);
    expect(state.conflict).toBeNull();
  });

  it('detects an external change to the status line', async () => {
    await service().install();
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'something-else' } }),
    );

    const state = await service().inspect();

    expect(state.installed).toBe(false);
    expect(state.conflict).toMatch(/no longer matches/);
  });
});

describe('uninstall', () => {
  it('removes the statusLine key entirely when there was none before', async () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'claude-opus-5' }));

    await service().install();
    const state = await service().uninstall();

    expect(state.installed).toBe(false);
    expect(state.conflict).toBeNull();
    const settings = readSettings();
    expect('statusLine' in settings).toBe(false);
    expect(settings['model']).toBe('claude-opus-5');
  });

  it('restores the previous status line byte-for-byte', async () => {
    const existing = {
      type: 'command',
      command: 'npx ccusage statusline --visual-burn-rate emoji',
      padding: 0,
      refreshInterval: 1000,
    };
    writeFileSync(settingsPath, JSON.stringify({ statusLine: existing, model: 'x' }));

    await service().install();
    expect(readSettings()['statusLine']).not.toEqual(existing);

    await service().uninstall();

    expect(readSettings()['statusLine']).toEqual(existing);
    expect(readSettings()['model']).toBe('x');
  });

  it('refuses to revert a status line that changed after installation', async () => {
    const existing = { type: 'command', command: 'original' };
    writeFileSync(settingsPath, JSON.stringify({ statusLine: existing }));
    await service().install();

    const userEdit = { type: 'command', command: 'user-changed-this-later' };
    writeFileSync(settingsPath, JSON.stringify({ statusLine: userEdit }));

    const state = await service().uninstall();

    expect(state.conflict).toMatch(/modified after the bridge was installed/);
    // The user's own edit survives untouched.
    expect(readSettings()['statusLine']).toEqual(userEdit);
  });

  it('is a no-op when no manifest exists', async () => {
    const state = await service().uninstall();
    expect(state.installed).toBe(false);
    expect(state.conflict).toBeNull();
  });

  it('survives an install/uninstall round trip repeated twice', async () => {
    const original = { type: 'command', command: 'mine' };
    writeFileSync(settingsPath, JSON.stringify({ statusLine: original }));

    for (let i = 0; i < 2; i += 1) {
      await service().install();
      await service().uninstall();
      expect(readSettings()['statusLine']).toEqual(original);
    }
  });
});

describe('deepEqual', () => {
  it('compares nested objects irrespective of key order', () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('re-installing', () => {
  const ORIGINAL = { type: 'command', command: '/usr/local/bin/my-statusline', padding: 0 };

  it('does not chain the bridge to itself', async () => {
    writeFileSync(settingsPath, JSON.stringify({ statusLine: ORIGINAL }));
    const first = await service().install();
    expect(first.chainedCommand).toBe('/usr/local/bin/my-statusline');

    // Running install again used to treat the bridge's own status line as a
    // pre-existing one, so every render spawned it twice and posted twice.
    const second = await service().install();

    expect(second.chainedCommand).toBe('/usr/local/bin/my-statusline');

    // The written command must invoke the bridge once, not wrap a previous one.
    const written = readSettings()['statusLine'] as { command: string };
    expect(written.command).toContain('/opt/gca/bridge.js');
    expect(written.command).not.toContain('my-statusline');
    expect(service().readManifest()?.previousStatusLine).toEqual(ORIGINAL);
  });

  it('keeps uninstall able to restore the original after repeated installs', async () => {
    writeFileSync(settingsPath, JSON.stringify({ statusLine: ORIGINAL }));
    await service().install();
    await service().install();
    await service().install();

    await service().uninstall();

    expect(readSettings()['statusLine']).toEqual(ORIGINAL);
  });

  it('repairs a manifest an earlier install already self-chained', async () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    await service().install();
    const svc = service();
    const manifest = svc.readManifest();
    // Reproduce the corruption the old install produced, by hand.
    writeFileSync(
      svc.manifestPath,
      JSON.stringify({ ...manifest, previousStatusLine: manifest?.writtenStatusLine }),
    );

    const state = await service().install();

    expect(state.chainedCommand).toBeNull();
    expect(service().readManifest()?.previousStatusLine).toBeNull();
  });

  it('leaves nothing chained when there was no status line to begin with', async () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    await service().install();

    const second = await service().install();

    expect(second.chainedCommand).toBeNull();
  });
});
