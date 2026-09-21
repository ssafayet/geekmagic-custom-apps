import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createStore, type Store } from '@gca/database';
import { loadOrCreateMasterKey, SecretVault } from '@gca/secrets';
import { FrameRenderer } from '@gca/renderer';
import {
  BridgeInbox,
  builtInModules,
  createLogger,
  DeviceManager,
  EventBus,
  LocalClaudeCliService,
  LocalClaudeSettingsService,
  ModuleRegistry,
  ModuleRuntimeManager,
  Scheduler,
  SettingsValidator,
  CORE_SETTINGS_KEY,
  DEFAULT_CORE_SETTINGS,
  type AppConfig,
  type AppLogger,
  type CoreSettings,
} from '@gca/core';
import type { AddressPolicy } from '@gca/device-core';

export interface AppContext {
  config: AppConfig;
  logger: AppLogger;
  store: Store;
  events: EventBus;
  registry: ModuleRegistry;
  validator: SettingsValidator;
  runtimes: ModuleRuntimeManager;
  devices: DeviceManager;
  scheduler: Scheduler;
  renderer: FrameRenderer;
  bridgeInbox: BridgeInbox;
  claudeCli: LocalClaudeCliService;
  claudeSettings: LocalClaudeSettingsService;
  startedAt: string;
  coreSettings: () => CoreSettings;
  setCoreSettings: (patch: Partial<CoreSettings>) => CoreSettings;
  shutdown: () => Promise<void>;
}

export interface CreateContextOptions {
  config: AppConfig;
  /** Overrides for tests: in-memory database, fake clock, relaxed address policy. */
  databaseFile?: string;
  addressPolicy?: AddressPolicy;
  logger?: AppLogger;
}

/**
 * Composition root.
 *
 * Wiring lives in exactly one place so the dependency direction stays visible:
 * routes depend on services, services depend on core, and core depends on the
 * database, renderer and device layers. Nothing points back up.
 */
export async function createAppContext(options: CreateContextOptions): Promise<AppContext> {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  mkdirSync(config.dataDir, { recursive: true });

  const masterKey = loadOrCreateMasterKey({
    dataDir: config.dataDir,
    keyFileOverride: config.masterKeyFile,
  });
  if (masterKey.origin === 'generated') {
    logger.info({ path: masterKey.path }, 'Generated a new secret master key');
  }

  const vault = new SecretVault(masterKey.key);
  const databaseFile = options.databaseFile ?? join(config.dataDir, 'app.db');
  const store = createStore({ file: databaseFile }, vault);

  if (store.migration && store.migration.applied.length > 0) {
    logger.info(
      { from: store.migration.from, to: store.migration.to, backup: store.migrationBackupPath },
      'Applied database migrations',
    );
  }

  const events = new EventBus();
  const registry = new ModuleRegistry(builtInModules, logger);
  if (registry.report.rejected.length > 0) {
    logger.error(
      { rejected: registry.report.rejected },
      'Some modules failed validation and were not loaded',
    );
  }

  const bridgeInbox = new BridgeInbox(events);
  const claudeCli = new LocalClaudeCliService();
  const claudeSettings = new LocalClaudeSettingsService({
    dataDir: config.dataDir,
    bridgeCommand: resolveBridgeCommand(),
    endpoint: `http://127.0.0.1:${config.port}/internal/claude/statusline`,
  });
  // An explicit token lets a containerised server and a host-side bridge agree on a
  // secret without sharing a data directory.
  bridgeInbox.setToken(config.bridgeToken ?? claudeSettings.readOrCreateToken());
  if (config.bridgeToken) {
    logger.info('Bridge ingestion token taken from GCA_BRIDGE_TOKEN');
  }
  if (config.bridgeAllowPrivateSources) {
    logger.warn(
      'Bridge ingestion accepts any private source address. Publish the port on 127.0.0.1 only.',
    );
  }

  const settings = readCoreSettings(store);

  const runtimes = new ModuleRuntimeManager({
    store,
    registry,
    events,
    logger,
    host: { claudeCli, claudeSettings, bridgeInbox },
    timezone: settings.displayTimezone,
  });

  const devices = new DeviceManager({
    store,
    events,
    logger,
    dataDir: config.dataDir,
    ...(options.addressPolicy ? { addressPolicy: options.addressPolicy } : {}),
  });

  const renderer = new FrameRenderer({ themeId: settings.theme, quality: settings.jpegQuality });
  const scheduler = new Scheduler({
    store,
    runtimes,
    devices,
    events,
    logger,
    renderer,
    themeId: settings.theme,
    jpegQuality: settings.jpegQuality,
  });

  // A bridge payload is data arriving out of band, so refresh the Claude module
  // immediately rather than waiting for its next scheduled tick.
  events.on('bridge.payload', () => {
    for (const instance of runtimes.list()) {
      if (instance.record.moduleId !== 'claude-usage') continue;
      runtimes.invalidateFrames(instance);
      void runtimes.refresh(instance.record.id, 'event').catch(() => undefined);
    }
  });

  let currentSettings = settings;

  const context: AppContext = {
    config,
    logger,
    store,
    events,
    registry,
    validator: new SettingsValidator(),
    runtimes,
    devices,
    scheduler,
    renderer,
    bridgeInbox,
    claudeCli,
    claudeSettings,
    startedAt: new Date().toISOString(),

    coreSettings: () => currentSettings,

    setCoreSettings(patch: Partial<CoreSettings>): CoreSettings {
      currentSettings = { ...currentSettings, ...patch };
      store.appSettings.set(CORE_SETTINGS_KEY, currentSettings);
      runtimes.setTimezone(currentSettings.displayTimezone);
      scheduler.setRenderOptions({
        themeId: currentSettings.theme,
        jpegQuality: currentSettings.jpegQuality,
      });
      return currentSettings;
    },

    async shutdown(): Promise<void> {
      scheduler.stop();
      await runtimes.stopAll();
      await devices.stopAll();
      events.removeAll();
      store.close();
    },
  };

  return context;
}

/** Starts background work after the HTTP server is listening. */
export async function startBackground(context: AppContext): Promise<void> {
  await context.devices.startAll();
  await context.runtimes.startAll();
  context.scheduler.rebuildJobs();
  context.scheduler.rebuildSchedules();
  context.scheduler.start();
  context.store.snapshots.purgeExpired();
  context.store.audit.prune();
}

function readCoreSettings(store: Store): CoreSettings {
  const stored = store.appSettings.get<Partial<CoreSettings>>(CORE_SETTINGS_KEY) ?? {};
  const merged = { ...DEFAULT_CORE_SETTINGS, ...stored };
  store.appSettings.set(CORE_SETTINGS_KEY, merged);
  return merged;
}

/**
 * Absolute command Claude Code will invoke for the bridge.
 *
 * Resolved from this file's own location so it is correct whether the server is
 * running from `src` under tsx or from a built `dist`.
 */
function resolveBridgeCommand(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.includes(`${'src'}`)) {
    const source = resolve(
      here,
      '..',
      '..',
      '..',
      'tools',
      'claude-statusline-bridge',
      'src',
      'cli.ts',
    );
    return `${process.execPath} --import tsx ${source}`;
  }
  const built = resolve(
    here,
    '..',
    '..',
    '..',
    'tools',
    'claude-statusline-bridge',
    'dist',
    'cli.js',
  );
  return `${process.execPath} ${built}`;
}
