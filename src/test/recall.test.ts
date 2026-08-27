import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService, rrfFuse } from '../domain/service.js';
import { buildInjection, recallHot, recallQuery, RankedMemory } from '../domain/recall.js';

function ranked(partial: Partial<RankedMemory> = {}): RankedMemory {
  return {
    id: 'm1',
    topic: 'build tool',
    summary: 'The project builds with pnpm.',
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'ws',
    crossSessionHits: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    score: 1,
    ...partial,
  };
}

describe('buildInjection', () => {
  it('fits entries under the byte budget and reports drops', () => {
    const entries = [
      ranked({ id: 'a', topic: 'aaaa', summary: 'x'.repeat(50) }),
      ranked({ id: 'b', topic: 'bbbb', summary: 'y'.repeat(50) }),
      ranked({ id: 'c', topic: 'cccc', summary: 'z'.repeat(50) }),
    ];
    const inj = buildInjection(entries, 120);
    expect(inj.injectedCount).toBeGreaterThan(0);
    expect(inj.droppedCount).toBe(entries.length - inj.injectedCount);
    expect(Buffer.byteLength(inj.text, 'utf8')).toBeLessThanOrEqual(120);
    expect(inj.text.startsWith('# dsh-mnemos')).toBe(true);
  });

  it('emits the header even for an empty budget', () => {
    const inj = buildInjection([ranked()], 0);
    expect(inj.text).toBe('# dsh-mnemos\n');
    expect(inj.injectedCount).toBe(0);
  });
});

function serviceWith(opts: { hits?: number[]; summaries?: string[] } = {}) {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  (opts.hits ?? []).forEach((hits, i) => {
    const m = service.add(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: 'ws',
        topic: `fact ${i}`,
        summary: opts.summaries?.[i] ?? `Some fact about topic ${i}.`,
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'test',
      },
      'human',
    );
    if (m.memory) {
      for (let k = 0; k < hits; k++) {
        service.recordHit(m.memory.id, `sess-${k}`);
      }
    }
  });
  return service;
}

describe('layered recall', () => {
  it('recallHot ranks frequently-used memories first', () => {
    const service = serviceWith({ hits: [5, 1] });
    const inj = recallHot(service, { maxBytes: 4096 });
    expect(inj.injectedCount).toBe(2);
    expect(inj.text.indexOf('fact 0')).toBeLessThan(inj.text.indexOf('fact 1'));
  });

  it('recallQuery returns the matching memory', () => {
    const service = serviceWith({
      hits: [0],
      summaries: ['The project builds with pnpm and vitest.'],
    });
    const inj = recallQuery(service, 'pnpm', { maxBytes: 4096 });
    expect(inj.text).toContain('pnpm');
    expect(inj.injectedCount).toBe(1);
  });

  it('rrfFuse merges independent rank lists by reciprocal rank', () => {
    // y is rank 1 in both lists -> outranks x (rank 1 only in list A) and z.
    const scores = rrfFuse([
      [{ id: 'x' }, { id: 'y' }],
      [{ id: 'y' }, { id: 'z' }],
    ]);
    const order = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order).toEqual(['y', 'x', 'z']);
    expect(scores.get('y')).toBeGreaterThan(scores.get('x')!);
  });

  it('service.search returns the fused union of both rankers', () => {
    const service = serviceWith({
      hits: [0, 0],
      summaries: ['Build with pnpm and vitest.', 'Prefer pnpm for package management.'],
    });
    const res = service.search('pnpm', 10);
    expect(res.length).toBe(2);
    expect(res.every((r) => r.summary.includes('pnpm'))).toBe(true);
  });
});
