import { createAppContext, startBackground } from './context.js';
import { buildServer } from './server.js';
import { loadConfig, createLogger, isLoopbackBind } from '@gca/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const ctx = await createAppContext({ config, logger });
  const app = await buildServer(ctx);

  if (config.isExposed && !app.auth.configured) {
    // Refuse to expose an unauthenticated control panel to the network. The user can
    // still reach it on loopback to set a password.
    logger.error(
      { host: config.host },
      'GCA_HOST binds beyond loopback but no administrator password is set. Start on 127.0.0.1 first and set one in Settings.',
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
