#!/usr/bin/env node
/**
 * Host-side Claude Code status-line bridge.
 *
 *   gca-claude-bridge run --config <manifest.json>   forward one payload (called by Claude Code)
 *   gca-claude-bridge install                        add the bridge to ~/.claude/settings.json
 *   gca-claude-bridge uninstall                      restore the previous status line
 *   gca-claude-bridge status                         show install state
 *
 * `install` is available without the web UI so headless and Docker deployments can set
 * the bridge up on the host, where Claude Code actually runs.
 */
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultDataDir, LocalClaudeSettingsService, type BridgeManifest } from '@gca/core';
import { readConfig, readStdin, runBridge } from './bridge.js';

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

async function installCommand(flags: Map<string, string>): Promise<number> {
  const service = createService(flags);
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
  process.stdout.write('Usage appears on the display after Claude Code makes its next request.\n');
  return 0;
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

/** The absolute invocation Claude Code will run, resolved from this file's location. */
function bridgeCommand(): string {
  const here = fileURLToPath(import.meta.url);
  const isSource = here.endsWith('.ts');
  return isSource
    ? `${process.execPath} --import tsx ${here}`
    : `${process.execPath} ${join(dirname(here), 'cli.js')}`;
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
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
      '',
      'Flags:',
      '  --data-dir <path>       Application data directory',
      '  --settings <path>       Override the Claude settings file',
      '  --port <number>         Server port (default 3210)',
      '  --endpoint <url>        Full ingestion URL, overriding --port',
      '',
    ].join('\n'),
  );
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
