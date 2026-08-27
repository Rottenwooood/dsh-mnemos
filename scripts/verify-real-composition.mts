/**
 * REAL-composition verification for the /memory command.
 *
 * Boots the REAL @deepseek-ai/dsh-commands + @deepseek-ai/dsh-session services,
 * applies dsh-mnemos, then dispatches /memory through the real registry
 * (`ctx.commands.execute`) exactly like the harness UI does. This is the layer
 * where the old `(args, runtime)` handler crashed ("args.trim is not a
 * function"); unit tests that call our handler directly cannot catch it.
 *
 * Run from the deepseek-harness monorepo so the dsh-* workspace packages resolve:
 *   node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/verify-real-composition.mts
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime, { type Agent } from '@deepseek-ai/dsh-commands'
import { openMemoryStore } from '/home/c6h4o2/dsh-mnemos/src/domain/store.ts'
import { apply as applyMnemos } from '/home/c6h4o2/dsh-mnemos/src/index.ts'

const DB = '/tmp/mnemos-real-composition.db'

async function main(): Promise<void> {
  // Pre-seed one memory so /memory list/search return real data.
  for (const suffix of ['', '-wal', '-shm']) {
    const { unlinkSync } = await import('node:fs')
    try { unlinkSync(`${DB}${suffix}`) } catch { /* fresh */ }
  }
  const seed = openMemoryStore(DB)
  seed.addMemory({
    id: 'mm://mnemos/seed-1',
    type: 'project_fact',
    scope: 'workspace',
    workspace: '/ws',
    topic: 'real-composition',
    summary: 'Booted through the real command registry.',
    evidence: [{ sessionId: 's1', eventRange: [1, 1], quote: 'real' }],
    confidence: 1,
    source: 'manual',
    writer: 'human',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    crossSessionHits: 0,
    status: 'active',
  })
  seed.close()

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const registeredTools: string[] = []
  ctx.provide('tools', {
    register: (t: { name: string }) => { registeredTools.push(t.name); return () => true },
  })

  applyMnemos(ctx, {
    dbPath: DB,
    gitVersioning: false,
    backfillEnabled: false,
    distillAuto: false,
  })

  // Let the plugin's effects flush and lazy settings/schemastery settle.
  await new Promise((r) => setTimeout(r, 600))

  const session = ctx.sessions.create(SessionId('real-verify'))
  const agent = { id: session.id, session } as Agent
  const c = ctx as unknown as { commands: { find(agent: Agent, name: string): unknown; execute(agent: Agent, line: string, images: readonly unknown[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined> } }

  const results: string[] = []
  const registered = c.commands.find(agent, 'memory') !== undefined
  results.push(`command 'memory' resolved by real registry: ${registered}`)
  results.push(`tools registered: ${JSON.stringify(registeredTools)}`)

  const list = await c.commands.execute(agent, '/memory list', [], new AbortController().signal)
  results.push(`/memory list -> ${JSON.stringify(list?.result)}`)

  const search = await c.commands.execute(agent, '/memory search real-composition', [], new AbortController().signal)
  results.push(`/memory search -> ${JSON.stringify(search?.result)}`)

  const usage = await c.commands.execute(agent, '/memory bogus-verb', [], new AbortController().signal)
  results.push(`/memory bogus -> ${JSON.stringify(usage?.result)}`)

  console.log(results.join('\n'))

  const ok =
    registered &&
    registeredTools.length === 4 &&
    list?.result.kind === 'success' &&
    (list.result.text ?? '').includes('real-composition') &&
    (search?.result.text ?? '').includes('real-composition') &&
    usage?.result.kind === 'success' &&
    (usage.result.text ?? '').includes('commands:')
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

void main()
