import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService, rrfFuse } from '../domain/service.js';
import { buildInjection, recallByKeywords, recallIndex, recallQuery, RankedMemory } from '../domain/recall.js';

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

  it('keyword recall covers global memories plus only the session workspace', () => {    const store = openMemoryStore(':memory:');
    const service = createMemoryService(store, createSensitiveDetector());
    const add = (m: Parameters<typeof service.add>[0]) => service.add(m, 'human');
    add({ type: 'preference', scope: 'global', topic: 'uv', summary: 'User prefers uv.', keywords: ['uv'], evidence: [], confidence: 1, source: 'manual', writer: 'human' });
    add({ type: 'project_fact', scope: 'workspace', workspace: '/projA', topic: 'pnpm', summary: 'projA uses pnpm.', keywords: ['pnpm'], evidence: [], confidence: 1, source: 'manual', writer: 'human' });
    add({ type: 'project_fact', scope: 'workspace', workspace: '/projB', topic: 'yarn', summary: 'projB uses yarn.', keywords: ['yarn'], evidence: [], confidence: 1, source: 'manual', writer: 'human' });

    // Global memory injects regardless of workspace.
    expect(recallByKeywords(service, 'using uv', { workspace: '/projA' }).text).toContain('uv');
    // Project A memory injects in project A.
    expect(recallByKeywords(service, 'install with pnpm', { workspace: '/projA' }).text).toContain('projA uses pnpm');
    // Project B memory does NOT inject in project A.
    expect(recallByKeywords(service, 'install with yarn', { workspace: '/projA' }).text).not.toContain('yarn');
    // Project B memory injects in project B.
    expect(recallByKeywords(service, 'install with yarn', { workspace: '/projB' }).text).toContain('projB uses yarn');
  });

  it('the frozen index ranks recently-accessed memories above stale ones (power-law heat)', () => {
    const store = openMemoryStore(':memory:');
    const service = createMemoryService(store, createSensitiveDetector());
    const add = (m: Parameters<typeof service.add>[0]) => service.add(m, 'human');
    const fresh = add({ type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'pnpm', summary: 'fresh fact', keywords: ['pnpm'], evidence: [], confidence: 1, source: 'manual', writer: 'human' }).memory!;
    const stale = add({ type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'yarn', summary: 'stale fact', keywords: ['yarn'], evidence: [], confidence: 1, source: 'manual', writer: 'human' }).memory!;
    // access the fresh one now (bumps accessedAt), leave the stale one untouched
    service.recordHit(fresh.id, 's1', 100);
    store.updateMemory(stale.id, { summary: 'edited, but that is not an access' });
    const index = recallIndex(service, { workspace: '/ws' });
    const freshLine = index.text.split('\n').findIndex((l) => l.includes('pnpm'));
    const staleLine = index.text.split('\n').findIndex((l) => l.includes('yarn'));
    expect(freshLine).toBeGreaterThan(-1);
    expect(staleLine).toBeGreaterThan(freshLine);
  });
});
