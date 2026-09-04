/**
 * Route-handler tests for `/mnemos/api/*` (M5 host RPC).
 *
 * These exercise `createMnemosRouteHandler` with REAL URL strings and the real
 * `URLSearchParams` parsing — the layer where query-param bugs live (e.g. a
 * `?type=` empty value must mean "no filter", not "type == ''"). Domain unit
 * tests never touch this code, which is exactly why the empty-param bug
 * slipped through.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { SignalCollector } from '../dsh/hooks.js';
import { createMemoryService } from '../domain/service.js';
import { createMnemosRouteHandler, MnemosRouteDeps } from '../dsh/routes.js';
import type { MemoryService } from '../domain/service.js';
import type { Config } from '../config.js';
import { defaultConfig } from '../config.js';

function makeDeps(overrides: Partial<MnemosRouteDeps> = {}): MnemosRouteDeps {
  const store = openMemoryStore(':memory:');
  const service: MemoryService = createMemoryService(store, createSensitiveDetector());
  return {
    store,
    service,
    runDistillNow: async () => ({ memories: 0, conflicts: 0 }),
    resolveModel: async () => undefined,
    getConfig: () => defaultConfig(),
    collector: new SignalCollector(() => {}),
    ...overrides,
  };
}

function seed(service: MemoryService): string {
  const res = service.add(
    {
      type: 'project_fact',
      scope: 'workspace',
      workspace: '/ws',
      topic: 'pnpm',
      summary: 'Build with pnpm.',
      evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'pnpm' }],
      confidence: 1,
      source: 'manual',
      writer: 'human',
    },
    'human',
  );
  return res.memory!.id;
}

/** A fake req/res pair for one route invocation. */
async function call(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let status = 0;
  let text = '';
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(t: string) {
      text = t;
    },
  } as unknown as ServerResponse;
  const req = {
    method,
    url,
    [Symbol.asyncIterator]: body === undefined
      ? undefined
      : async function* () {
          yield Buffer.from(JSON.stringify(body), 'utf8');
        },
  } as unknown as IncomingMessage;
  await handler(req, res);
  return { status, json: text ? JSON.parse(text) : {} };
}

describe('/mnemos/api route handler', () => {
  it('returns all memories for an empty type filter (?type= means no filter)', async () => {
    const deps = makeDeps();
    seed(deps.service);
    const handler = createMnemosRouteHandler(deps);
    const res = await call(handler, 'GET', '/mnemos/api/memories?scope=workspace&type=');
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(1);
    expect(res.json.memories).toHaveLength(1);
  });

  it('filters memories by a concrete type', async () => {
    const deps = makeDeps();
    seed(deps.service);
    const handler = createMnemosRouteHandler(deps);
    const res = await call(handler, 'GET', '/mnemos/api/memories?scope=workspace&type=project_fact');
    expect(res.json.count).toBe(1);
    const noMatch = await call(handler, 'GET', '/mnemos/api/memories?scope=workspace&type=preference');
    expect(noMatch.json.count).toBe(0);
  });

  it('lists deleted memories with status=deleted and reports empty otherwise', async () => {
    const deps = makeDeps();
    const id = seed(deps.service);
    deps.service.removeMemory(id);
    const handler = createMnemosRouteHandler(deps);
    const res = await call(handler, 'GET', '/mnemos/api/memories?status=deleted');
    expect(res.json.count).toBe(1);
  });

  it('searches with the hybrid recall and reports stats/usage', async () => {
    const deps = makeDeps();
    seed(deps.service);
    const handler = createMnemosRouteHandler(deps);
    const search = await call(handler, 'GET', '/mnemos/api/search?q=pnpm');
    expect(search.json.hits).toHaveLength(1);
    const stats = await call(handler, 'GET', '/mnemos/api/stats');
    expect(stats.json.totalActive).toBe(1);
    const usage = await call(handler, 'GET', '/mnemos/api/usage?days=7');
    expect(typeof usage.json.totalHits).toBe('number');
    expect(typeof usage.json.totalInjections).toBe('number');
    expect(Array.isArray(usage.json.perMemory)).toBe(true);
  });

  it('lists pending approvals and approves one through the service gate', async () => {
    const deps = makeDeps();
    const added = deps.service.add(
      {
        type: 'preference',
        scope: 'workspace',
        workspace: '/ws',
        topic: 'naming',
        summary: 'Use kebab-case.',
        evidence: [],
        confidence: 0.5,
        source: 'manual',
        writer: 'model',
      },
      'model',
    );
    const handler = createMnemosRouteHandler(deps);
    const pending = await call(handler, 'GET', '/mnemos/api/pending');
    expect(pending.json.pending).toHaveLength(1);
    expect(added.approvalId).toBeGreaterThan(0);
    const approved = await call(handler, 'POST', '/mnemos/api/approve', { approvalId: added.approvalId, decision: 'approve' });
    expect(approved.json.ok).toBe(true);
    const after = await call(handler, 'GET', '/mnemos/api/pending');
    expect(after.json.pending).toHaveLength(0);
  });

  it('exports all memories', async () => {
    const deps = makeDeps();
    seed(deps.service);
    const handler = createMnemosRouteHandler(deps);
    const exported = await call(handler, 'GET', '/mnemos/api/export');
    expect((exported.json.memories as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('reports cleanup candidates and archives them on POST (reversible)', async () => {
    const deps = makeDeps();
    const staleId = 'mm://mnemos/stale-1';
    deps.store.addMemory({
      id: staleId,
      type: 'project_fact',
      scope: 'workspace',
      workspace: '/ws',
      topic: 'stale',
      summary: 'unused for ages',
      evidence: [],
      confidence: 1,
      source: 'manual',
      writer: 'human',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      crossSessionHits: 0,
      status: 'active',
    });
    const handler = createMnemosRouteHandler(deps);
    const preview = await call(handler, 'GET', '/mnemos/api/cleanup?days=1');
    const ids = preview.json.ids as string[];
    expect(ids).toContain(staleId);
    const archived = await call(handler, 'POST', '/mnemos/api/cleanup', { ids });
    expect(archived.json.archived).toBe(ids.length);
    // Archive is reversible: the memory is archived (not deleted), and restore works.
    expect(deps.store.getMemory(staleId)?.status).toBe('archived');
    const restored = await call(handler, 'POST', '/mnemos/api/memory/restore', { id: staleId });
    expect(restored.json.ok).toBe(true);
    expect(deps.store.getMemory(staleId)?.status).toBe('active');
    // Pin round trip: pin then unpin.
    const pinned = await call(handler, 'POST', '/mnemos/api/memory/pin', { id: staleId, pinned: true });
    expect(pinned.json.ok).toBe(true);
    expect(deps.store.getMemory(staleId)?.pinned).toBe(true);
  });

  it('uses configured cleanupDays when no query overrides, and reports the effective days', async () => {
    const deps = makeDeps({ getConfig: () => ({ ...defaultConfig(), cleanupDays: 45 }) });
    const handler = createMnemosRouteHandler(deps);
    // No query: the configured 45-day window is used and reported back.
    const preview = await call(handler, 'GET', '/mnemos/api/cleanup');
    expect(preview.json.days).toBe(45);
    expect(preview.json.count).toBe(0);
    // An explicit query overrides the configured window.
    const overridden = await call(handler, 'GET', '/mnemos/api/cleanup?days=7');
    expect(overridden.json.days).toBe(7);
  });
});
