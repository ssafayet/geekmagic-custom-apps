import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Matches the ingestion endpoint's cap; oversized input is rejected, not truncated. */
export const MAX_INPUT_BYTES = 64 * 1024;
const POST_TIMEOUT_MS = 1_500;
const CHAIN_TIMEOUT_MS = 3_000;

export interface BridgeConfig {
  version: number;
  endpoint: string;
  tokenFile: string;
  chainedCommand: string | null;
}

export interface BridgeRunResult {
  /** What Claude Code should print as the status line. */
  stdout: string;
  exitCode: number;
  posted: boolean;
  /** Never printed to the conversation; surfaced only for tests and debugging. */
  diagnostics: string[];
}

export interface BridgeDeps {
  post: (endpoint: string, token: string, body: string) => Promise<void>;
  runChained: (command: string, input: string) => Promise<{ stdout: string; exitCode: number }>;
  readToken: (path: string) => string;
}

/**
 * Forwards a Claude Code status-line payload to the local service.
 *
 * The overriding rule is that this must never disrupt Claude Code. Every failure path
 * is swallowed: a down server, a missing token, a slow chained command — all of them
 * still produce a status line and exit 0. Nothing is ever printed to stderr or stdout
 * that could leak the token, the payload or a server error into the conversation.
 */
export async function runBridge(
  rawInput: string,
  config: BridgeConfig,
  deps: BridgeDeps = defaultDeps(),
): Promise<BridgeRunResult> {
  const diagnostics: string[] = [];
  let posted = false;

  if (Buffer.byteLength(rawInput, 'utf8') > MAX_INPUT_BYTES) {
    diagnostics.push('input-too-large');
  } else {
    try {
      const token = deps.readToken(config.tokenFile);
      if (!token) {
        diagnostics.push('missing-token');
      } else {
        // Forward the payload verbatim: the server performs sanitization, so the
        // bridge has no schema of its own to drift out of date.
        await deps.post(config.endpoint, token, rawInput);
        posted = true;
      }
    } catch (error) {
      diagnostics.push(`post-failed:${errorName(error)}`);
    }
  }

  // Preserve whatever status line the user had before the bridge was installed.
  if (config.chainedCommand) {
    try {
      const chained = await deps.runChained(config.chainedCommand, rawInput);
      return { stdout: chained.stdout, exitCode: chained.exitCode, posted, diagnostics };
    } catch (error) {
      diagnostics.push(`chain-failed:${errorName(error)}`);
      return { stdout: '', exitCode: 0, posted, diagnostics };
    }
  }

  return { stdout: '', exitCode: 0, posted, diagnostics };
}

export function defaultDeps(): BridgeDeps {
  return {
    readToken(path: string): string {
      try {
        return readFileSync(path, 'utf8').trim();
      } catch {
        return '';
      }
    },

    async post(endpoint: string, token: string, body: string): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },

    async runChained(
      command: string,
      input: string,
    ): Promise<{ stdout: string; exitCode: number }> {
      return new Promise((resolve) => {
        // The chained command is whatever the user already had configured, which is a
        // shell string by Claude Code's own contract, so it runs through the shell.
        const child = execFile(
          command,
          {
            shell: true,
            timeout: CHAIN_TIMEOUT_MS,
            maxBuffer: 256 * 1024,
            windowsHide: true,
          },
          (error, stdout) => {
            const code =
              typeof (error as { code?: unknown } | null)?.code === 'number'
                ? (error as { code: number }).code
                : 0;
            resolve({ stdout: String(stdout ?? ''), exitCode: error ? code : 0 });
          },
        );
        child.stdin?.end(input);
      });
    },
  };
}

export function readConfig(path: string): BridgeConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return {
    version: typeof parsed['version'] === 'number' ? parsed['version'] : 1,
    endpoint: String(parsed['endpoint'] ?? ''),
    tokenFile: String(parsed['tokenFile'] ?? ''),
    chainedCommand: typeof parsed['chainedCommand'] === 'string' ? parsed['chainedCommand'] : null,
  };
}

export async function readStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = MAX_INPUT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) {
      // Keep reading is pointless; stop at the cap and let the caller reject.
      chunks.push(buffer);
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return 'Unknown';
}
