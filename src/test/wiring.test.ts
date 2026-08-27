import { describe, it, expect, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { createMemoryBus } from '../domain/bus.js';
import { registerTools } from '../dsh/tools.js';
import { registerCommand, CommandDeps } from '../dsh/command.js';
import { registerInjection, registerRuleInjection, SignalCollector } from '../dsh/hooks.js';
import { gateFrom, apply } from '../index.js';
import type { GitStore } from '../domain/gitstore.js';
import { defaultConfig } from '../config.js';
import { Llm } from '../domain/llm.js';
import type { CommandDefinition, ToolDefinition } from '../dsh/types.js';

function commandDeps(service: ReturnType<typeof makeService>['service']): CommandDeps {
  return {
    service,
    config: defaultConfig(),
    distillCursor: {},
    persistCursor: () => {},
  };
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

describe('tools wiring', () => {
  it('registers the four model-facing tools', () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, service);
    expect(tools.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_record',
      'memory_list',
      'memory_stats',
    ]);
  });

  it('memory_search finds a committed memory', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, service);
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
    registerTools(ctx, service);
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
});

describe('command wiring', () => {
  it('registers /mnemos and prints search results', async () => {
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
    const said: string[] = [];
    await command.handler('search semicolons', {
      caller: 'human',
      workspace: 'ws',
      say: (t) => said.push(t),
    });
    expect(said.join('\n')).toContain('No semicolons');
  });

  it('/mnemos import commits a remember candidate from a claude file', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, commandDeps(service));
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
    const said: string[] = [];
    await command.handler(`import auto ${file}`, {
      caller: 'human',
      workspace: 'ws',
      say: (t) => said.push(t),
    });
    unlinkSync(file);
    expect(said[0]).toContain('1 committed');
    expect(service.listActive('workspace', 'ws')).toHaveLength(1);
  });

  it('prints usage for an unknown subcommand', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, commandDeps(service));
    const command = commands[0]!;
    const said: string[] = [];
    await command.handler('bogus', { caller: 'human', say: (t) => said.push(t) });
    expect(said[0]).toContain('commands:');
  });
});

