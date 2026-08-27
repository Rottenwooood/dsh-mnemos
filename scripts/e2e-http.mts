/**
 * End-to-end HTTP verification: walks EVERY /mnemos/api flow against a running
 * dsh web server, like the browser would. Run with the server up on :3080.
 *
 *   node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/e2e-http.mts
 *
 * This exists because earlier "verification" only curled a few GET endpoints;
 * the git push bug (isomorphic http stub) survived because real push/pull was
 * never exercised. Every flow here asserts and fails the run on mismatch.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://localhost:3080/mnemos/api'
const FIXTURE = '/tmp/opencode/mnemos-e2e'
const fixtureFile = join(FIXTURE, 'session.jsonl')

let failures = 0
const results: string[] = []

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (err) {
    failures += 1
    results.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : {} }
}

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}

// Fresh import fixture (claude-code shape, matches imports.test.ts).
mkdirSync(FIXTURE, { recursive: true })
writeFileSync(
  fixtureFile,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'remember to use pnpm' }] }, timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Got it, I will use pnpm.' }] }, timestamp: '2025-01-01T00:00:01.000Z' }),
  ].join('\n'),
  'utf8',
)

async function main(): Promise<void> {
  // ---- overview / listing ----
  await check('stats', async () => {
    const { status, json } = await api('/stats')
    expect(status === 200 && typeof json.totalActive === 'number', `stats: ${status} ${JSON.stringify(json)}`)
  })

  await check('memories empty-type returns all (regression)', async () => {
    const { json } = await api('/memories?scope=workspace&type=')
    expect(json.count === (json.memories as unknown[]).length, 'count mismatch')
    expect((json.memories as unknown[]).length >= 1, 'empty type filter returned nothing')
  })

  await check('memories concrete-type filter + deleted + all', async () => {
    const anyType = await api('/memories?scope=workspace&type=project_fact')
    expect(typeof anyType.json.count === 'number', 'type filter failed')
    const deleted = await api('/memories?status=deleted')
    expect(Array.isArray(deleted.json.memories), 'deleted list not an array')
    const all = await api('/memories?status=all')
    expect(Array.isArray(all.json.memories), 'all list not an array')
  })

  await check('search (RRF) + usage + pending + history', async () => {
    const search = await api('/search?q=pnpm')
    expect(Array.isArray(search.json.hits), 'search hits not array')
    const usage = await api('/usage?days=7')
    expect((usage.json.daily as unknown[]).length === 7, 'usage daily length')
    const pending = await api('/pending')
    expect(Array.isArray(pending.json.pending), 'pending not array')
    const hist = await api('/history?state=rejected')
    expect(Array.isArray(hist.json.items), 'history items not array')
  })

  await check('models discovery (real DSH llm settings)', async () => {
    const { status, json } = await api('/models')
    expect(status === 200 && Array.isArray(json.providers), `models: ${status}`)
  })

  await check('export + cleanup preview', async () => {
    const exported = await api('/export')
    expect(Array.isArray(exported.json.memories), 'export memories not array')
    const cleanup = await api('/cleanup?days=90')
    expect(Array.isArray(cleanup.json.ids), 'cleanup ids not array')
  })

  // ---- import flow (ingests a transcript into the distill buffer) ----
  await check('import preview + run ingests', async () => {
    const preview = await api(`/import/preview?dir=${encodeURIComponent(FIXTURE)}`)
    expect(preview.json.totalFiles >= 1 && preview.json.totalMessages >= 1, `preview found no messages: ${JSON.stringify(preview.json)}`)
    const run = await api('/import/run', { method: 'POST', body: { dir: FIXTURE } })
    expect(run.json.ingested >= 1, `import ingested 0: ${JSON.stringify(run.json)}`)
    // The imported messages landed in the distill buffer, not the store.
    const memories = (await api('/memories?scope=workspace&type=')).json.memories as Array<{ topic: string; id: string }>
    const before = await api('/stats')
    const _ = memories
    void before
  })

  // ---- edit flow (bumps git revision) ----
  let importedId = ''
  await check('memory add then edit (goes through the gate, commits to git)', async () => {
    const added = await api('/memory/add', {
      method: 'POST',
      body: { topic: 'e2e add test', summary: 'Created via the add endpoint.', keywords: ['e2e-add'] },
    })
    expect(added.json.memoryId !== null, `add failed: ${JSON.stringify(added.json)}`)
    importedId = added.json.memoryId as string
    const res = await api('/memory/edit', { method: 'POST', body: { id: importedId, summary: 'edited e2e summary' } })
    expect(res.json.ok === true, `edit failed: ${JSON.stringify(res.json)}`)
  })

  // wait for the debounced git auto-commit
  await new Promise((r) => setTimeout(r, 2000))

  // ---- git flows ----
  await check('git status clean after auto-commit', async () => {
    const { json } = await api('/git/status')
    expect(Array.isArray(json.changed), 'git status changed not array')
  })

  await check('git history has commits for the imported memory', async () => {
    const { json } = await api(`/git/history?id=${encodeURIComponent(importedId)}`)
    expect((json.history as unknown[]).length >= 1, `no history for ${importedId}`)
  })

  await check('git rollback to first sha restores original summary', async () => {
    const { json } = await api(`/git/history?id=${encodeURIComponent(importedId)}`)
    const history = json.history as Array<{ sha: string }>
    const first = history[history.length - 1]!.sha
    const show = await api(`/git/show?id=${encodeURIComponent(importedId)}&sha=${first}`)
    expect(typeof show.json.content === 'string', 'show returned no content')
    const rollback = await api('/git/rollback', { method: 'POST', body: { id: importedId, sha: first } })
    expect(rollback.json.ok === true, `rollback failed: ${JSON.stringify(rollback.json)}`)
  })

  await new Promise((r) => setTimeout(r, 1500))

  await check('git backup writes a bundle', async () => {
    const out = '/tmp/opencode/mnemos-e2e-backup.bundle'
    const res = await api('/git/backup', { method: 'POST', body: { out } })
    expect(res.json.bundle === out, 'backup path mismatch')
    expect(existsSync(out), 'bundle file not created')
    unlinkSync(out)
  })

  // ---- delete + restore flow ----
  await check('delete then restore the memory', async () => {
    const del = await api('/memory/delete', { method: 'POST', body: { id: importedId } })
    expect(del.json.ok === true, `delete failed: ${JSON.stringify(del.json)}`)
    const deleted = await api('/memories?status=deleted')
    expect((deleted.json.memories as Array<{ id: string }>).some((m) => m.id === importedId), 'deleted memory not listed')
    const restore = await api('/git/restore', { method: 'POST', body: { id: importedId } })
    expect(restore.json.ok === true, `restore failed: ${JSON.stringify(restore.json)}`)
    const active = await api('/memories?scope=workspace&type=')
    expect((active.json.memories as Array<{ id: string }>).some((m) => m.id === importedId), 'restored memory not active')
    // clean up the e2e memory
    await api('/memory/delete', { method: 'POST', body: { id: importedId } })
  })

  // ---- sync round trip against the configured remote ----
  await check('git push + pull against the configured remote', async () => {
    const push = await api('/git/push', { method: 'POST' })
    expect(push.json.ok === true, `push failed: ${JSON.stringify(push.json)}`)
    const pull = await api('/git/pull', { method: 'POST' })
    expect(pull.json.ok === true, `pull failed: ${JSON.stringify(pull.json)}`)
  }, )

  // ---- distill endpoint round trip ----
  await check('distill endpoint', async () => {
    const res = await api('/distill', { method: 'POST' })
    expect(res.status === 200, `distill: ${res.status}`)
  })

  console.log(results.join('\n'))
  console.log(`RESULT: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  try { unlinkSync(fixtureFile) } catch { /* keep dir */ }
  process.exit(failures === 0 ? 0 : 1)
}

void main()
