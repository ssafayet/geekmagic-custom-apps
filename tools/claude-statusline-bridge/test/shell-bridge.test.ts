import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeStatuslinePayload } from '@gca/module-claude-usage';

/**
 * Runs tools/claude-bridge.sh — the Node-free bridge for a server in Docker — under
 * the system /bin/sh against a fake server. On CI that shell is dash, which is
 * stricter than the bash-as-sh macOS ships, so this is what keeps it portable.
 */

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'claude-bridge.sh');
const TOKEN = 'k3y-with-an-equals-sign-at-the-end=';

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

let server: Server;
let received: Received[];
let respond: (request: Received) => { status: number; body: unknown };
let base: string;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, reply) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const entry = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      };
      received.push(entry);
      const answer = respond(entry);
      reply.writeHead(answer.status, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/claude`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

let home: string;

beforeEach(() => {
  received = [];
  respond = () => ({ status: 200, body: { accepted: true } });
  home = mkdtempSync(join(tmpdir(), 'gca-shell-bridge-'));
  mkdirSync(join(home, 'bin'));
  // Quoted, with a trailing comment on another line, as people write .env files.
  writeFileSync(join(home, '.env'), `# bridge\nGCA_BRIDGE_TOKEN="${TOKEN}"\nGCA_PORT=1\n`);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeUsageCache(fetchedAtMs: number, fiveHourUsed = 13): void {
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'not-forwarded@example.com' },
      cachedUsageUtilization: {
        fetchedAtMs,
        utilization: {
          five_hour: { utilization: fiveHourUsed, resets_at: '2099-10-06T12:09:59.732324+00:00' },
          seven_day: { utilization: 2, resets_at: '2099-10-13T08:59:59.732350+00:00' },
          amber_gauge: { utilization: 99, resets_at: '2099-10-13T08:59:59+00:00' },
        },
      },
    }),
  );
}

/** A stand-in `claude` that records it ran and refreshes the cache as the real one does. */
function installFakeClaude(): string {
  const marker = join(home, 'claude-ran');
  const path = join(home, 'bin', 'claude');
  writeFileSync(
    path,
    `#!/bin/sh\ntouch '${marker}'\ncat > '${join(home, '.claude.json')}' <<'EOF'\n` +
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: Date.now(),
          utilization: { five_hour: { utilization: 40, resets_at: '2099-01-01T00:00:00Z' } },
        },
      }) +
      '\nEOF\n',
  );
  chmodSync(path, 0o755);
  return marker;
}

function run(
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      '/bin/sh',
      [SCRIPT, ...args],
      {
        env: {
          HOME: home,
          PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
          GCA_ENV_FILE: join(home, '.env'),
          GCA_BRIDGE_ENDPOINT: `${base}/statusline`,
          GCA_BRIDGE_STATE_DIR: join(home, 'state'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          ...options.env,
        },
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? '');
  });
}

