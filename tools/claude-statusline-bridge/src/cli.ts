#!/usr/bin/env node
/**
 * Host-side Claude Code status-line bridge.
 *
 *   gca-claude-bridge run --config <manifest.json>   forward one payload (called by Claude Code)
 *   gca-claude-bridge install                        add the bridge to ~/.claude/settings.json
 *   gca-claude-bridge uninstall                      restore the previous status line
 *   gca-claude-bridge status                         show install state
 *   gca-claude-bridge push                           read local usage and post it now
 *
 * `install` is available without the web UI so headless and Docker deployments can set
 * the bridge up on the host, where Claude Code actually runs.
 */
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultDataDir, LocalClaudeSettingsService, type BridgeManifest } from '@gca/core';
import { readConfig, readStdin, runBridge } from './bridge.js';
import { describePush, pushUsage } from './push.js';

const DEFAULT_PORT = 3210;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'status';
  const flags = parseFlags(argv.slice(1));

  switch (command) {
    case 'run':
      return runCommand(flags);
    case 'install':
      return installCommand(flags);
    case 'uninstall':
      return uninstallCommand(flags);
    case 'status':
      return statusCommand(flags);
    case 'doctor':
      return doctorCommand(flags);
    case 'push':
      return pushCommand(flags);
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n`);
      printHelp();
      return 2;
  }
}

async function runCommand(flags: Map<string, string>): Promise<number> {
  const configPath = flags.get('config');
  const input = await readStdin(process.stdin);

  if (!configPath) {
    // No config means nothing to forward. Still exit cleanly: a broken bridge must
    // never be the reason a Claude Code session shows an error.
    return 0;
  }

  try {
    const config = readConfig(configPath);
    const result = await runBridge(input, config);
    if (result.stdout) process.stdout.write(result.stdout);
    return result.exitCode;
  } catch {
    // Deliberately silent. Anything written here would appear in the conversation.
    return 0;
  }
}

/** Default gap between pushes. The reading itself is cached; see `readUsage`. */
const DEFAULT_PUSH_INTERVAL_SECONDS = 60;

/**
 * Reads usage from the local Claude Code and posts it to the server.
 *
 * This exists because the status line is not the only way to run Claude Code, and a
 * containerised server cannot read the local CLI for itself. One-shot by default, so
 * it suits cron or a launchd timer; `--watch` keeps it resident instead.
 */
async function pushCommand(flags: Map<string, string>): Promise<number> {
  // Same as install: a containerised server holds a token this side cannot derive.
  const supplied = suppliedToken(flags);
  if (supplied && !flags.has('token-file')) {
    createService(flags).writeToken(supplied);
  }
  const config = {
    version: 1,
    endpoint: endpointFor(flags),
    tokenFile: flags.get('token-file') ?? createService(flags).tokenPath,
    chainedCommand: null,
  };

  const once = async (): Promise<number> => {
    const result = await pushUsage(config);
    process.stdout.write(`${describePush(result)}\n`);
    return result.posted && result.accepted !== false ? 0 : 1;
  };

  if (!flags.has('watch')) return once();

  const seconds = Number(flags.get('interval') ?? DEFAULT_PUSH_INTERVAL_SECONDS);
  const intervalMs =
    (Number.isFinite(seconds) && seconds >= 10 ? seconds : DEFAULT_PUSH_INTERVAL_SECONDS) * 1000;
  process.stdout.write(`Pushing usage to ${config.endpoint} every ${intervalMs / 1000}s.\n`);

  let stopping = false;
  let wake: (() => void) | null = null;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      wake?.();
    });
  }

  // A failure must not end the loop: the server may simply be restarting.
  while (!stopping) {
    await once().catch(() => 1);
    if (stopping) break;
    // A referenced timer, deliberately: it is the only thing holding the event loop
    // open between pushes. Unreferencing it lets Node exit mid-wait, which under a
    // KeepAlive supervisor looks like it is working while actually crash-looping.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, intervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }
  return 0;
}

async function installCommand(flags: Map<string, string>): Promise<number> {
  if (!existsSync(bridgeEntryPath())) {
    process.stderr.write(
      `The bridge is not built yet (${bridgeEntryPath()} is missing). Run \`pnpm build\` first.\n`,
    );
    return 1;
  }
  const service = createService(flags);

  // A server that was handed GCA_BRIDGE_TOKEN has a token this side cannot derive,
  // so accept it explicitly. Without this a containerised server and a host bridge
  // generate different secrets and every post is rejected.
  const supplied = suppliedToken(flags);
  if (supplied) service.writeToken(supplied);

  const state = await service.install();
  const token = service.readOrCreateToken();

  // The manifest doubles as the bridge's runtime config, so write the fields
  // `run` needs alongside the install bookkeeping.
  writeRunnableManifest(service, flags);

  process.stdout.write(`Bridge installed in ${state.settingsPath}\n`);
  if (state.backupPath) process.stdout.write(`Backup written to ${state.backupPath}\n`);
  if (state.chainedCommand) {
    process.stdout.write(`Existing status line preserved and chained: ${state.chainedCommand}\n`);
  }
  process.stdout.write(`Token file: ${service.tokenPath} (${token.length} chars, mode 0600)\n`);

  // Installing successfully says nothing about whether the server will accept what
  // this posts, and `run` can never tell anyone: it swallows every error. Probe now,
  // while the person is still looking, rather than leaving them with a status line
  // that silently 401s forever.
  process.stdout.write('\nChecking the server accepts this token...\n');
  const probe = await probeServer(endpointFor(flags), token);
  process.stdout.write(`${probe.lines.join('\n')}\n`);
  return probe.ok ? 0 : 1;
}

