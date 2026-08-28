import { describe, it, expect, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { createMemoryBus } from '../domain/bus.js';
import { registerTools, ToolDeps } from '../dsh/tools.js';
import { registerCommand, CommandDeps } from '../dsh/command.js';
import { registerInjection, registerProtocolInjection, SignalCollector, UsageTracker } from '../dsh/hooks.js';
import { registerNegativeMemory } from '../dsh/negative-hooks.js';
import { openNegativeMemoryStore, negativeFingerprint } from '../domain/negative.js';
import { gateFrom, apply } from '../index.js';
import type { GitStore } from '../domain/gitstore.js';
import { defaultConfig } from '../config.js';
import { Llm } from '../domain/llm.js';
import type { CommandDefinition, CommandResult, ToolDefinition } from '../dsh/types.js';

function commandDeps(service: ReturnType<typeof makeService>['service']): CommandDeps {
  return {
    service,
    config: defaultConfig(),
    collector: new SignalCollector(() => {}),
    distillCursor: { current: {} },
    consolidate: () => ({ scenesProposed: 0, scenesSkipped: 0, personaProposed: 0, personaSkipped: 0 }),
    persistCursor: () => {},
  };
}
async function invokeCommand(command: CommandDefinition, rawInput: string): Promise<CommandResult> {
  return await command.handler({
    commandId: 'cid-1',
    agent: { id: 'agent-1', session: { id: 'sess-1', header: { cwd: 'ws' } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  });
}
function fakeContext() {
  const tools: ToolDefinition[] = [];
  const commands: CommandDefinition[] = [];
  const effects: Array<() => unknown> = [];
  const listeners: Array<{ name: string; listener: (...args: any[]) => unknown }> = [];
  const ctx = {
    tools: {
      register(tool: ToolDefinition) {
        tools.push(tool);
        return () => true;
      },
    },
    commands: {
      register(command: CommandDefinition) {
        commands.push(command);
        return () => true;
      },
    },
    jobs: {
      start() {
        return 'mnemos-backfill-1';
      },
      kill() {
        return 'requested';
      },
    },
    get() {
      return undefined;
    },
    effect(fn: () => unknown) {
      effects.push(fn);
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') {
          disposer();
        }
      };
    },
    on(name: string, listener: (...args: any[]) => unknown) {
      listeners.push({ name, listener });
      return () => true;
    },
    logger() {
      return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    },
    provide(name: string, value: unknown) {
      void name;
      void value;
      return () => true;
    },
  } as unknown as Context;
  return { ctx, tools, commands, listeners };
}

function makeService() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}
function toolDeps(service: ReturnType<typeof makeService>['service']): ToolDeps {
  return { service, cursor: { current: {} }, persistCursor: () => {} };
}

describe('tools wiring', () => {
  it('registers the six model-facing tools', () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, toolDeps(service));
    expect(tools.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_record',
      'memory_list',
      'memory_stats',
      'memory_get',
      'memory_distill',
    ]);
  });

  it('memory_search finds a committed memory', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, toolDeps(service));
    service.add(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'build tool',
        summary: 'The project builds with pnpm.',
        evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'pnpm' }],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    const search = tools.find((t) => t.name === 'memory_search')!;
    const exec = { agent: { id: 's2', session: { id: 's2', header: { cwd: 'ws' } } } };
    const out = (await (search as unknown as {
      execute(args: unknown, e: unknown): Promise<{ hits: unknown[] }>;
    }).execute({ query: 'pnpm' }, exec)) as { hits: unknown[] };
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it('memory_record routes model writes through the gate', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, toolDeps(service));
    const record = tools.find((t) => t.name === 'memory_record')!;
    const run = async (args: unknown): Promise<{ outcome: string }> =>
      (record as unknown as {
        execute(args: unknown, e: unknown): Promise<{ outcome: string }>;
      }).execute(args, { agent: { id: 's1', session: { id: 's1', header: { cwd: 'ws' } } } });

    const approved = await run({ topic: 'pnpm', summary: 'Uses pnpm.', confidence: 0.95 });
    expect(approved.outcome).toBe('committed');

    const queued = await run({ topic: 'todo', summary: 'Maybe refactor later.', confidence: 0.4 });
    expect(queued.outcome).toBe('proposed');

    const denied = await run({
      topic: 'secret',
      summary: 'Key is sk-abcdefghijklmnopqrstuvwxyzABCDEFGHI',
    });
    expect(denied.outcome).toBe('denied');
  });

  it('memory_distill distills buffered messages via the LLM and stores keywords', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    const llm: Llm = {
      async complete() {
        return JSON.stringify([
          { type: 'project_fact', topic: 'build tool', summary: 'Build with pnpm.', confidence: 0.95, keywords: ['pnpm', 'install'] },
        ]);
      },
    };
    const collector = new SignalCollector(() => {});
    collector.ingest([{ role: 'user', text: 'we use pnpm', sessionId: 's1', index: 0 }]);
    registerTools(ctx, { service, llm, collector, cursor: { current: {} }, persistCursor: () => {} });
    const distill = tools.find((t) => t.name === 'memory_distill')!;
    const out = (await (distill as unknown as {
      execute(args: unknown, e: unknown): Promise<{ memories: number }>;
    }).execute({}, { agent: { id: 'a1', session: { id: 's1', header: { cwd: 'ws' } } } })) as { memories: number };
    expect(out.memories).toBe(1);
    const stored = service.listActive('workspace', 'ws')[0]!;
    expect(stored.keywords).toEqual(['pnpm', 'install']);
  });
});

