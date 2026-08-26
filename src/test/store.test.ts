import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { Memory, MemoryInput, Rule } from '../domain/types.js';

function mem(partial: Partial<MemoryInput> & { id?: string } = {}): Memory {
  return {
    id: `mm://mnemos/${crypto.randomUUID()}`,
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'my-ws',
    topic: 'build',
    summary: 'Build with pnpm.',
    detail: undefined,
    evidence: [{ sessionId: 's1', eventRange: [1, 2], quote: 'build with pnpm' }],
    confidence: 1,
    source: 'manual',
    writer: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 0,
    status: 'active',
    ...partial,
  };
}

describe('memory store', () => {
  it('adds, reads, lists and searches memories', () => {
    const store = openMemoryStore(':memory:');
    const m = mem();
    store.addMemory(m);
    expect(store.getMemory(m.id)?.topic).toBe('build');
    expect(store.countActive()).toBe(1);
    expect(store.listSummaries('workspace', 'my-ws')).toHaveLength(1);
    expect(store.searchMemories('pnpm', 5)).toHaveLength(1);
    store.close();
  });

  it('respects scope/workspace/status filters', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ scope: 'global', workspace: undefined, id: 'g1' }));
    store.addMemory(mem({ workspace: 'ws-a', id: 'a1' }));
    store.addMemory(mem({ workspace: 'ws-b', id: 'b1' }));
    expect(store.listSummaries('global')).toHaveLength(1);
    expect(store.listSummaries('workspace', 'ws-a')).toHaveLength(1);
    expect(store.listSummaries('workspace', 'ws-b')).toHaveLength(1);
    store.setMemoryStatus('b1', 'archived');
    expect(store.listSummaries('workspace', 'ws-b')).toHaveLength(0);
    store.close();
  });

  it('detects an exact duplicate topic and counts active', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ topic: 'pnpm install', id: 'x1' }));
    expect(store.exactTopicExists(mem({ topic: '  Pnpm install ' }))).toBe(true);
    expect(store.exactTopicExists(mem({ topic: 'yarn install' }))).toBe(false);
    store.close();
  });

  it('tracks cross-session hits and writes a usage ledger row', () => {
    const store = openMemoryStore(':memory:');
    const m = mem({ id: 'hit1' });
    store.addMemory(m);
    store.recordHit('hit1', 'sess-42');
    expect(store.getMemory('hit1')?.crossSessionHits).toBe(1);
    store.recordHit('hit1', 'sess-43');
    expect(store.getMemory('hit1')?.crossSessionHits).toBe(2);
    store.close();
  });

  it('round-trips rules and approvals', () => {
    const store = openMemoryStore(':memory:');
    const rule: Rule = {
      id: 'rule-1',
      kind: 'preference',
      text: 'Never touch package-lock.json.',
      evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'never touch it' }],
      state: 'proposed',
      proposedBy: 'model',
      version: 1,
    };
    store.insertRule(rule);
    expect(store.listRules('proposed')).toHaveLength(1);

    const approval = {
      id: 0,
      kind: 'memory' as const,
      payload: { topic: 'x' },
      state: 'proposed' as const,
      proposedBy: 'model',
      evidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    store.insertApproval(approval);
    const listed = store.listApprovals('proposed');
    expect(listed).toHaveLength(1);
    const id = listed[0]!.id;
    store.updateApprovalState(id, 'approved');
    expect(store.getApproval(id)?.state).toBe('approved');
    store.close();
  });

  it('writes audit entries and returns their id', () => {
    const store = openMemoryStore(':memory:');
    const id = store.insertAudit({
      ts: '2026-01-01T00:00:00.000Z',
      action: 'denied',
      targetType: 'memory',
      targetId: 'x',
      payload: { topic: 'x' },
      denied: 1,
      byAgent: 1,
      reason: 'sensitive',
    });
    expect(id).toBeGreaterThan(0);
    const entries = store.listAudit(5);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('sensitive');
    expect(entries[0]?.byAgent).toBe(1);
    store.close();
  });

  it('updates a memory and falls back to LIKE search', () => {
    const store = openMemoryStore(':memory:');
    const m = mem({ id: 'u1', summary: 'zzz foo bar' });
    store.addMemory(m);
    store.updateMemory('u1', { summary: 'alpha beta gamma', detail: 'extra' });
    const updated = store.getMemory('u1');
    expect(updated?.summary).toBe('alpha beta gamma');
    expect(updated?.detail).toBe('extra');
    expect(store.searchMemories('beta', 5)).toHaveLength(1);
    store.close();
  });
});