async function uninstallCommand(flags: Map<string, string>): Promise<number> {
  const service = createService(flags);
  const state = await service.uninstall();
  if (state.conflict) {
    process.stderr.write(`${state.conflict}\n`);
    return 1;
  }
  process.stdout.write('Bridge removed and the previous status line restored.\n');
  return 0;
}

async function statusCommand(flags: Map<string, string>): Promise<number> {
  const service = createService(flags);
  const state = await service.inspect();
  process.stdout.write(
    JSON.stringify(
      {
        installed: state.installed,
        settingsPath: state.settingsPath,
        chainedCommand: state.chainedCommand,
        installedAt: state.installedAt,
        conflict: state.conflict,
      },
      null,
      2,
    ) + '\n',
  );
  return state.installed ? 0 : 1;
}

/**
 * Explains why usage is not arriving.
 *
 * `run` cannot report anything: it swallows every failure so a broken bridge never
 * disrupts a Claude Code session. That is the right trade for the hot path and the
 * wrong one for a person trying to find out what is wrong, so the diagnosis lives
 * here instead.
 */
async function doctorCommand(flags: Map<string, string>): Promise<number> {
  const service = createService(flags);
  const state = await service.inspect();
  const endpoint = endpointFor(flags);

  const lines: string[] = [];
  let failed = false;

  lines.push(
    state.installed
      ? `Installed in ${state.settingsPath}`
      : `NOT installed in ${state.settingsPath} — run \`pnpm bridge:install\``,
  );
  if (!state.installed) failed = true;
  if (state.conflict) lines.push(`Conflict: ${state.conflict}`);

  let token = '';
  try {
    token = service.readOrCreateToken();
  } catch {
    lines.push(`Could not read the token file at ${service.tokenPath}`);
    failed = true;
  }

  if (token) {
    const probe = await probeServer(endpoint, token, service.tokenPath);
    lines.push(...probe.lines);
    if (!probe.ok) failed = true;
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return failed ? 1 : 0;
}

/**
 * Asks the server whether it would accept what this bridge posts.
 *
 * Uses the read-only status route rather than posting a synthetic payload, so a
 * check never overwrites a real reading with a probe.
 */
async function probeServer(
  endpoint: string,
  token: string,
  tokenPath?: string,
): Promise<{ ok: boolean; lines: string[] }> {
  const statusUrl = endpoint.replace(/\/statusline$/, '/status');
  const lines: string[] = [];

  let response: Response;
  try {
    response = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
  } catch (error) {
    lines.push(`Cannot reach ${statusUrl} (${errorName(error)}).`);
    lines.push('  Is the server running, and does --endpoint name the right port?');
    return { ok: false, lines };
  }

  const body = await response.text().catch(() => '');

  if (response.status === 200) {
    const received = safeParse(body)?.['lastReceivedAt'];
    lines.push('OK: the server is reachable and accepts this token.');
    lines.push(
      typeof received === 'string'
        ? `  Last payload received at ${received}.`
        : "  No payload has arrived yet; one follows Claude Code's next render.",
    );
    return { ok: true, lines };
  }

  if (response.status === 401 && body.includes('Invalid bridge token')) {
    lines.push('FAILED: the server rejects this token, so no usage will ever arrive.');
    if (tokenPath) lines.push(`  This side reads ${tokenPath}`);
    lines.push('  The server was started with a different one. Put it in .env as');
    lines.push('  GCA_BRIDGE_TOKEN and re-run install, which reads .env itself:');
    lines.push('    pnpm bridge:install');
    lines.push('  In Docker, the container reads .env only when it is created. Recreate it:');
    lines.push('    docker compose up -d');
    return { ok: false, lines };
  }

  if (response.status === 401) {
    lines.push('FAILED: the server refuses this source address.');
    lines.push('  A published container port arrives through NAT rather than loopback.');
    lines.push('  Set GCA_BRIDGE_ALLOW_PRIVATE_SOURCES=true on the server (compose.yaml does).');
    return { ok: false, lines };
  }

  if (response.status === 404) {
    lines.push(`FAILED: ${statusUrl} returned 404.`);
    lines.push('  The server predates the doctor check; rebuild it.');
    return { ok: false, lines };
  }

  lines.push(`FAILED: unexpected ${response.status} from ${statusUrl}: ${body.slice(0, 200)}`);
  return { ok: false, lines };
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'Error';
}

function createService(flags: Map<string, string>): LocalClaudeSettingsService {
  const dataDir = flags.get('data-dir') ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });

  return new LocalClaudeSettingsService({
    dataDir,
    bridgeCommand: bridgeCommand(),
    endpoint: endpointFor(flags),
    ...(flags.get('settings') ? { settingsPath: resolve(flags.get('settings') as string) } : {}),
  });
}

