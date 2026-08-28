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
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { unlinkSync, writeFileSync } from 'node:fs'
import { openMemoryStore } from '/home/c6h4o2/dsh-mnemos/src/domain/store.ts'
import { openNegativeMemoryStore } from '/home/c6h4o2/dsh-mnemos/src/domain/negative.ts'
import { apply as applyMnemos } from '/home/c6h4o2/dsh-mnemos/src/index.ts'

const DB = '/tmp/mnemos-real-composition.db'

async function main(): Promise<void> {
  // Pre-seed one memory so /memory list/search return real data.
  for (const suffix of ['', '-wal', '-shm']) {
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
  // Real tool pipeline: ToolRuntime needs a systemPrompt service for schema wiring.
  ctx.provide('systemPrompt', { tools: () => () => true, section: () => () => true })
  await ctx.plugin(ToolRuntime)

  applyMnemos(ctx, {
    dbPath: DB,
    gitVersioning: true,
    memoryRepoDir: '/tmp/mnemos-real-composition-repo',
    backfillEnabled: false,
    distillAuto: false,
  })

  // A real command tool that fails for one known command, succeeds otherwise.
  const bashTool: ToolDefinition = {
    name: 'bash',
    description: 'run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] as ContentBlock[],
    },
    async execute(args: unknown) {
      const { command } = args as { command: string }
      if (command.includes('rm -rf /tmp/nope')) {
        throw new Error('rm: /tmp/nope: No such file or directory')
      }
      return 'ok'
    },
  }
  ctx.tools.register(bashTool)

  // Let the plugin's effects flush and lazy settings/schemastery settle.
  await new Promise((r) => setTimeout(r, 600))

  const session = ctx.sessions.create(SessionId('real-verify'))
  const agent = { id: session.id, session } as Agent
  const c = ctx as unknown as {
    get<T = unknown>(name: string): T
    commands: {
      find(agent: Agent, name: string): unknown
      execute(agent: Agent, line: string, images: readonly unknown[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
    }
    tools: {
      get(name: string): unknown
      execute(exec: unknown): Promise<{ isError: boolean; error?: { message?: string } }>
    }
  }

  const results: string[] = []
  const registered = c.commands.find(agent, 'memory') !== undefined
  results.push(`command 'memory' resolved by real registry: ${registered}`)
  const mnemosToolNames = ['memory_search', 'memory_record', 'memory_list', 'memory_stats', 'memory_get', 'memory_distill']
  const toolsVisible = mnemosToolNames.every((n) => c.tools.get(n) !== undefined)
  results.push(`mnemos tools registered on real ToolRuntime (${mnemosToolNames.length}): ${toolsVisible}`)

  // Negative memory through the REAL tool pipeline:
  // 1) a failing command is recorded; 2) the identical repeat is denied with
  // the stored evidence; 3) a success resolves the negative.
  const negAgent = { id: 'neg-agent', session: { id: SessionId('neg-s'), header: { cwd: '/ws' } } } as unknown as Agent
  const runTool = (name: string, command: string) =>
    c.tools.execute({ callId: CallId(`neg-${Date.now()}-${Math.random()}`), name, arguments: { command }, agent: negAgent, signal: new AbortController().signal })
  const boom = 'rm -rf /tmp/nope'
  const first = await runTool('bash', boom)
  results.push(`negative: failing call isError=${first.isError}`)
  const repeat = await runTool('bash', boom)
  results.push(`negative: repeat denied=${repeat.isError && (repeat.error?.message ?? '').includes('已知失败')} (${repeat.error?.message ?? ''})`)
  const success = await runTool('bash', 'echo ok')
  results.push(`negative: unrelated call allowed=${!success.isError}`)

  const run = async (line: string): Promise<string> => {
    const exec = await c.commands.execute(agent, line, [], new AbortController().signal)
    return `${exec?.result.kind}: ${exec?.result.text ?? ''}`
  }

  const list = await run('/memory list')
  results.push(`/memory list -> ${list}`)

  const search = await run('/memory search real-composition')
  results.push(`/memory search -> ${search}`)

  const stats = await run('/memory stats')
  results.push(`/memory stats -> ${stats}`)

  const usage = await run('/memory bogus-verb')
  results.push(`/memory bogus -> ${usage}`)

  // /memory approve: seed a proposed (model) write, then approve it.
  const service = c.get<{ add(input: unknown, caller: string): { outcome: string; approvalId?: number } }>('mnemos')
  const proposed = service.add(
    { type: 'preference', scope: 'workspace', workspace: '/ws', topic: 'naming', summary: 'Use kebab-case.', evidence: [], confidence: 0.4, source: 'manual', writer: 'model' },
    'model',
  )
  const approve = await run(`/memory approve ${proposed.approvalId ?? 0}`)
  results.push(`/memory approve -> ${approve}`)

  // /memory import from a claude-code fixture.
  const importFile = '/tmp/opencode/mnemos-real-import.jsonl'
  writeFileSync(importFile, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '记住：real import works' }] }, timestamp: '2025-01-01T00:00:00.000Z' }))
  const imported = await run(`/memory import auto ${importFile}`)
  unlinkSync(importFile)
  results.push(`/memory import -> ${imported}`)

  // /memory rules + git status round trip.
  const rules = await run('/memory rules list')
  results.push(`/memory rules list -> ${rules}`)

  const gitStatus = await run('/memory git status')
  results.push(`/memory git status -> ${gitStatus}`)

  // Archive/restore/pin through the real registry: archive hides it from
  // /memory list, restore brings it back, pin marks it protected.
  const archived = await run('/memory archive mm://mnemos/seed-1')
  const afterArchive = await run('/memory list')
  const restored = await run('/memory restore mm://mnemos/seed-1')
  const pinned = await run('/memory pin mm://mnemos/seed-1')
  const afterPin = await run('/memory list')
  results.push(`/memory archive -> ${archived}`)
  results.push(`archived hidden from list=${!afterArchive.includes('real-composition')}`)
  results.push(`/memory restore -> ${restored}`)
  results.push(`/memory pin -> ${pinned}`)
  results.push(`pinned marked=${afterPin.includes('pinned')}`)

  console.log(results.join('\n'))

  const ok =
    registered &&
    toolsVisible &&
    first.isError &&
    repeat.isError &&
    (repeat.error?.message ?? '').includes('已知失败') &&
    !success.isError &&
    list.includes('real-composition') &&
    search.includes('real-composition') &&
    stats.includes('Active memories') &&
    usage.includes('commands:') &&
    approve.includes('Approved memory') &&
    imported.includes('Ingested 1 messages') &&
    rules.includes('No rules.') &&
    (gitStatus.includes('Uncommitted') || gitStatus.includes('clean')) &&
    !afterArchive.includes('real-composition') &&
    afterPin.includes('pinned')
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

void main()
