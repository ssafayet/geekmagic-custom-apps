import { createAppContext, startBackground } from './context.js';
import { buildServer } from './server.js';
import { loadConfig, createLogger, isLoopbackBind } from '@gca/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const ctx = await createAppContext({ config, logger });
  const app = await buildServer(ctx);

  if (config.authRequired && !app.auth.configured && app.auth.setupToken) {
    // Choosing the first password needs this code, so nobody else on the network can
    // claim a fresh server first. The log is where the operator already looks.
    logger.warn(
      { setupCode: app.auth.setupToken, file: app.auth.setupTokenPath },
      `No administrator password is set yet. Open the web UI and enter setup code ${app.auth.setupToken} to choose one.`,
    );
  }
  if (config.isExposed && !config.authRequired) {
    logger.error(
      { host: config.host },
      'GCA_AUTH_REQUIRED=false while bound beyond loopback: anyone who can reach this port controls the app. ' +
        'Only do this when the port is published on 127.0.0.1 (for example `-p 127.0.0.1:3210:3210`).',
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