function available(tool: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const jsonTools = ['jq', 'plutil', 'python3'].filter(available);

describe('claude-bridge.sh push', () => {
  it.each(jsonTools)('posts the cached windows in status-line shape using %s', async (tool) => {
    writeUsageCache(Date.now());

    const result = await run(['push'], { env: { GCA_JSON_TOOL: tool } });

    expect(result.stdout.trim()).toBe('Pushed usage (5h, 7d).');
    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${TOKEN}`);

    // Only the two windows leave the machine: no account details, no internal codenames.
    expect(received[0]?.body).not.toContain('example.com');
    expect(received[0]?.body).not.toContain('amber_gauge');
    const parsed = sanitizeStatuslinePayload(JSON.parse(received[0]?.body ?? ''), {
      now: new Date('2026-10-06T00:00:00Z'),
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.payload?.fiveHour?.usedPercentage).toBe(13);
    expect(parsed.payload?.sevenDay?.usedPercentage).toBe(2);
  });

  it('leaves a fresh cache alone instead of spawning claude', async () => {
    writeUsageCache(Date.now());
    const marker = installFakeClaude();

    await run(['push']);

    expect(() => readFileSync(marker)).toThrow();
  });

  it('asks claude to refresh a stale cache before reading it', async () => {
    writeUsageCache(Date.now() - 60 * 60 * 1000);
    const marker = installFakeClaude();

    const result = await run(['push']);

    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('Pushed usage (5h).');
    expect(received[0]?.body).toContain('"used_percentage":40');
  });

  it('prefers GCA_BRIDGE_TOKEN from the environment over .env', async () => {
    writeUsageCache(Date.now());

    await run(['push'], { env: { GCA_BRIDGE_TOKEN: 'from-the-environment' } });

    expect(received[0]?.authorization).toBe('Bearer from-the-environment');
  });

  it('fails with a pointer to doctor when the server rejects the token', async () => {
    writeUsageCache(Date.now());
    respond = () => ({ status: 401, body: { error: { message: 'Invalid bridge token.' } } });

    const result = await run(['push']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tools/claude-bridge.sh doctor');
  });

  it('refuses to run without a token rather than posting an empty one', async () => {
    writeFileSync(join(home, '.env'), 'GCA_PORT=3210\n');
    writeUsageCache(Date.now());

    const result = await run(['push']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('GCA_BRIDGE_TOKEN');
    expect(received).toHaveLength(0);
  });
});

describe('claude-bridge.sh statusline', () => {
  it('forwards the render verbatim and prints nothing', async () => {
    const render = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } });

    const result = await run(['statusline'], { input: render });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received[0]?.body).toBe(render);
    expect(received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never disrupts Claude Code when the server is down', async () => {
    const result = await run(['statusline'], {
      input: '{}',
      env: { GCA_BRIDGE_ENDPOINT: 'http://127.0.0.1:1/internal/claude/statusline' },
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe.runIf(available('jq'))('claude-bridge.sh install and uninstall', () => {
  const settingsPath = () => join(home, '.claude', 'settings.json');
  const original = {
    model: 'opus',
    statusLine: { type: 'command', command: 'echo previous-line', padding: 1 },
  };

  beforeEach(() => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));
  });

  it('hooks the status line, keeps other settings, and still shows the previous line', async () => {
    const install = await run(['install']);
    expect(install.code).toBe(0);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as typeof original;
    expect(settings.model).toBe('opus');
    expect(settings.statusLine.command).toBe(`/bin/sh '${SCRIPT}' statusline`);
    expect(settings.statusLine.padding).toBe(1);

    const render = await run(['statusline'], { input: '{}' });
    expect(render.stdout.trim()).toBe('previous-line');
    expect(received).toHaveLength(1);
  });

  it('is idempotent and restores the original status line on uninstall', async () => {
    await run(['install']);
    await run(['install']);

    const uninstall = await run(['uninstall']);
    expect(uninstall.code).toBe(0);

    const settings: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(settings).toEqual(original);
  });

  it('removes the key entirely when there was no status line before', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }));

    await run(['install']);
    await run(['uninstall']);

    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ model: 'opus' });
  });

  it('refuses to stack on top of the Node bridge', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'node /x/claude-statusline-bridge/dist/cli.js run',
        },
      }),
    );

    const result = await run(['install']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pnpm bridge:uninstall');
  });
});

describe('claude-bridge.sh doctor', () => {
  it('says to recreate the container when the token does not match', async () => {
    respond = () => ({ status: 401, body: { error: { message: 'Invalid bridge token.' } } });

    const result = await run(['doctor']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('docker compose up -d');
    expect(result.stdout).not.toContain(TOKEN);
  });

  it('reports when the last payload arrived', async () => {
    respond = () => ({ status: 200, body: { lastReceivedAt: '2026-10-06T11:16:54.521Z' } });

    const result = await run(['doctor']);

    expect(result.stdout).toContain('Last payload received at 2026-10-06T11:16:54.521Z.');
    expect(received[0]?.url).toBe('/internal/claude/status');
  });
});
