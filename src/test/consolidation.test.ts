import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { runConsolidation } from '../domain/consolidation.js';
import { createMemoryService } from '../domain/service.js';
import { createSensitiveDetector } from '../domain/sensitive.js';

function add(store: ReturnType<typeof openMemoryStore>, input: {
  id: string;
  type: string;
  scope: 'global' | 'workspace';
  workspace?: string;
  topic: string;
  summary: string;
  keywords?: string[];
  observationCount?: number;
}) {
  store.addMemory({
    id: input.id,
    type: input.type as never,
    scope: input.scope,
    workspace: input.workspace,
    topic: input.topic,
    summary: input.summary,
    keywords: input.keywords,
    evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'x' }],
    confidence: 1,
    source: 'manual',
    writer: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 0,
    observationCount: input.observationCount,
    status: 'active',
  });
}

describe('consolidation (dream / scenes + persona)', () => {
  it('proposes a scene for keyword-connected memories in one workspace', () => {
    const store = openMemoryStore(':memory:');
    add(store, { id: 'a', type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'pnpm', summary: 'pnpm workspaces layout', keywords: ['pnpm', 'monorepo'] });
    add(store, { id: 'b', type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'monorepo', summary: 'turborepo pipeline', keywords: ['pnpm', 'ci'] });
    add(store, { id: 'c', type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'git', summary: 'branch naming', keywords: ['git'] });
    const r = runConsolidation(store, 'test');
    expect(r.scenesProposed).toBe(1); // a+b share 'pnpm'
    const scenes = store.listScenes();
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.memoryIds.sort()).toEqual(['a', 'b']);
    // re-running dedupes.
    const again = runConsolidation(store, 'test');
    expect(again.scenesProposed).toBe(0);
    expect(again.scenesSkipped).toBe(1);
    store.close();
  });

  it('proposes an evidence-weighted persona claim from preferences', () => {
    const store = openMemoryStore(':memory:');
    add(store, { id: 'p1', type: 'preference', scope: 'global', topic: 'shell', summary: 'zsh everywhere', keywords: ['shell'], observationCount: 3 });
    add(store, { id: 'p2', type: 'preference', scope: 'global', topic: 'shell', summary: 'fish in scripts', keywords: ['shell'] });
    const r = runConsolidation(store, 'test');
    expect(r.personaProposed).toBe(1);
    const claims = store.listPersona();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.claim).toContain('zsh everywhere');
    // weight = 2 members + 3 observations + 2 evidence entries.
    expect(claims[0]!.weight).toBe(7);
    expect(claims[0]!.state).toBe('proposed');
    store.close();
  });

  it('approves a persona claim and projects it into the recall index by relevance', async () => {
    const store = openMemoryStore(':memory:');
    add(store, { id: 'p1', type: 'preference', scope: 'global', topic: 'uv', summary: '使用 uv 管理 python 依赖', keywords: ['uv', 'python'] });
    const runConsolidationResult = runConsolidation(store, 'test');
    expect(runConsolidationResult.personaProposed).toBe(1);
    const claim = store.listPersona()[0]!;
    store.setPersonaState(claim.id, 'approved');
    store.setMemoryStatus('p1', 'archived'); // index only persona now
    const { recallIndex } = await import('../domain/recall.js');
    const service = createMemoryService(store, createSensitiveDetector());
    const index = recallIndex(service, { personaText: '用 uv 装 python 包', personaMax: 2 });
    expect(index.text).toContain('[persona]');
    expect(index.text).toContain('uv');
    const unrelated = recallIndex(service, { personaText: '前端样式怎么调', personaMax: 2 });
    expect(unrelated.text).not.toContain('[persona]');
    store.close();
  });
});