describe('command wiring', () => {
  it('registers /memory and prints search results', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, commandDeps(service));
    service.add(
      {
        type: 'preference',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'lint',
        summary: 'No semicolons in this repo.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    const command = commands[0]!;
    const result = await invokeCommand(command, 'search semicolons');
    expect(result.kind).toBe('success');
    expect(result.text).toContain('No semicolons');
  });

  it('/memory import ingests a transcript into the distill buffer', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    const collector = new SignalCollector(() => {});
    registerCommand(ctx, { ...commandDeps(service), collector });
    const file = '/tmp/opencode/mnemos-import-test.jsonl';
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '记住：用 pnpm' }] },
        timestamp: '2025-01-01T00:00:00.000Z',
      }),
    );
    const command = commands[0]!;
    const result = await invokeCommand(command, `import auto ${file}`);
    unlinkSync(file);
    expect(result.kind).toBe('success');
    expect(result.text).toContain('Ingested 1 messages');
    expect(collector.drain()).toHaveLength(1);
    expect(service.listActive('workspace', 'ws')).toHaveLength(0);
  });

  it('prints usage for an unknown subcommand', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, commandDeps(service));
    const command = commands[0]!;
    const result = await invokeCommand(command, 'bogus');
    expect(result.kind).toBe('success');
    expect(result.text).toContain('commands:');
  });
});

describe('pre-step injection', () => {
  function memoryWithKeywords(keywords: string[]): Parameters<ReturnType<typeof makeService>['service']['add']>[0] {
    return {
      type: 'preference',
      scope: 'workspace',
      workspace: 'ws',
      topic: 'pnpm',
      summary: 'Use pnpm for builds.',
      keywords,
      evidence: [],
      confidence: 1,
      source: 'manual',
      writer: 'human',
    };
  }

  async function listen(listeners: Array<{ name: string; listener: (...args: any[]) => unknown }>, messages: unknown[]): Promise<Array<{ content: Array<{ text: string }> }>> {
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const decision = await hook.listener(
      { agent: { id: 'a1', session: { id: 's1' } }, messages, turn: 0, step: 0, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    ) as { kind: string; messages: Array<{ content: Array<{ text: string }> }> };
    return decision.messages;
  }

  const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

  it('injects a frozen memory index (one line per memory) once per session', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(memoryWithKeywords(['pnpm']), 'human');
    registerInjection(ctx, service, () => ({ ...defaultConfig(), injectMaxBytes: 4096 }), new UsageTracker());
    const messages = await listen(listeners, [userMsg('how do I install with pnpm?')]);
    const texts = messages.flatMap((m) => m.content.map((c) => c.text));
    // The index contains the topic, not the full summary.
    expect(texts.join('\n')).toContain('pnpm');
    expect(texts.join('\n')).not.toContain('Use pnpm for builds.');
    expect(texts.join('\n')).toContain('记忆索引');
  });

  it('injects the index once per session, not per step or per user message', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(memoryWithKeywords(['pnpm']), 'human');
    registerInjection(ctx, service, () => ({ ...defaultConfig(), injectMaxBytes: 4096 }), new UsageTracker());
    const first = await listen(listeners, [userMsg('install with pnpm')]);
    expect(first.length).toBe(1);
    // Later steps / turns in the same session: frozen, no re-injection.
    const second = await listen(listeners, [userMsg('still pnpm')]);
    expect(second.length).toBe(0);
  });

  it('skips injection when the injection master switch is off', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(memoryWithKeywords(['pnpm']), 'human');
    registerInjection(ctx, service, () => ({ ...defaultConfig(), injectMaxBytes: 4096, injectionEnabled: false }), new UsageTracker());
    const messages = await listen(listeners, [userMsg('install with pnpm please')]);
    expect(messages.length).toBe(0);
  });

  it('memory_get drills into the full detail of an indexed memory', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, toolDeps(service));
    service.add(memoryWithKeywords(['pnpm']), 'human');
    const getTool = tools.find((t) => t.name === 'memory_get')!;
    const out = (await (getTool as unknown as {
      execute(args: unknown, e: unknown): Promise<{ found: boolean; summary: string }>;
    }).execute({ query: 'pnpm' }, {})) as { found: boolean; summary: string };
    expect(out.found).toBe(true);
    expect(out.summary).toContain('Use pnpm for builds.');
  });

  it('marks an injected memory as used when the assistant references it next', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(memoryWithKeywords(['pnpm']), 'human');
    const usage = new UsageTracker();
    registerInjection(ctx, service, () => ({ ...defaultConfig(), injectMaxBytes: 4096 }), usage);
    await listen(listeners, [userMsg('install with pnpm')]);
    expect(service.telemetry().injections).toBe(1);
    expect(service.telemetry().used).toBe(0);
    // The model's next message references the injected memory.
    usage.onAssistantText('s1', 'Sure, I will use pnpm for the install.', service);
    const after = service.telemetry();
    expect(after.used).toBe(1);
    expect(after.verifiedMemories).toBe(1);
    // A new user message clears the pending credit for that session.
    usage.onUserMessage('s1');
    expect(service.telemetry().used).toBe(1);
  });
});

