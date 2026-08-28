/**
 * Conformance suite for the open measurement ABI (P3.2).
 *
 * Boots the REAL dsh-commands + ToolRuntime + SessionStore, applies dsh-mnemos,
 * then drives the ABI through the real mounted services (`ctx.mnemosAbi`,
 * `ctx.mnemosBus`, `ctx.mnemos`) exactly as any client/benchmark would. These
 * assertions prove the ABI is the real implementation — a stub that returns
 * canned data cannot pass (the checks cross-check live store state).
 *
 * Run from the deepseek-harness monorepo:
 *   node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/conformance.mts
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { unlinkSync } from 'node:fs'
import { openMemoryStore } from '/home/c6h4o2/dsh-mnemos/src/domain/store.ts'
import { apply as applyMnemos } from '/home/c6h4o2/dsh-mnemos/src/index.ts'

const DB = '/tmp/mnemos-conformance.db'
const ROOT = '/tmp/mnemos-conformance-repo'

async function main(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(`${DB}${suffix}`) } catch { /* fresh */ }
  }
  // Seed two memories through the REAL store so the ABI reads real data.
  const seed = openMemoryStore(DB)
  seed.addMemory({
    id: 'mm://mnemos/conf-a', type: 'project_fact', scope: 'workspace', workspace: '/ws',
    topic: 'build tool', summary: 'conformance target A', evidence: [], confidence: 1,
    source: 'manual', writer: 'human', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', crossSessionHits: 1, status: 'active', trust: 'trusted',
  })
  seed.addMemory({
    id: 'mm://mnemos/conf-b', type: 'preference', scope: 'global',
    topic: 'uv', summary: 'conformance target B', keywords: ['uv', 'python'], evidence: [], confidence: 1,
    source: 'manual', writer: 'human', createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z', crossSessionHits: 0, status: 'active', trust: 'trusted',
  })
  seed.close()

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('systemPrompt', { tools: () => () => true, section: () => () => true })
  await ctx.plugin(ToolRuntime)
  applyMnemos(ctx, { dbPath: DB, gitVersioning: true, memoryRepoDir: ROOT, backfillEnabled: false, distillAuto: false })
  await new Promise((r) => setTimeout(r, 600))

  const abi = ctx.get('mnemosAbi') as unknown as {
    recall(i: unknown): unknown
    get(id: string): unknown
    state(): unknown
    probe(): unknown
  }
  const bus = ctx.get('mnemosBus') as unknown as { recall(i: unknown): unknown; get(id: string): unknown; state(): unknown }
  const service = ctx.get('mnemos') as unknown as { add(i: unknown, caller: string): { outcome: string; memory?: { trust?: string } } }

  const results: string[] = []
  let pass = true
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
    if (!ok) pass = false
  }

  // probe: live fingerprint, not a stub.
  const probe = abi.probe() as { ok: boolean; name: string; version: string; active: number }
  check('probe returns live fingerprint', probe.ok === true && probe.name === 'dsh-mnemos' && probe.version.length > 0 && probe.active === 2, JSON.stringify(probe))

  // recall: real query over the real store.
  const recall = abi.recall({ query: 'conformance', limit: 10, includeIndex: true }) as { hits: Array<{ topic: string; summary: string }>; index?: { text: string } }
  check('recall returns real hits', Array.isArray(recall.hits) && recall.hits.length >= 1 && recall.hits.some((h) => h.summary.includes('target')), recall.hits.map((h) => h.topic).join(','))
  check('recall index includes memory_get instruction', typeof recall.index?.text === 'string' && recall.index.text.includes('memory_get'))

  // get: by full id and by short id.
  const byId = abi.get('mm://mnemos/conf-a') as { topic?: string } | undefined
  check('get by full id', byId?.topic === 'build tool')
  const short = (abi.get('conf-b') as { topic?: string } | undefined)
  check('get by short id', short?.topic === 'uv', JSON.stringify(short))

  // state: reflects real counts; cross-check against the live store.
  const state = abi.state() as { active: number; untrusted: number; injections: number }
  check('state reflects real active count', state.active === 2, JSON.stringify(state))

  // Bus alignment: recall + get + state behave like the ABI (three primitives).
  const busRecall = bus.recall({ query: 'conformance' }) as Array<{ topic: string; summary: string }>
  check('bus recall aligns with ABI', Array.isArray(busRecall) && busRecall.length >= 1 && busRecall.some((h) => h.summary.includes('target')))
  const busGet = bus.get('conf-a') as { topic?: string } | undefined
  check('bus get by short id', busGet?.topic === 'build tool')
  const busState = bus.state() as { active: number; writers: Array<{ name: string; count: number }> }
  check('bus state reports writers', busState.active === 2 && busState.writers.some((w) => w.count >= 1))

  // write path through the service still governed: a model write is untrusted.
  const model = service.add(
    { type: 'project_fact', scope: 'workspace', workspace: '/ws', topic: 'poison', summary: 'x', evidence: [{ sessionId: 's1', eventRange: [0, 0], quote: 'x' }], confidence: 1, source: 'evolve', writer: 'model' },
    'model',
  )
  check('model write is untrusted', model.memory?.trust === 'untrusted')

  console.log(results.join('\n'))
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

void main()
