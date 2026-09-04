import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { Memory, MemoryInput } from '../domain/types.js';

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
    store.recordInjection('hit1', 'sess-42');
    expect(store.getMemory('hit1')?.crossSessionHits).toBe(1);
    store.recordInjection('hit1', 'sess-43');
    expect(store.getMemory('hit1')?.crossSessionHits).toBe(2);
    store.close();
  });

  it('derives usage stats from the ledger (injections vs hits)', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ id: 'a1' }));
    store.addMemory(mem({ id: 'a2' }));
    const l1 = store.recordInjection('a1', 'sess-1');
    const l2 = store.recordInjection('a1', 'sess-2');
    const l3 = store.recordInjection('a2', 'sess-2');
    const stats = store.usageStats(7);
    // recordInjection records an INJECTION; used=0 until markLedgerUsed fires.
    expect(stats.totalInjections).toBe(3);
    expect(stats.totalHits).toBe(0);
    expect(stats.distinctSessions).toBe(2);
    const a1 = stats.perMemory.find((u) => u.memoryId === 'a1');
    const a2 = stats.perMemory.find((u) => u.memoryId === 'a2');
    expect(a1?.injections).toBe(2);
    expect(a1?.hits).toBe(0);
    expect(a1?.sessions).toBe(2);
    expect(a2?.injections).toBe(1);
    expect(a2?.sessions).toBe(1);
    expect(a1?.lastUsed).toBeTruthy();
    // Mark two injections as actually referenced (hits).
    store.markLedgerUsed(l1);
    store.markLedgerUsed(l2);
    const stats2 = store.usageStats(7);
    expect(stats2.totalHits).toBe(2);
    expect(stats2.totalInjections).toBe(3);
    expect(stats2.perMemory.find((u) => u.memoryId === 'a1')?.hits).toBe(2);
    store.close();
  });

  it('telemetry aggregates injection/used/token stats and verified flags', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ id: 't1' }));
    const l1 = store.recordInjection('t1', 's1', 100);
    store.recordInjection('t1', 's2', 200);
    store.markLedgerUsed(l1);
    const t = store.telemetry();
    expect(t.injections).toBe(2);
    expect(t.used).toBe(1);
    expect(t.usedRate).toBeCloseTo(0.5);
    expect(t.avgInjectedTokens).toBe(150);
    expect(t.verifiedMemories).toBe(0);
    store.markMemoryVerified('t1');
    expect(store.telemetry().verifiedMemories).toBe(1);
    expect(store.telemetry().totalActive).toBe(1);
    store.close();
  });

  it('filters by type and lists stale/deleted memories', () => {
    const store = openMemoryStore(':memory:');
    const old = mem({ id: 'old1', type: 'project_fact', updatedAt: '2024-01-01T00:00:00.000Z' } as Partial<MemoryInput> & { id: string; updatedAt: string });
    store.addMemory(old);
    store.addMemory(mem({ id: 'pref1', type: 'preference', updatedAt: new Date().toISOString() } as Partial<MemoryInput> & { id: string; updatedAt: string }));
    expect(store.listSummaries('workspace', 'my-ws', 'active', 'preference')).toHaveLength(1);
    expect(store.listSummaries('workspace', 'my-ws', 'active', 'project_fact')).toHaveLength(1);
    expect(store.listStale(30)).toEqual(['old1']);
    store.setMemoryStatus('pref1', 'deleted');
    const deletedIds = store.listDeleted().map((r) => r.id);
    expect(deletedIds).toContain('pref1');
    expect(deletedIds).not.toContain('old1');
    store.close();
  });

  it('excludes pinned memories from stale candidates and orders by heat (coldest first)', () => {
    const store = openMemoryStore(':memory:');
    const mk = (id: string, updatedAt: string, opts: { accessedAt?: string } = {}) =>
      store.addMemory(mem({ id, updatedAt, accessedAt: opts.accessedAt } as Partial<MemoryInput> & { id: string; updatedAt: string; accessedAt?: string }));
    mk('pinned-old', '2024-01-01T00:00:00.000Z');
    store.setPinned('pinned-old', true);
    mk('used-old', '2024-01-01T00:00:00.000Z', { accessedAt: '2024-02-01T00:00:00.000Z' });
    mk('coldest', '2024-01-01T00:00:00.000Z');
    const stale = store.listStale(30);
    expect(stale).not.toContain('pinned-old');
    // Coldest first: the memory last used longer ago (2024) precedes the never-moved one.
    expect(stale).toEqual(['used-old', 'coldest']);
    // pinning an active memory removes it from candidates.
    store.setPinned('coldest', true);
    expect(store.listStale(30)).toEqual(['used-old']);
    // archived status machine: archive -> restore round trip.
    store.setMemoryStatus('used-old', 'archived');
    expect(store.listSummaries(undefined, undefined, 'archived').map((r) => r.id)).toContain('used-old');
    expect(store.listStale(30)).toEqual([]);
    store.setMemoryStatus('used-old', 'active');
    expect(store.getMemory('used-old')?.status).toBe('active');
    store.close();
  });

  it('keeps only the 5 most recent deleted memories (prunes older ones)', () => {
    const store = openMemoryStore(':memory:');
    for (let i = 0; i < 8; i++) {
      store.addMemory(mem({ id: `d${i}`, topic: `t${i}`, updatedAt: `2026-01-01T00:00:00.000Z` } as Partial<MemoryInput> & { id: string; topic: string; updatedAt: string }));
      store.setMemoryStatus(`d${i}`, 'deleted');
    }
    // setMemoryStatus stamps updated_at, so the last deleted rows are newest and kept.
    expect(store.listDeleted().length).toBe(5);
    expect(store.listDeleted().map((r) => r.id).sort()).toEqual(['d3', 'd4', 'd5', 'd6', 'd7']);
    expect(store.getMemory('d2')).toBeUndefined();
    expect(store.getMemory('d7')).toBeDefined();
    store.close();
  });

  it('round-trips memories and approvals', () => {
    const store = openMemoryStore(':memory:');
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

  it('degrades to OR when the AND tier over-rejects a natural-language query', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ id: 't1', summary: 'graduated with a bachelors degree in 2021', topic: 'education' }));
    store.addMemory(mem({ id: 't2', summary: 'favorite coffee drink is an oat latte', topic: 'food' }));
    // AND tier: "degree graduated" both must hit one summary — no single
    // memory holds both. OR tier must still surface the degree memory.
    const andOnly = store.searchMemories('what degree did i graduate with', 5);
    expect(andOnly.some((r) => r.id === 't1')).toBe(true);
    expect(andOnly.some((r) => r.id === 't2')).toBe(false);
    store.close();
  });

  it('falls through to LIKE when FTS yields nothing (stopword-only query)', () => {
    const store = openMemoryStore(':memory:');
    store.addMemory(mem({ id: 'l1', summary: 'deploy uses a two step pipeline' }));
    // Every token here is a FTS stopword; FTS MATCH raises or returns empty,
    // so the LIKE tier must still find the memory by substring.
    const rows = store.searchMemories('uses a', 5);
    expect(rows.some((r) => r.id === 'l1')).toBe(true);
    store.close();
  });
});
