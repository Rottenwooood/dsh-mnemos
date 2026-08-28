import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createMemoryService } from '../domain/service.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { recallIndex } from '../domain/recall.js';
import { MemoryInput } from '../domain/types.js';

function add(store: ReturnType<typeof openMemoryStore>, input: Partial<MemoryInput> & { id: string; trust?: 'trusted' | 'untrusted'; keywords?: string[] }) {
  store.addMemory({
    type: 'project_fact',
    scope: 'global',
    topic: input.topic ?? 't',
    summary: input.summary ?? 's',
    evidence: [],
    confidence: 1,
    source: 'manual',
    writer: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 0,
    status: 'active',
    trust: input.trust,
    keywords: input.keywords,
    id: input.id,
  });
}

describe('poisoning defense (P3)', () => {
  it('bounded occupancy: untrusted entries capped and ranked after trusted ones', () => {
    const store = openMemoryStore(':memory:');
    for (let i = 0; i < 5; i++) add(store, { id: `t${i}`, topic: `trusted-${i}`, keywords: ['k'], trust: 'trusted' });
    for (let i = 0; i < 5; i++) add(store, { id: `u${i}`, topic: `untrusted-${i}`, keywords: ['k'], trust: 'untrusted' });
    const service = createMemoryService(store, createSensitiveDetector());
    const index = recallIndex(service, { untrustedMax: 2, limit: 50 });
    const lines = index.text.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines.filter((l) => l.includes('untrusted-'))).toHaveLength(2); // capped at 2
    // trusted first
    expect(lines[0]).toContain('trusted-');
    // untrusted entries carry the /未验证 source marker
    const untrustedLine = lines.find((l) => l.includes('untrusted-'))!;
    expect(untrustedLine).toContain('/未验证');
    const trustedLine = lines.find((l) => l.includes('trusted-'))!;
    expect(trustedLine).not.toContain('/未验证');
    store.close();
  });

  it('service assigns trust by caller and upgrades on human approval', () => {
    const store = openMemoryStore(':memory:');
    const service = createMemoryService(store, createSensitiveDetector());
    const committed = service.add({ type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'x', summary: 'model wrote this', evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'x' }], confidence: 1, source: 'evolve', writer: 'model' }, 'model');
    expect(committed.memory?.trust).toBe('untrusted');
    const human = service.add({ type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'y', summary: 'human wrote this', evidence: [], confidence: 1, source: 'manual', writer: 'human' }, 'human');
    expect(human.memory?.trust).toBe('trusted');
    // a model proposal approved by a human becomes trusted
    const proposed = service.add({ type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'z', summary: 'proposed by model', evidence: [], confidence: 0.3, source: 'evolve', writer: 'model' }, 'model', true);
    expect(proposed.outcome).toBe('proposed');
    const approved = service.approve(proposed.approvalId!, 'approve');
    expect(approved.memory?.trust).toBe('trusted');
    store.close();
  });
});
