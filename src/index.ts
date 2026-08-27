/**
 * dsh-mnemos plugin entrypoint.
 *
 * Opens the SQLite store, constructs the MemoryService (the single,
 * approval-gated write path), registers the model-facing tools, the /memory
 * command and the session-signal hooks, provides `ctx.mnemos` for the open
 * memory bus, and (optionally) registers the background session-log backfill
 * job. All registrations are effects: they unwind when the plugin unloads, and
 * the store is closed by a disposal effect.
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Config, defaultConfig } from './config.js';
import { openMemoryStore } from './domain/store.js';
import { createSensitiveDetector } from './domain/sensitive.js';
import { createMemoryService, DEFAULT_GATE, GateConfig, MemoryService } from './domain/service.js';
import { createBackfillService, createFileCheckpoint, createJsonFileStore } from './domain/backfill.js';
import { detectSource, parseAny } from './domain/imports/detect.js';
import { runDistillIncremental, DistillCursor } from './domain/distill.js';
import { createMemoryBus } from './domain/bus.js';
import { registerTools } from './dsh/tools.js';
import { registerCommand, CommandDeps } from './dsh/command.js';
import { registerHooks, registerInjection, registerRuleInjection, SignalCollector } from './dsh/hooks.js';
import { createLlmFromContext } from './dsh/llm-adapter.js';
import { Llm } from './domain/llm.js';

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

function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(name));
    if (statSync(path).isFile() && path.endsWith('.jsonl')) {
      out.push(path);
    }
  }
  return out;
}

export function registerBackfillJob(ctx: Context, service: MemoryService, config: Config): void {
  if (!config.backfillEnabled || config.sessionLogDirs.length === 0) {
    return;
  }
  const checkpointPath = join(dirname(config.dbPath), 'backfill-checkpoint.json');
  ctx.effect(() =>
    ctx.jobs.register({
      name: 'mnemos-backfill',
      run: async () => {
        const backfill = createBackfillService(service, {
          checkpoint: createFileCheckpoint(checkpointPath),
          caller: config.importCaller,
          scope: 'workspace',
          incremental: true,
        });
        for (const dir of config.sessionLogDirs) {
          if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
            continue;
          }
          const files = listJsonlFiles(dir).map((path) => ({
            path,
            text: readFileSync(path, 'utf8'),
          }));
          backfill.run(files);
        }
        backfill.saveCheckpoint();
        return {
          scannedFiles: backfill.stats.scannedFiles,
          candidates: backfill.stats.candidates,
          committed: backfill.stats.committed,
          proposed: backfill.stats.proposed,
          denied: backfill.stats.denied,
        };
      },
    }),
  );
}

export function registerScheduledDistill(
  ctx: Context,
  deps: { llm: Llm; service: MemoryService; config: Config; collector: SignalCollector },
): void {
  const { llm, service, config, collector } = deps;
  const logger = ctx.logger('mnemos');
  const cursorStore = createJsonFileStore<DistillCursor>(join(dirname(config.dbPath), 'distill-cursor.json'));
  let cursor = cursorStore.read();
  const run = async (): Promise<void> => {
    const messages = collector.drain();
    if (messages.length === 0) {
      return;
    }
    const result = await runDistillIncremental(llm, service, messages, cursor, {
      scope: 'workspace',
    });
    cursor = result.cursor;
    cursorStore.write(cursor);
    logger.info(
      `distill: ${result.stats.memories} memory, ${result.stats.rules} rule, ${result.stats.conflicts} conflict`,
    );
  };
  ctx.effect(() => {
    const id = setInterval(run, config.distillIntervalMinutes * 60_000);
    return () => clearInterval(id);
  });
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

  const bus = createMemoryBus(service, store, (event) => ctx.emit('mnemos/memory', event));
  ctx.effect(() => ctx.provide('mnemosBus', bus));

  const llm = createLlmFromContext(ctx);
  const collector = new SignalCollector((message) => logger.debug(message), config.distillWindow);
  const cursorStore = createJsonFileStore<DistillCursor>(join(dirname(config.dbPath), 'distill-cursor.json'));
  const commandDeps: CommandDeps = {
    service,
    config,
    llm,
    collector,
    bus,
    distillCursor: cursorStore.read(),
    persistCursor: (c) => cursorStore.write(c),
  };

  registerTools(ctx, service);
  registerCommand(ctx, commandDeps);
  registerHooks(ctx, collector);
  registerInjection(ctx, service, config);
  registerRuleInjection(ctx, service, config);
  registerBackfillJob(ctx, service, config);
  if (config.distillAuto && llm) {
    registerScheduledDistill(ctx, { llm, service, config, collector });
  }

  logger.info(`dsh-mnemos ready at ${config.dbPath}`);
}
