import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createMemoryService } from '../domain/service.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMnemosAbi } from '../dsh/adapter.js';
import { MemoryInput } from '../domain/types.js';

function seedStore() {
  const store = openMemoryStore(':memory:');
  store.addMemory({
    id: 'mm://mnemos/abi-1',
    type: 'project_fact',
    scope: 'workspace',
    workspace: '/ws',
    topic: 'build tool',
    summary: 'abi target one',
    keywords: ['pnpm'],
    evidence: [],
    confidence: 1,
    source: 'manual',
    writer: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 0,
    status: 'active',
    trust: 'trusted',
  });
  return store;
}

describe('open measurement ABI (P3.2)', () => {
  it('recall returns real hits and an index with the memory_get instruction', () => {
    const store = seedStore();
    const service = createMemoryService(store, createSensitiveDetector());
    const abi = createMnemosAbi(store, service, '1.0.0', ':memory:');
    const out = abi.recall({ query: 'abi', limit: 10, includeIndex: true });
    expect(out.hits.some((h) => h.summary.includes('target'))).toBe(true);
    expect(out.index?.text).toContain('memory_get');
    expect(out.hits[0]!.trust).toBe('trusted');
    store.close();
  });

  it('get resolves by full id and short id', () => {
    const store = seedStore();
    const service = createMemoryService(store, createSensitiveDetector());
    const abi = createMnemosAbi(store, service, '1.0.0', ':memory:');
    expect(abi.get('mm://mnemos/abi-1')?.topic).toBe('build tool');
    expect(abi.get('abi-1')?.topic).toBe('build tool');
    expect(abi.get('nope')).toBeUndefined();
    store.close();
  });

  it('state and probe reflect the live store, not stubs', () => {
    const store = seedStore();
    const service = createMemoryService(store, createSensitiveDetector());
    const abi = createMnemosAbi(store, service, '1.0.0', '/x/db.sqlite');
    const state = abi.state();
    expect(state.active).toBe(1);
    expect(state.version).toBe('1.0.0');
    expect(state.usedRate).toBeGreaterThanOrEqual(0);
    const probe = abi.probe();
    expect(probe.ok).toBe(true);
    expect(probe.dbPath).toBe('/x/db.sqlite');
    expect(probe.active).toBe(1);
    store.close();
  });
});
