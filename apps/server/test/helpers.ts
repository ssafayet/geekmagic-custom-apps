import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLogger, loadConfig, type AppConfig } from '@gca/core';
import { createAppContext, startBackground, type AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  dataDir: string;
  close: () => Promise<void>;
}

/**
 * Boots the full server against a temporary data directory and an in-memory database.
 *
 * The address policy allows loopback so tests can point devices at the simulator.
 */
export async function createTestApp(
  options: { background?: boolean; configOverrides?: Partial<AppConfig> } = {},
): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gca-server-'));
  const config: AppConfig = {
    ...loadConfig({}),
    dataDir,
    host: '127.0.0.1',
    port: 0,
    isExposed: false,
    logLevel: 'silent',
    ...options.configOverrides,
  };

  const ctx = await createAppContext({
    config,
    databaseFile: join(dataDir, 'test.db'),
    logger: createLogger({ level: 'silent', pretty: false }),
    addressPolicy: { allowlist: [], allowLoopback: true, allowPublic: false },
  });

  const app = await buildServer(ctx);
  await app.ready();
  if (options.background) await startBackground(ctx);

  return {
    app,
    ctx,
    dataDir,
    close: async () => {
      await app.close();
      await ctx.shutdown();
    },
  };
}

export function jsonBody<T = Record<string, unknown>>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
