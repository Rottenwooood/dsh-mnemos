import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import {
  DISTILL_SYSTEM_PROMPT,
  parseDistillResponse,
  createDistillRunner,
  detectConflicts,
  filterNewMessages,
  toRule,
} from '../domain/distill.js';
import { Llm } from '../domain/llm.js';
import { ImportedMessage } from '../domain/imports/types.js';

function fakeLlm(respond: () => string): Llm {
  return {
    async complete(messages) {
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.content).toContain('curator');
      return respond();
    },
  };
}

function msg(partial: Partial<ImportedMessage> & Pick<ImportedMessage, 'role' | 'text'>): ImportedMessage {
  return { sessionId: 's1', index: 0, ...partial };
}

describe('parseDistillResponse', () => {
  it('parses a fenced JSON array and drops invalid entries', () => {
    const out = parseDistillResponse(`Here you go:
\`\`\`json
[{"type":"project_fact","topic":"build","summary":"Uses pnpm.","confidence":0.9},
 {"type":"bogus","topic":"x","summary":"y"},
 {"type":"procedure","topic":"ci","summary":"Run tests first.","confidence":0.7}]
\`\`\``);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe('project_fact');
  });

  it('returns [] for non-JSON garbage', () => {
    expect(parseDistillResponse('no json here')).toEqual([]);
  });
});

describe('distill runner', () => {
  function make() {
    const store = openMemoryStore(':memory:');
    const service = createMemoryService(store, createSensitiveDetector());
    return { store, service };
  }

  it('commits a high-confidence project fact and proposes a procedure rule', async () => {
    const { service } = make();
    const llm = fakeLlm(() =>
      JSON.stringify([
        { type: 'project_fact', topic: 'build tool', summary: 'The project builds with pnpm.', confidence: 0.95 },
        { type: 'procedure', topic: 'release', summary: 'Run typecheck then tests before release.', confidence: 0.8 },
      ]),
    );
    const runner = createDistillRunner(llm, service, { scope: 'workspace', workspace: 'ws', sessionId: 's1' });
    const stats = await runner.run([
      msg({ role: 'user', text: 'we use pnpm', index: 0 }),
      msg({ role: 'assistant', text: 'running release steps', index: 1 }),
    ]);
    expect(stats.memories).toBe(1);
    expect(stats.rules).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(service.listActive('workspace', 'ws')).toHaveLength(1);
    expect(service.listRules('proposed')).toHaveLength(1);
  });

  it('drops invalid LLM output and never writes it', async () => {
    const { service } = make();
    const llm = fakeLlm(() => 'not json at all');
    const runner = createDistillRunner(llm, service, { scope: 'workspace', workspace: 'ws' });
    const stats = await runner.run([msg({ role: 'user', text: 'hi', index: 0 })]);
    expect(stats.dropped).toBe(0);
    expect(stats.memories).toBe(0);
    expect(service.listActive()).toHaveLength(0);
    expect(service.listRules()).toHaveLength(0);
  });

  it('forces conflicting entries to the approval queue, never auto-approved', async () => {
    const { service } = make();
    service.add(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'build tool',
        summary: 'The project builds with npm.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );
    const llm = fakeLlm(() =>
      JSON.stringify([
        { type: 'project_fact', topic: 'build tool', summary: 'The project builds with pnpm, not npm.', confidence: 0.95 },
      ]),
    );
    const runner = createDistillRunner(llm, service, { scope: 'workspace', workspace: 'ws', sessionId: 's1' });
    const stats = await runner.run([msg({ role: 'user', text: 'actually pnpm', index: 0 })]);
    expect(stats.conflicts).toBe(1);
    expect(stats.memories).toBe(1);
    expect(service.listActive()).toHaveLength(1);
  });

  it('replaces the existing claim when a replacement proposal is approved', () => {
    const { store, service } = make();
    const existing = service.add(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'build tool',
        summary: 'The project builds with npm.',
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    ).memory!;
    const proposed = service.proposeReplacement(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: 'ws',
        topic: 'build tool',
        summary: 'The project builds with pnpm.',
        evidence: [{ sessionId: 's1', eventRange: [0, 0], quote: 'use pnpm' }],
        confidence: 0.95,
        source: 'evolve',
        writer: 'distill',
      },
      existing.id,
      'model',
    );
    expect(proposed.outcome).toBe('proposed');
    const approved = service.approve(proposed.approvalId!, 'approve');
    expect(approved.ok).toBe(true);
    expect(approved.memory?.summary).toContain('pnpm');
    expect(store.countActive()).toBe(1);
  });
});

describe('detectConflicts', () => {
  it('flags near-duplicate topics with differing summaries', () => {
    const { service } = makeServiceWithMemory();
    const conflicts = detectConflicts(
      service,
      [{ type: 'project_fact', topic: 'build tool', summary: 'The project builds with pnpm.', confidence: 0.9 }],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.existing.id).toBeDefined();
    expect(conflicts[0]!.existing.similarity).toBeGreaterThan(0.55);
  });
});

function makeServiceWithMemory() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  service.add(
    {
      type: 'project_fact',
      scope: 'workspace',
      workspace: 'ws',
      topic: 'build tool',
      summary: 'The project builds with pnpm.',
      evidence: [],
      confidence: 1,
      source: 'manual',
      writer: 'human',
    },
    'human',
  );
  return { service };
}

describe('toRule', () => {
  it('maps procedure to a skill rule and preference to a preference rule', () => {
    expect(toRule({ type: 'procedure', topic: 'x', summary: 'release steps', confidence: 0.8 })?.kind).toBe('skill');
    expect(toRule({ type: 'preference', topic: 'x', summary: 'use tabs', confidence: 0.9 })?.kind).toBe('preference');
    expect(toRule({ type: 'project_fact', topic: 'x', summary: 'fact', confidence: 1 })).toBeUndefined();
  });
});

describe('filterNewMessages (incremental cursor)', () => {
  it('returns only the tail beyond the cursor', () => {
    const a = msg({ role: 'user', text: 'a', index: 0 });
    const b = msg({ role: 'user', text: 'b', index: 1 });
    const c = msg({ role: 'user', text: 'c', index: 2 });
    const first = filterNewMessages([a, b], {});
    expect(first.newMessages).toHaveLength(2);
    const second = filterNewMessages([a, b, c], first.updated);
    expect(second.newMessages).toEqual([c]);
  });

  it('reprocesses from the cursor when the message at the cursor changed', () => {
    const a = msg({ role: 'user', text: 'a', index: 0 });
    const bOld = msg({ role: 'user', text: 'b-old', index: 1 });
    const bNew = msg({ role: 'user', text: 'b-new', index: 1 });
    const first = filterNewMessages([a, bOld], {});
    const second = filterNewMessages([a, bNew], first.updated);
    expect(second.newMessages).toEqual([bNew]);
  });
});
