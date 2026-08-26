import { describe, it, expect, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { registerTools } from '../dsh/tools.js';
import { registerCommand } from '../dsh/command.js';
import { SignalCollector } from '../dsh/hooks.js';
import { gateFrom, apply } from '../index.js';
import type { CommandDefinition, ToolDefinition } from '../dsh/types.js';

function fakeContext() {
  const tools: ToolDefinition[] = [];
  const commands: CommandDefinition[] = [];
  const effects: Array<() => unknown> = [];
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
    effect(fn: () => unknown) {
      effects.push(fn);
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') {
          disposer();
        }
      };
    },
    on() {
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
  return { ctx, tools, commands };
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
    const out = (await search.run(
      { query: 'pnpm' },
      { caller: 'model', workspace: 'ws', sessionId: 's2' },
    )) as { hits: unknown[] };
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it('memory_record routes model writes through the gate', async () => {
    const { ctx, tools } = fakeContext();
    const { service } = makeService();
    registerTools(ctx, service);
    const record = tools.find((t) => t.name === 'memory_record')!;

    const approved = (await record.run(
      { topic: 'pnpm', summary: 'Uses pnpm.', confidence: 0.95 },
      { caller: 'model', workspace: 'ws', sessionId: 's1' },
    )) as { outcome: string };
    expect(approved.outcome).toBe('committed');

    const queued = (await record.run(
      { topic: 'todo', summary: 'Maybe refactor later.', confidence: 0.4 },
      { caller: 'model', workspace: 'ws', sessionId: 's1' },
    )) as { outcome: string };
    expect(queued.outcome).toBe('proposed');

    const denied = (await record.run(
      { topic: 'secret', summary: 'Key is sk-abcdefghijklmnopqrstuvwxyzABCDEFGHI' },
      { caller: 'model', workspace: 'ws', sessionId: 's1' },
    )) as { outcome: string };
    expect(denied.outcome).toBe('denied');
  });
});

describe('command wiring', () => {
  it('registers /memory and prints search results', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, service);
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

  it('prints usage for an unknown subcommand', async () => {
    const { ctx, commands } = fakeContext();
    const { service } = makeService();
    registerCommand(ctx, service);
    const command = commands[0]!;
    const said: string[] = [];
    await command.handler('bogus', { caller: 'human', say: (t) => said.push(t) });
    expect(said[0]).toContain('commands:');
  });
});

describe('session signal collector', () => {
  it('detects an explicit remember request once', () => {
    const logs: string[] = [];
    const collector = new SignalCollector((m) => logs.push(m));
    collector.onEvent({ type: 'user/message', sessionId: 's1', index: 0, text: '记住：用 pnpm' });
    collector.onEvent({ type: 'user/message', sessionId: 's1', index: 0, text: '记住：用 pnpm' });
    collector.onEvent({ type: 'user/message', sessionId: 's1', index: 1, text: 'hello' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('remember-signal');
  });
});

describe('gateFrom', () => {
  it('maps Config to GateConfig', () => {
    const gate = gateFrom({
      dbPath: '/tmp/x.db',
      maxEntries: 10,
      maxBytesPerEntry: 100,
      autoApprove: false,
      autoApproveConfidence: 0.7,
      allowModelGlobalWrite: true,
      blacklist: ['bad'],
      injectLimit: 3,
      injectMinHits: 2,
    });
    expect(gate.maxEntries).toBe(10);
    expect(gate.blacklist).toEqual(['bad']);
    expect(gate.allowModelGlobalWrite).toBe(true);
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
    apply(ctx2, { dbPath: ':memory:' });
    expect(provided[0]?.[0]).toBe('mnemos');
    expect(tools.length).toBe(4);
  });
});
