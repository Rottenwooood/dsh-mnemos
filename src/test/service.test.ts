import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService, DEFAULT_GATE, GateConfig } from '../domain/service.js';
import { MemoryInput } from '../domain/types.js';

function input(partial: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'my-ws',
    topic: 'build',
    summary: 'Build with pnpm.',
    detail: undefined,
    evidence: [{ sessionId: 's1', eventRange: [1, 2], quote: 'build with pnpm' }],
    confidence: 0.95,
    source: 'manual',
    writer: 'test',
    ...partial,
  };
}

function makeService(cfg: Partial<GateConfig> = {}) {
  const store = openMemoryStore(':memory:');
  const detector = createSensitiveDetector();
  const service = createMemoryService(store, detector, { ...DEFAULT_GATE, ...cfg });
  return { store, service };
}

describe('memory service write path', () => {
  it('commits human writes directly', () => {
    const { service } = makeService();
    const res = service.add(input(), 'human');
    expect(res.outcome).toBe('committed');
    expect(res.memory?.status).toBe('active');
  });

  it('auto-approves high-confidence model project facts within a workspace', () => {
    const { service } = makeService();
    const res = service.add(input({ writer: 'model', confidence: 0.95 }), 'model');
    expect(res.outcome).toBe('committed');
  });

  it('sends low-confidence model writes to the proposal queue', () => {
    const { service } = makeService();
    const res = service.add(input({ writer: 'model', confidence: 0.5 }), 'model');
    expect(res.outcome).toBe('proposed');
    expect(res.approvalId).toBeGreaterThan(0);
  });

  it('queues a model global write for approval when allowed', () => {
    const { service } = makeService({ allowModelGlobalWrite: true });
    const res = service.add(input({ writer: 'model', scope: 'global', confidence: 1 }), 'model');
    expect(res.outcome).toBe('proposed');
  });

  it('denies a model global write when policy forbids it', () => {
    const { service } = makeService({ allowModelGlobalWrite: false, autoApprove: false });
    const res = service.add(input({ writer: 'model', scope: 'global', confidence: 1 }), 'model');
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('scope');
  });

  it('denies sensitive content and audits the rejection as by_agent', () => {
    const { service, store } = makeService();
    const res = service.add(
      input({ summary: 'Here is my sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIKEY' }),
      'model',
    );
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('sensitive');
    const audit = store.listAudit(10);
    expect(audit.some((e) => e.denied === 1 && e.byAgent === 1 && e.reason === 'sensitive')).toBe(
      true,
    );
  });

  it('denies exact duplicates', () => {
    const { service } = makeService();
    service.add(input({ topic: 'pnpm install' }), 'human');
    const res = service.add(input({ topic: ' Pnpm install ' }), 'human');
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('duplicate');
  });

  it('denies a blacklisted writer', () => {
    const { service } = makeService({ blacklist: ['bad-plugin'] });
    const res = service.add(input({ writer: 'bad-plugin' }), 'plugin');
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('blacklisted');
  });

  it('denies writes over the byte budget', () => {
    const { service } = makeService({ maxBytesPerEntry: 32 });
    const res = service.add(input({ summary: 'A very long summary that certainly exceeds the tiny byte budget set here.' }), 'human');
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('budget');
  });

  it('denies writes once the entry budget is full', () => {
    const { service } = makeService({ maxEntries: 1 });
    service.add(input({ topic: 'a' }), 'human');
    const res = service.add(input({ topic: 'b' }), 'human');
    expect(res.outcome).toBe('denied');
    expect(res.reason).toBe('budget-full');
  });

  it('approves a queued proposal into active memory', () => {
    const { service, store } = makeService();
    const res = service.add(input({ writer: 'model', confidence: 0.5 }), 'model');
    const id = res.approvalId!;
    expect(store.countActive()).toBe(0);
    const approved = service.approve(id, 'approve');
    expect(approved.ok).toBe(true);
    expect(store.countActive()).toBe(1);
  });

  it('rejects a proposal and leaves nothing active', () => {
    const { service, store } = makeService();
    const res = service.add(input({ writer: 'model', confidence: 0.5 }), 'model');
    const approved = service.approve(res.approvalId!, 'reject');
    expect(approved.ok).toBe(true);
    expect(store.countActive()).toBe(0);
    const again = service.approve(res.approvalId!, 'approve');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('not-pending');
  });

  it('records a hit after a search', () => {
    const { service, store } = makeService();
    const res = service.add(input(), 'human');
    service.recordHit(res.memory!.id, 'sess-1');
    expect(store.getMemory(res.memory!.id)?.crossSessionHits).toBe(1);
  });
});
