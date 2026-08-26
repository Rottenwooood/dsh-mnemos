/**
 * dsh-mnemos plugin entrypoint.
 *
 * Opens the SQLite store, constructs the MemoryService (the single,
 * approval-gated write path), registers the model-facing tools, the /memory
 * command and the session-signal hooks, and provides `ctx.mnemos` for the open
 * memory bus. All registrations are effects: they unwind when the plugin
 * unloads, and the store is closed by a disposal effect.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Config, defaultConfig } from './config.js';
import { openMemoryStore } from './domain/store.js';
import { createSensitiveDetector } from './domain/sensitive.js';
import { createMemoryService, DEFAULT_GATE, GateConfig } from './domain/service.js';
import { registerTools } from './dsh/tools.js';
import { registerCommand } from './dsh/command.js';
import { registerHooks, SignalCollector } from './dsh/hooks.js';

export const name = 'dsh-mnemos';

export function gateFrom(config: Config): GateConfig {
  return {
    maxEntries: config.maxEntries,
    maxBytesPerEntry: config.maxBytesPerEntry,
    autoApprove: config.autoApprove,
    autoApproveConfidence: config.autoApproveConfidence,
    allowModelGlobalWrite: config.allowModelGlobalWrite,
    blacklist: config.blacklist,
  };
}

export function apply(ctx: Context, raw: Partial<Config> = {}): void {
  const config: Config = { ...defaultConfig(), ...raw };
  const logger = ctx.logger('mnemos');

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = openMemoryStore(config.dbPath);
  const service = createMemoryService(store, createSensitiveDetector(), gateFrom(config));

  ctx.effect(() => () => {
    store.close();
  });
  ctx.effect(() => ctx.provide('mnemos', service));

  registerTools(ctx, service);
  registerCommand(ctx, service);
  registerHooks(ctx, new SignalCollector((message) => logger.debug(message)));

  logger.info(`dsh-mnemos ready at ${config.dbPath}`);
}