describe('pre-step injection', () => {
  it('injects the hot-layer projection into the agent and delegates via next', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    const added = service.add(
      {
        type: 'preference',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'pnpm',
        summary: 'Use pnpm for builds.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    if (added.memory) {
      service.recordHit(added.memory.id, 'other-session');
    }
    registerInjection(ctx, service, () => ({
      ...defaultConfig(),
      injectMaxBytes: 4096,
      injectMinHits: 0,
    }));
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const decision = await hook.listener(
      { agent: { id: 'a1' }, messages: [], turn: 0, step: 0, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    ) as { kind: string; messages: Array<{ content: Array<{ text: string }> }> };
    expect(decision.kind).toBe('enter');
    const texts = decision.messages.flatMap((m) => m.content.map((c) => c.text));
    expect(texts.join('\n')).toContain('Use pnpm');
  });

  it('injects once per session, frozen until the store changes', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(
      {
        type: 'preference',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'pnpm',
        summary: 'Use pnpm.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    let revision = 0;
    registerInjection(ctx, service, () => ({
      ...defaultConfig(),
      injectMaxBytes: 4096,
      injectMinHits: 0,
    }), () => revision);
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const listener = hook.listener as (
      payload: unknown,
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: Array<{ content: Array<{ text: string }> }> }>;
    const payload = { agent: { id: 'a1', session: { id: 's1' } }, messages: [], turn: 7, step: 0, signal: new AbortController().signal };
    const first = await listener(payload, async () => ({ kind: 'enter', messages: [] }));
    const injected = first.messages.length;
    expect(injected).toBeGreaterThan(0);
    // Later step in the same session: frozen, no re-injection.
    const second = await listener({ ...payload, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
    expect(second.messages.length).toBe(0);
    // Later turn in the same session: still frozen.
    const third = await listener({ ...payload, turn: 8, step: 0 }, async () => ({ kind: 'enter', messages: [] }));
    expect(third.messages.length).toBe(0);
    // A new session injects again.
    const fourth = await listener({ ...payload, agent: { id: 'a1', session: { id: 's2' } }, turn: 1, step: 0 }, async () => ({ kind: 'enter', messages: [] }));
    expect(fourth.messages.length).toBe(injected);
    // A store write bumps the revision: the frozen session re-injects.
    revision += 1;
    const fifth = await listener({ ...payload, turn: 9, step: 0 }, async () => ({ kind: 'enter', messages: [] }));
    expect(fifth.messages.length).toBe(injected);
  });

  it('skips injection when the injection master switch or plugin master switch is off', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    service.add(
      {
        type: 'preference',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'pnpm',
        summary: 'Use pnpm.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    registerInjection(ctx, service, () => ({ ...defaultConfig(), injectMaxBytes: 4096, injectMinHits: 0, injectionEnabled: false }));
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const listener = hook.listener as (
      payload: unknown,
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: Array<{ content: Array<{ text: string }> }> }>;
    const payload = { agent: { id: 'a1', session: { id: 's1' } }, messages: [], turn: 1, step: 0, signal: new AbortController().signal };
    const decision = await listener(payload, async () => ({ kind: 'enter', messages: [] }));
    expect(decision.messages.length).toBe(0);
  });
});

describe('rule injection (agent/pre-step)', () => {
  it('injects approved rules as an appended message and delegates via next', async () => {
    const { ctx, listeners } = fakeContext();
    const { service } = makeService();
    const proposed = service.proposeRule(
      {
        id: 'rule-inj',
        kind: 'preference',
        text: 'Always use pnpm for installs.',
        evidence: [],
        state: 'proposed',
        proposedBy: 'distill',
        version: 1,
      },
      'model',
    );
    service.approve(proposed.approvalId!, 'approve');
    registerRuleInjection(ctx, service, () => defaultConfig());
    const hook = listeners.find((l) => l.name === 'agent/pre-step')!;
    const decision = await hook.listener(
      { agent: { id: 'a1' }, messages: [], turn: 0, step: 0, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    ) as { kind: string; messages: Array<{ content: Array<{ text: string }> }> };
    expect(decision.kind).toBe('enter');
    const texts = decision.messages.flatMap((m) => m.content.map((c) => c.text));
    expect(texts.join('\n')).toContain('Always use pnpm');
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
    const said: string[] = [];
    await command.handler('distill', {
      caller: 'human',
      workspace: 'ws',
      say: (t) => said.push(t),
    });
    expect(service.listRules('proposed')).toHaveLength(1);
    expect(said[0]).toContain('Distilled');
  });
});

describe('/mnemos bus command', () => {
  it('blacklists and lists a plugin via the human command', async () => {
    const { ctx, commands } = fakeContext();
    const { store, service } = makeServiceWithStore();
    const bus = createMemoryBus(service, store);
    registerCommand(ctx, { ...commandDeps(service), bus });
    const command = commands[0]!;
    const said: string[] = [];
    await command.handler('bus blacklist spam-plugin "too noisy"', {
      caller: 'human',
      workspace: 'ws',
      say: (t) => said.push(t),
    });
    expect(bus.isBlacklisted('spam-plugin')).toBe(true);
    await command.handler('bus list', {
      caller: 'human',
      workspace: 'ws',
      say: (t) => said.push(t),
    });
    expect(said.join('\n')).toContain('spam-plugin');
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
    const said: string[] = [];
    const rt = { caller: 'human' as const, workspace: 'ws', say: (t: string) => said.push(t) };
    await command.handler('git status', rt);
    await command.handler('git log mm://x', rt);
    await command.handler('git rollback mm://x abc', rt);
    await command.handler('git pull', rt);
    expect(calls).toEqual(['status', 'log:mm://x', 'rollback:mm://x:abc', 'pull']);
    expect(said.join('\n')).toContain('2 entries reconciled');
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
    expect(tools.length).toBe(4);
  });
});