describe('protocol injection (agent/pre-step)', () => {
  it('injects active protocol memories before any tool call and refreshes on cadence', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(
      {
        type: 'protocol',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'sandbox',
        summary: 'Every bash call runs in a fresh bwrap sandbox; /tmp is tmpfs.',
        keywords: ['bash', 'sandbox'],
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    registerProtocolInjection(ctx, service, () => defaultConfig());
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const listener = hook.listener as (
      payload: unknown,
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: Array<{ content: Array<{ text: string }> }> }>;
    const payload = { agent: { id: 'a1', session: { id: 's1' } }, messages: [], turn: 0, step: 0, signal: new AbortController().signal };
    const first = await listener(payload, async () => ({ kind: 'enter', messages: [] }));
    const texts = first.messages.flatMap((m) => m.content.map((c) => c.text));
    expect(texts.join('\n')).toContain('bwrap sandbox');
    // Within the refresh cadence (default 3 turns): no re-injection.
    const withinCadence = await listener({ ...payload, turn: 2, step: 0 }, async () => ({ kind: 'enter', messages: [] }));
    expect(withinCadence.messages.length).toBe(0);
    // Past the cadence: the standing instruction is re-attached (compaction defense).
    const refreshed = await listener({ ...payload, turn: 5, step: 0 }, async () => ({ kind: 'enter', messages: [] }));
    expect(refreshed.messages.length).toBe(1);
  });
});


describe('/mnemos distill command', () => {
  it('distills buffered session messages and proposes a rule', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    const collector = new SignalCollector(() => {});
    collector.onEvent({ id: 's1' }, { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '记住：用 pnpm' }] } });
    const llm: Llm = {
      async complete() {
        return JSON.stringify([{ type: 'preference', topic: 'pnpm', summary: 'Use pnpm.', confidence: 0.9 }]);
      },
    };
    registerCommand(ctx, { ...commandDeps(service), llm, collector });
    const command = commands[0]!;
    const result = await invokeCommand(command, 'distill');
    expect(service.listRules('proposed')).toHaveLength(1);
    expect(result.text).toContain('Distilled');
  });
});

describe('/memory bus command', () => {
  it('blacklists and lists a plugin via the human command', async () => {
    const { ctx, commands } = fakeContext();
    const { store, service } = makeServiceWithStore();
    const bus = createMemoryBus(service, store);
    registerCommand(ctx, { ...commandDeps(service), bus });
    const command = commands[0]!;
    await invokeCommand(command, 'bus blacklist spam-plugin "too noisy"');
    expect(bus.isBlacklisted('spam-plugin')).toBe(true);
    const list = await invokeCommand(command, 'bus list');
    expect(list.text).toContain('spam-plugin');
  });
});

function makeServiceWithStore() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