function writeRunnableManifest(
  service: LocalClaudeSettingsService,
  flags: Map<string, string>,
): void {
  const manifest = service.readManifest();
  if (!manifest) return;
  const runnable: BridgeManifest = {
    ...manifest,
    endpoint: endpointFor(flags),
    tokenFile: service.tokenPath,
  };
  mkdirSync(dirname(service.manifestPath), { recursive: true });
  writeFileSync(service.manifestPath, `${JSON.stringify(runnable, null, 2)}\n`, { mode: 0o600 });
}

function endpointFor(flags: Map<string, string>): string {
  const explicit = flags.get('endpoint');
  if (explicit) return explicit;
  const port = Number(flags.get('port') ?? process.env['GCA_PORT'] ?? DEFAULT_PORT);
  return `http://127.0.0.1:${Number.isInteger(port) ? port : DEFAULT_PORT}/internal/claude/statusline`;
}

/**
 * The built entry point Claude Code will run, resolved from this file's location.
 *
 * Always the compiled `dist/cli.js`, even when this CLI itself runs from source.
 * Claude Code invokes the status line from whatever project it has open, and a
 * `--import tsx` command resolves tsx from that directory — so a source command
 * works inside this repository and fails with ERR_MODULE_NOT_FOUND everywhere else.
 */
function bridgeEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith('src') ? resolve(here, '..', 'dist', 'cli.js') : join(here, 'cli.js');
}

function bridgeCommand(): string {
  const quote = (value: string) => (/\s/.test(value) ? JSON.stringify(value) : value);
  return `${quote(process.execPath)} ${quote(bridgeEntryPath())}`;
}

/**
 * The token given with `--token`, or else GCA_BRIDGE_TOKEN as loaded from `.env`.
 *
 * An empty flag falls through rather than winning: `--token "$GCA_BRIDGE_TOKEN"` typed
 * in a shell that never read `.env` arrives empty, and taking that literally would
 * ignore the token the script itself just loaded.
 */
function suppliedToken(flags: Map<string, string>): string | undefined {
  const flag = flags.get('token');
  if (flag && flag !== 'true') return flag;
  return process.env['GCA_BRIDGE_TOKEN'] || undefined;
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) continue;
    // Split on the first `=` only: base64 tokens end in `=`, and `split('=', 2)` would
    // silently drop everything after the second one.
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (!name) continue;
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, 'true');
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    [
      'gca-claude-bridge — Claude Code status-line bridge',
      '',
      'Commands:',
      '  run --config <path>     Forward one status-line payload (invoked by Claude Code)',
      '  install                 Install the bridge into ~/.claude/settings.json',
      '  uninstall               Restore the previous status line',
      '  status                  Print install state as JSON',
      '  doctor                  Explain why usage is not arriving (probes the server)',
      '  push [--watch]          Read usage from the local Claude Code and post it now.',
      '                          Use this when the status line never fires, or when the',
      '                          server runs in a container and cannot read the CLI.',
      '',
      'Flags:',
      '  --data-dir <path>       Application data directory',
      '  --settings <path>       Override the Claude settings file',
      '  --port <number>         Server port (default 3210)',
      '  --endpoint <url>        Full ingestion URL, overriding --port',
      '  --interval <seconds>    Gap between pushes with --watch (default 60, min 10)',
      '  --token-file <path>     Read the ingestion token from this file',
      '  --token <value>         Use this ingestion token (or set GCA_BRIDGE_TOKEN) for',
      '                          install and push. Required when the server runs in a',
      '                          container; it is saved to the token file for later runs.',
      '',
    ].join('\n'),
  );
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
