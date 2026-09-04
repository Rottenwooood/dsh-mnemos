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
import { createGitStore, GitStore } from './domain/gitstore.js';
import { createSystemGitBackend } from './domain/git/system-git.js';
import { createIsomorphicGitBackend } from './domain/git/isomorphic-git.js';
import { registerTools } from './dsh/tools.js';
import { registerCommand, CommandDeps } from './dsh/command.js';
import { registerHooks, registerInjection, registerProtocolInjection, SignalCollector } from './dsh/hooks.js';
import { createMnemosAbi } from './dsh/adapter.js';
import { registerMnemosSkillProvider } from './dsh/skill-provider.js';
import { createLlmFromContext } from './dsh/llm-adapter.js';
import { installMnemosSettings } from './dsh/settings.js';
import { registerMnemosRoutes } from './dsh/routes.js';
import { Llm } from './domain/llm.js';

export const name = 'dsh-mnemos';

/** Required harness services this plugin registers against. */
export const inject = ['tools', 'commands'];

export function gateFrom(config: Config): GateConfig {
  return {
    maxEntries: config.maxEntries,
    maxBytesPerEntry: config.maxBytesPerEntry,
    autoApprove: config.autoApprove,
    autoApproveConfidence: config.autoApproveConfidence,
    allowModelGlobalWrite: config.allowModelGlobalWrite,
    blacklist: config.blacklist,
    sensitivityCheckEnabled: config.sensitivityCheckEnabled,
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

export function registerBackfillJob(ctx: Context, collector: SignalCollector, getConfig: () => Config): void {
  const logger = ctx.logger('mnemos');
  let stopped = false;
  ctx.effect(() => {
    void (async () => {
      try {
        const config = getConfig();
        if (stopped || !config.enabled || !config.backfillEnabled || config.sessionLogDirs.length === 0) {
          return;
        }
        const checkpointPath = join(dirname(config.dbPath), 'backfill-checkpoint.json');
        const backfill = createBackfillService(collector, {
          checkpoint: createFileCheckpoint(checkpointPath),
          incremental: true,
        });
        for (const dir of config.sessionLogDirs) {
          if (stopped) return;
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
        logger.info(
          `backfill: scanned ${backfill.stats.scannedFiles} file(s), ` +
            `${backfill.stats.parsedMessages} messages ingested into the distill buffer`,
        );
      } catch (err) {
        logger.warn(`backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      stopped = true;
    };
  });
}

export function registerGitJobs(
  ctx: Context,
  gitStore: GitStore,
  getConfig: () => Config,
  logger: ReturnType<Context['logger']>,
): void {
  ctx.effect(() => {
    const id = setInterval(async () => {
      try {
        if (!getConfig().enabled) return;
        await gitStore.recordCommit('periodic snapshot');
      } catch (err) {
        logger.warn(`git snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, Math.max(getConfig().syncIntervalMinutes, 5) * 60_000);
    return () => clearInterval(id);
  });
  if (getConfig().syncEnabled) {
    ctx.effect(() => {
      const id = setInterval(async () => {
        try {
          if (!getConfig().enabled) return;
          const pull = await gitStore.pull();
          if (!pull.ok) {
            logger.warn(`sync pull conflicted on: ${pull.conflicts.join(', ')}`);
            return;
          }
          const push = await gitStore.push();
          if (!push.ok) {
            logger.warn('sync push failed');
          }
        } catch (err) {
          logger.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, getConfig().syncIntervalMinutes * 60_000);
      return () => clearInterval(id);
    });
  }
}

export function apply(ctx: Context, raw: Partial<Config> = {}): void {
  let config: Config = { ...defaultConfig(), ...raw };
  const getConfig = () => config;
  const logger = ctx.logger('mnemos');

  let gitStore: GitStore | undefined;
  let gitCommitTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleGitCommit = (): void => {
    if (gitStore === undefined) return;
    if (gitCommitTimer !== undefined) clearTimeout(gitCommitTimer);
    gitCommitTimer = setTimeout(() => {
      gitCommitTimer = undefined;
      void gitStore!.recordCommit('memory change').catch((err) =>
        logger.warn(`git auto-commit failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, 1000);
  };

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = openMemoryStore(config.dbPath);
  const service = createMemoryService(store, createSensitiveDetector(), gateFrom(config), scheduleGitCommit);

  ctx.effect(() => () => {
    store.close();
  });
  ctx.effect(() => ctx.provide('mnemos', service));

  const abi = createMnemosAbi(store, service, '1.0.0', config.dbPath);
  ctx.effect(() => ctx.provide('mnemosAbi', abi));

  const bus = createMemoryBus(service, store, (event) => ctx.emit('mnemos/memory', event));
  ctx.effect(() => ctx.provide('mnemosBus', bus));

  // The real DSH settings page: register the `mnemos` namespace and re-apply
  // the gate live on every resolved change. Structural paths (dbPath, git
  // repo) still need a restart, which the form labels state.
  installMnemosSettings(ctx, config, (next) => {
    const prev = config;
    config = next;
    service.updateGate(gateFrom(next));
    if (next.gitRemoteUrl.trim() && gitStore && next.gitRemoteUrl !== prev.gitRemoteUrl) {
      void gitStore.setRemote(next.gitRemoteUrl.trim()).catch((err) =>
        logger.warn(`git remote update failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    logger.info(`mnemos settings updated (gate re-applied, dbPath=${next.dbPath})`);
  });

  if (config.gitVersioning) {
    const backend = config.gitBackend === 'isomorphic'
      ? createIsomorphicGitBackend()
      : createSystemGitBackend();
    gitStore = createGitStore({
      backend,
      store,
      service,
      repoDir: config.memoryRepoDir,
      remote: config.gitRemoteName,
    });
    void gitStore.ensure().catch((err) => logger.warn(`git init failed: ${String(err)}`));
    ctx.effect(() => ctx.provide('mnemosGit', gitStore));
    registerGitJobs(ctx, gitStore, getConfig, logger);
  }

  registerMnemosSkillProvider(ctx, config.skillsDir, logger);

  const resolveLlmTarget = async (): Promise<{ provider: string; model: string } | undefined> => {
    const cfg = getConfig();
    let configuredProvider: string | undefined;
    let configuredModel: string | undefined;
    try {
      const settings = (ctx as unknown as { get(name: string): { get?(ns: string): unknown } | undefined }).get('settings');
      const adm = settings?.get?.('agent-default-model') as { provider?: string; model?: string } | undefined;
      configuredProvider = adm?.provider;
      configuredModel = adm?.model;
    } catch {
      // settings absent or section unavailable — fall through to configured fields
    }
    const provider = cfg.llmProvider.trim() || configuredProvider;
    const model = cfg.llmModel.trim() || configuredModel;
    if (!provider || !model) {
      return undefined;
    }
    return { provider, model };
  };
  const llm = createLlmFromContext(ctx, {
    resolveTarget: resolveLlmTarget,
    system:
      'You are dsh-mnemos, extracting durable cross-session memories from a conversation. Return only the requested JSON.',
  });
  const cursorStore = createJsonFileStore<DistillCursor>(join(dirname(config.dbPath), 'distill-cursor.json'));
  const distillCursor: { current: DistillCursor } = { current: cursorStore.read() };

  let runDistillNow: () => Promise<{ memories: number; conflicts: number } | null>;
  // Count-based auto-distill: every N live user messages, when distillAuto is on.
  const collector = new SignalCollector(
    (message) => logger.debug(message),
    config.distillWindow,
    (count) => {
      const cfg = getConfig();
      if (!cfg.enabled || !cfg.distillAuto || !llm) {
        return;
      }
      if (count % Math.max(1, cfg.distillEveryNTurns) !== 0) {
        return;
      }
      void runDistillNow().catch(() => {});
    },
  );
  runDistillNow = async (): Promise<{ memories: number; conflicts: number } | null> => {
    const cfg = getConfig();
    if (!cfg.enabled) {
      collector.drain();
        return { memories: 0, conflicts: 0 };
    }
    const messages = collector.drain();
    if (messages.length === 0) {
      return { memories: 0, conflicts: 0 };
    }
    if (!llm) {
      return null;
    }
    try {
      const result = await runDistillIncremental(llm, service, messages, distillCursor.current, {
        scope: cfg.defaultScope,
      });
      distillCursor.current = result.cursor;
      cursorStore.write(distillCursor.current);
      return {
        memories: result.stats.memories,
        conflicts: result.stats.conflicts,
      };
    } catch (err) {
      logger.warn(`distill failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const commandDeps: CommandDeps = {
    service,
    config,
    llm,
    collector,
    bus,
    gitStore,
    distillCursor,
    persistCursor: (c) => {
      distillCursor.current = c;
      cursorStore.write(c);
    },
  };

  registerTools(ctx, { service, llm, collector, cursor: distillCursor, persistCursor: (c) => cursorStore.write(c), skillsDir: config.skillsDir });
  registerCommand(ctx, commandDeps);
  registerHooks(ctx, collector);
  registerInjection(ctx, service, getConfig);
  registerProtocolInjection(ctx, service, getConfig);
  registerBackfillJob(ctx, collector, getConfig);
  registerMnemosRoutes(ctx, {
    store,
    service,
    gitStore,
    collector,
    runDistillNow,
    getConfig,
    llm: (ctx as unknown as { get(name: string): unknown }).get('llm') as import('./dsh/llm-adapter.js').LlmRuntimeLike | undefined,
    resolveModel: resolveLlmTarget,
  });

  logger.info(`dsh-mnemos ready at ${config.dbPath}`);
}