describe('/mnemos git command', () => {
  it('routes git subcommands through the GitStore', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    const calls: string[] = [];
    const gitStore = {
      status: async () => {
        calls.push('status');
        return { changed: ['x.md'] };
      },
      history: async (id?: string) => {
        calls.push(`log:${id ?? ''}`);
        return [{ sha: 'abc12345', message: 'add', date: '2026-01-01' }];
      },
      rollback: async (id: string, sha: string) => {
        calls.push(`rollback:${id}:${sha}`);
        return { ok: true };
      },
      restoreDeleted: async (id: string) => {
        calls.push(`restore:${id}`);
        return { ok: true };
      },
      setRemote: async (url: string) => {
        calls.push(`remote:${url}`);
      },
      push: async () => {
        calls.push('push');
        return { ok: true };
      },
      pull: async () => {
        calls.push('pull');
        return { ok: true, conflicts: [], applied: 2 };
      },
      exportBundle: async (out: string) => {
        calls.push(`backup:${out}`);
      },
    } as unknown as GitStore;
    registerCommand(ctx, { ...commandDeps(service), gitStore });
    const command = commands[0]!;
    const status = await invokeCommand(command, 'git status');
    expect(status.text).toContain('Uncommitted');
    await invokeCommand(command, 'git log mm://x');
    await invokeCommand(command, 'git rollback mm://x abc');
    const pull = await invokeCommand(command, 'git pull');
    expect(calls).toEqual(['status', 'log:mm://x', 'rollback:mm://x:abc', 'pull']);
    expect(pull.text).toContain('2 entries reconciled');
  });
});

describe('session signal collector', () => {
  it('detects an explicit remember request once', () => {
    const logs: string[] = [];
    const collector = new SignalCollector((m) => logs.push(m));
    collector.onEvent({ id: 's1' }, { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '记住：用 pnpm' }] } });
    collector.onEvent({ id: 's1' }, { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '记住：用 pnpm' }] } });
    collector.onEvent({ id: 's1' }, { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('remember-signal');
  });
});

describe('gateFrom', () => {
  it('maps Config to GateConfig', () => {
    const gate = gateFrom({
      ...defaultConfig(),
      dbPath: '/tmp/x.db',
      maxEntries: 10,
      maxBytesPerEntry: 100,
      autoApprove: false,
      autoApproveConfidence: 0.7,
      allowModelGlobalWrite: true,
      blacklist: ['bad'],
      sensitivityCheckEnabled: false,
    });
    expect(gate.maxEntries).toBe(10);
    expect(gate.blacklist).toEqual(['bad']);
    expect(gate.allowModelGlobalWrite).toBe(true);
    expect(gate.sensitivityCheckEnabled).toBe(false);
  });
});

describe('negative memory hooks', () => {
  function makeCtxWithToolEvents() {
    const listeners: Record<string, (...a: any[]) => unknown> = {};
    const ctx = {
      on(name: string, listener: (...a: any[]) => unknown) {
        listeners[name] = listener;
        return () => true;
      },
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    } as never;
    return { ctx, listeners };
  }

  it('records a failed command and denies the identical repeat', async () => {
    const { ctx, listeners } = makeCtxWithToolEvents();
    const store = openNegativeMemoryStore(':memory:');
    registerNegativeMemory(ctx as never, { store, getConfig: () => ({ ...defaultConfig() }) });
    const execute = listeners['tools/execute'] as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    const preExecute = listeners['tools/pre-execute'] as (exec: unknown, next: () => Promise<{ kind: string }>) => Promise<unknown>;

    const exec = { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, agent: { session: { header: { cwd: '/ws' } } } };
    // failure -> recorded
    await execute(exec, async () => ({ isError: true, error: { message: 'rm: refusing' } }));
    // identical repeat -> denied
    const denied = await preExecute(exec, async () => ({ kind: 'allow' }));
    expect(denied).toMatchObject({ kind: 'deny' });
    expect((denied as { reason: string }).reason).toContain('rm: refusing');
    // a different command is allowed
    const allowed = await preExecute({ ...exec, arguments: { command: 'ls' } }, async () => ({ kind: 'allow' }));
    expect(allowed).toMatchObject({ kind: 'allow' });
    // success resolves the negative memory
    const fp = negativeFingerprint('bash', '/ws', 'rm -rf /tmp/x');
    store.resolve(fp);
    const after = await preExecute(exec, async () => ({ kind: 'allow' }));
    expect(after).toMatchObject({ kind: 'allow' });
    store.close();
  });
});

describe('apply', () => {
  it('opens the store, provides ctx.mnemos and registers tools', async () => {
    const { ctx, tools } = fakeContext();
    const provided: Array<[string, unknown]> = [];
    const ctx2 = {
      ...ctx,
      provide(name: string, value: unknown) {
        provided.push([name, value]);
        return () => true;
      },
    } as unknown as Context;
    apply(ctx2, { dbPath: ':memory:', gitVersioning: false });
    expect(provided[0]?.[0]).toBe('mnemos');
    expect(tools.length).toBe(6);
  });
});
