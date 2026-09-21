import { createAppContext, startBackground } from './context.js';
import { buildServer } from './server.js';
import { loadConfig, createLogger, isLoopbackBind } from '@gca/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const ctx = await createAppContext({ config, logger });
  const app = await buildServer(ctx);

  if (config.authRequired && !app.auth.configured) {
    // Every browser API call will answer 401 until a password exists, and there is
    // no way to set one from a locked-out UI. Say exactly how to get out of it.
    logger.error(
      { host: config.host },
      'Authentication is required but no administrator password is set, so the web UI will be refused. ' +
        'Set one with: curl -X POST http://127.0.0.1:PORT/api/v1/auth/password -H "content-type: application/json" -d \'{"password":"..."}\' ' +
        '— or bind GCA_HOST=127.0.0.1, or set GCA_AUTH_REQUIRED=false when the port is published on loopback only.',
    );
  }
  if (config.isExposed && !config.authRequired) {
    logger.warn(
      { host: config.host },
      'GCA_AUTH_REQUIRED=false while bound beyond loopback. Only do this when something else limits who can connect.',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    await app.close().catch(() => undefined);
    await ctx.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  await startBackground(ctx);

  const url =
    config.publicBaseUrl ??
    `http://${isLoopbackBind(config.host) ? 'localhost' : config.host}:${config.port}`;
  logger.info(
    { url, dataDir: config.dataDir, modules: ctx.registry.report.loaded },
    'geekmagic-custom-apps is ready',
  );
}

main().catch((error) => {
  process.stderr.write(
    `Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
