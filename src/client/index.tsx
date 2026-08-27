/**
 * Browser half of dsh-mnemos (M5): registers the memory-console tab on the
 * better-sidebar service (`ctx.betterSidebar.registerTab`). The tab is a React
 * component that reads and drives the host through the plugin's own
 * `/mnemos/api/*` routes, so every action still goes through the MemoryService
 * gate and GitStore — the browser can never bypass governance.
 *
 * Built with `pnpm run build:client` (esbuild) into `lib/client.js`; the
 * module system serves it at `/plugins/dsh-mnemos/client.js`. Only `react`
 * (a baseline external provided by the platform module table) is imported at
 * runtime; all DSH types here are structural.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react'

/** JSON result of one /mnemos/api call. */
interface JsonState<T> {
  data: T | null
  error: string | null
  reload: () => void
}

function useJson<T>(path: string): JsonState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch(path)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((value: T) => {
        if (!cancelled) {
          setData(value)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [path, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload }
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const row: Record<string, React.CSSProperties> = {
  section: { marginBottom: 10, border: '1px solid var(--dsw-border, #444)', borderRadius: 6, padding: 8 },
  title: { fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--dsw-text, #ddd)' },
  text: { fontSize: 12, lineHeight: 1.5, margin: '2px 0', color: 'var(--dsw-text-soft, #bbb)' },
  button: { marginRight: 6, marginTop: 4, fontSize: 12, padding: '2px 8px' },
  input: { width: '100%', boxSizing: 'border-box', marginBottom: 6, fontSize: 12, padding: 4 },
}

/** One pending approval row from /mnemos/api/pending. */
interface PendingRow {
  id: number
  kind: string
  proposedBy: string
  payload?: { topic?: string; summary?: string }
}

interface MemoryRow {
  id: string
  topic: string
  summary: string
  type: string
  crossSessionHits: number
  updatedAt: string
}

/** The memory-console tab body. */
export function MnemosTab(): ReactNode {
  const stats = useJson<{ totalActive: number; pending: number; gate: { maxEntries: number } }>('/mnemos/api/stats')
  const pending = useJson<{ pending: PendingRow[] }>('/mnemos/api/pending')
  const memories = useJson<{ memories: MemoryRow[] }>('/mnemos/api/memories?scope=workspace')
  const git = useJson<{ changed: string[] }>('/mnemos/api/git/status')
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')

  const act = async (path: string, body?: unknown): Promise<void> => {
    try {
      const result = (await postJson(path, body)) as { ok?: boolean; error?: string; reason?: string }
      setMessage(JSON.stringify(result).slice(0, 200))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
    pending.reload()
    memories.reload()
    git.reload()
    stats.reload()
  }

  return (
    <div style={{ padding: 10 }}>
      <div style={row.section}>
        <div style={row.title}>概览</div>
        <div style={row.text}>
          {stats.data ? `${stats.data.totalActive} 条记忆 · ${stats.data.pending} 待审批 · 上限 ${stats.data.gate.maxEntries}` : stats.error ?? '加载中…'}
        </div>
        <button style={row.button} onClick={() => act('/mnemos/api/distill')}>
          现在提炼
        </button>
      </div>

      <div style={row.section}>
        <div style={row.title}>待审批</div>
        {(pending.data?.pending ?? []).map((p) => (
          <div key={p.id} style={{ marginBottom: 8 }}>
            <div style={row.text}>
              [{p.kind}] {p.payload?.topic ?? p.id} — {p.payload?.summary ?? ''} (by {p.proposedBy})
            </div>
            <button style={row.button} onClick={() => act('/mnemos/api/approve', { approvalId: p.id, decision: 'approve' })}>
              批准
            </button>
            <button style={row.button} onClick={() => act('/mnemos/api/approve', { approvalId: p.id, decision: 'reject' })}>
              拒绝
            </button>
          </div>
        ))}
        {pending.data && pending.data.pending.length === 0 ? <div style={row.text}>无待审批项</div> : null}
        {pending.error ? <div style={row.text}>{pending.error}</div> : null}
      </div>

      <div style={row.section}>
        <div style={row.title}>记忆</div>
        <input
          style={row.input}
          placeholder="搜索记忆…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(memories.data?.memories ?? [])
          .filter((m) => search.length === 0 || `${m.topic} ${m.summary}`.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 20)
          .map((m) => (
            <div key={m.id} style={row.text}>
              {m.topic} — {m.summary}（命中 {m.crossSessionHits}）
            </div>
          ))}
        {memories.data && memories.data.memories.length === 0 ? <div style={row.text}>暂无记忆</div> : null}
      </div>

      <div style={row.section}>
        <div style={row.title}>git 同步</div>
        <div style={row.text}>{git.data ? `${git.data.changed.length} 未提交变更` : git.error ?? '加载中…'}</div>
        <button style={row.button} onClick={() => act('/mnemos/api/git/pull')}>
          pull
        </button>
        <button style={row.button} onClick={() => act('/mnemos/api/git/push')}>
          push
        </button>
        <button style={row.button} onClick={() => act('/mnemos/api/git/backup', { out: '/tmp/mnemos-backup.bundle' })}>
          备份
        </button>
      </div>

      {message ? (
        <div style={{ ...row.text, color: 'var(--dsw-accent, #7cb8ff)' }}>{message}</div>
      ) : null}
    </div>
  )
}

/** Cordis client plugin face (browser half). */
export const name = 'dsh-mnemos'

/** Wait for the better-sidebar service before mounting the tab. */
export const inject = ['betterSidebar']

/**
 * Register the memory-console tab on the sidebar registry.
 * @param ctx - the browser cordis context (betterSidebar declared by inject).
 */
export function apply(ctx: unknown): void {
  const betterSidebar = (ctx as { betterSidebar: { registerTab(tab: unknown): () => void } }).betterSidebar
  betterSidebar.registerTab({
    id: 'mnemos:memory',
    title: '记忆',
    single: true,
    component: MnemosTab,
  })
}
