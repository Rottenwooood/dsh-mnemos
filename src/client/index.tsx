/**
 * Browser half of dsh-mnemos (M5): registers a top-level settings page
 * (`settings.section` id `mnemos`, sibling of Models / Plugins / General) and
 * the memory-console tab on the better-sidebar service
 * (`ctx.betterSidebar.registerTab`).
 *
 * The settings page reads and writes the `mnemos` namespace through the shared
 * settings-scope service (`ctx.settingsScope.bind`), styled with the harness
 * design tokens (--dsw-alias-*) so it matches the built-in pages. The
 * better-sidebar tab drives the host through the plugin's own `/mnemos/api/*`
 * routes (every action still goes through the MemoryService gate and
 * GitStore).
 *
 * Built with `pnpm run build:client` (esbuild) into `lib/client.js`; the
 * module system serves it at `/plugins/dsh-mnemos/client.js`. Only `react`
 * (a platform baseline external) is imported at runtime; all DSH types here
 * are structural.
 */

import { useState, useEffect, useCallback, useSyncExternalStore, Component, type ReactNode } from 'react'
import css from './mnemos.css'

/** JSON result of one /mnemos/api call. */
interface JsonState<T> {
  data: T | null
  error: string | null
  reload: () => void
}

function useJson<T>(path: string): JsonState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
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
  }, [path, reloadKey])
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
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

/** One pending approval row from /mnemos/api/pending. */
interface PendingRow {
  id: number
  kind: string
  proposedBy: string
  createdAt: string
  payload?: { topic?: string; summary?: string; text?: string; scope?: string; type?: string; confidence?: number }
}

interface MemoryRow {
  id: string
  topic: string
  summary: string
  type: string
  scope: string
  workspace: string | null
  crossSessionHits: number
  updatedAt: string
  status: string
}

/** One git commit from /mnemos/api/git/history. */
interface GitCommit {
  sha: string
  message: string
  date: string
}

const MEMORY_TYPES = ['project_fact', 'preference', 'protocol', 'learned']

/** `/mnemos/api/usage` answer: ledger-derived cross-session stats. */
interface UsageStats {
  totalHits: number
  distinctSessions: number
  perMemory: Array<{ memoryId: string; hits: number; sessions: number; lastUsed: string | null }>
  daily: Array<{ day: string; count: number }>
}

/** Last-30-days hit heatmap: one cell per day, intensity = hits/max. */
function Heatmap({ daily }: { daily: Array<{ day: string; count: number }> }): ReactNode {
  const max = Math.max(1, ...daily.map((d) => d.count))
  return (
    <div style={{ display: 'flex', gap: 2, margin: '6px 0', overflowX: 'auto' }}>
      {daily.map((d) => {
        const intensity = d.count === 0 ? 0 : 0.15 + 0.85 * (d.count / max)
        return (
          <div
            key={d.day}
            title={`${d.day}：${d.count} 次命中`}
            style={{
              width: 9,
              height: 18,
              borderRadius: 2,
              flex: '0 0 auto',
              background: d.count === 0 ? 'var(--dsw-alias-color-bg-secondary, #eee)' : `rgba(64, 158, 255, ${intensity})`,
            }}
          />
        )
      })}
    </div>
  )
}

/** Material-Design-Icon-style inline SVG (mdi path data), colored by the harness token. */
function Icon({ path, size = 15 }: { path: string; size?: number }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      style={{ flex: '0 0 auto', verticalAlign: '-2px', marginRight: 5, color: 'var(--dsw-alias-color-icon-secondary, currentColor)', opacity: 0.85 }}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

// mdi paths (Material Design Icons, Apache-2.0)
const ICON_OVERVIEW = 'M13,3V9H21V3M13,21H21V11H13M3,21H11V15H3M3,13H11V3H3V13Z'
const ICON_HEATMAP = 'M22,21H2V3H4V19H6V10H10V19H12V6H16V19H18V14H22V21Z'
const ICON_PENDING = 'M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z'
const ICON_MEMORY = 'M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z'
const ICON_RESTORE = 'M12,3A9,9 0 0,0 3,12H0L4,16L8,12H5A7,7 0 0,1 12,5A7,7 0 0,1 19,12A7,7 0 0,1 12,19C10.5,19 9.1,18.5 8,17.6L6.6,19A9,9 0 0,0 12,21A9,9 0 0,0 21,12A9,9 0 0,0 12,3Z'
const ICON_GIT = 'M6,2A2,2 0 0,1 8,4C8,4.88 7.39,5.61 6.56,5.88L7.42,9H15.5C16.34,9 17,9.66 17,10.5V12.56C17.83,12.83 18.5,13.61 18.5,14.5A2,2 0 0,1 16.5,16.5C15.61,16.5 14.83,15.83 14.56,15H9.5V16.5C9.5,17.34 8.84,18 8,18C7.16,18 6.5,17.34 6.5,16.5C6.5,15.61 7.17,14.83 8.06,14.56L7.42,11.75C6.45,11.47 5.75,10.64 5.53,9.62L4.19,4.44C3.87,4.22 3.65,3.88 3.65,3.5A2,2 0 0,1 5.65,1.5H6M8,4C8,2.9 7.1,2 6,2S4,2.9 4,4C4,4.88 4.61,5.61 5.44,5.88L6.3,9.23C7.34,9.5 8.2,10.27 8.58,11.25H11.42C11.8,10.27 12.66,9.5 13.7,9.23L14.56,5.88C13.39,5.61 12.75,4.88 12.75,4C12.75,2.9 13.65,2 14.75,2S16.75,2.9 16.75,4C16.75,4.88 16.14,5.61 15.31,5.88L14.45,9.23C13.41,9.5 12.55,10.27 12.17,11.25H9.83C9.45,10.27 8.59,9.5 7.55,9.23L6.69,5.88C7.86,5.61 8,4.88 8,4M8,18C8,16.9 7.1,16 6,16S4,16.9 4,18C4,19.1 4.9,20 6,20S8,19.1 8,18M16,14C16,15.1 16.9,16 18,16S20,15.1 20,14C20,12.9 19.1,12 18,12S16,12.9 16,14Z'

/** The memory-console tab body (better-sidebar). */
export function MnemosTab(): ReactNode {
  const stats = useJson<{ totalActive: number; pending: number; gate: { maxEntries: number } }>('/mnemos/api/stats')
  const pending = useJson<{ pending: PendingRow[] }>('/mnemos/api/pending')
  const [typeFilter, setTypeFilter] = useState('')
  const memories = useJson<{ memories: MemoryRow[] }>(`/mnemos/api/memories?scope=workspace&type=${encodeURIComponent(typeFilter)}`)
  const deleted = useJson<{ memories: MemoryRow[] }>('/mnemos/api/memories?status=deleted')
  const usage = useJson<UsageStats>('/mnemos/api/usage')
  const git = useJson<{ changed: string[] }>('/mnemos/api/git/status')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingApproval, setEditingApproval] = useState<number | null>(null)
  const [approvalDraft, setApprovalDraft] = useState('')
  const [gitView, setGitView] = useState<{ id: string; history: GitCommit[] } | null>(null)
  const [gitContent, setGitContent] = useState<{ sha: string; content: string } | null>(null)

  const refreshAll = useCallback(() => {
    stats.reload()
    pending.reload()
    memories.reload()
    deleted.reload()
    usage.reload()
    git.reload()
  }, [stats, pending, memories, deleted, usage, git])

  // Keep the console current while the panel is open.
  useEffect(() => {
    const id = setInterval(refreshAll, 30000)
    return () => clearInterval(id)
  }, [refreshAll])

  // Auto-dismiss the action notice.
  useEffect(() => {
    if (notice === null) return
    const id = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(id)
  }, [notice])

  const act = useCallback(async (path: string, body: unknown | undefined, okText: string): Promise<void> => {
    setBusy(true)
    try {
      const result = (await postJson(path, body)) as { ok?: boolean; error?: string; reason?: string }
      if (result.error !== undefined) setNotice({ kind: 'err', text: result.error })
      else if (result.ok === false) setNotice({ kind: 'err', text: result.reason ?? '操作失败' })
      else setNotice({ kind: 'ok', text: okText })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
    setBusy(false)
    refreshAll()
  }, [refreshAll])

  const distill = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = (await postJson('/mnemos/api/distill')) as { error?: string; memories?: number; rules?: number; conflicts?: number }
      if (result.error !== undefined) setNotice({ kind: 'err', text: result.error })
      else setNotice({ kind: 'ok', text: `提炼完成：${result.memories ?? 0} 条记忆 · ${result.rules ?? 0} 条规则 · ${result.conflicts ?? 0} 冲突` })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
    setBusy(false)
    refreshAll()
  }

  const startEdit = (memory: MemoryRow): void => {
    setEditingId(memory.id)
    setDraft(memory.summary)
  }

  const cleanupStale = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await fetch('/mnemos/api/cleanup?days=90')
      const data = (await res.json()) as { count: number; ids: string[] }
      if (data.count === 0) {
        setNotice({ kind: 'ok', text: '没有可清理的失效记忆' })
      } else if (window.confirm(`发现 ${data.count} 条长期未使用且未更新的记忆，将从列表清理（git 历史可恢复）。确认？`)) {
        const result = (await postJson('/mnemos/api/cleanup', { ids: data.ids })) as { removed: number }
        setNotice({ kind: 'ok', text: `已清理 ${result.removed} 条失效记忆` })
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
    setBusy(false)
    refreshAll()
  }

  const exportAll = async (): Promise<void> => {
    try {
      const res = await fetch('/mnemos/api/export')
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mnemos-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setNotice({ kind: 'ok', text: '已导出 JSON' })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const batchApprove = async (): Promise<void> => {
    if (!window.confirm('批量批准所有低风险记忆候选（工作区项目事实、高置信度）？')) return
    const result = (await postJson('/mnemos/api/approve/batch')) as { approved: number; skipped: number }
    setNotice({ kind: 'ok', text: `已批准 ${result.approved} 条，跳过 ${result.skipped} 条` })
    refreshAll()
  }

  const showGitHistory = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/mnemos/api/git/history?id=${encodeURIComponent(id)}`)
      const data = (await res.json()) as { history: GitCommit[] }
      setGitView({ id, history: data.history })
      setGitContent(null)
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const showGitContent = async (id: string, sha: string): Promise<void> => {
    try {
      const res = await fetch(`/mnemos/api/git/show?id=${encodeURIComponent(id)}&sha=${encodeURIComponent(sha)}`)
      const data = (await res.json()) as { content: string | null }
      setGitContent({ sha, content: data.content ?? '(该版本没有此记忆)' })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const rollbackTo = (id: string, sha: string): void => {
    if (!window.confirm(`回滚该记忆到 ${sha.slice(0, 8)}？当前内容会被覆盖（git 仍保留可回溯）。`)) return
    void act('/mnemos/api/git/rollback', { id, sha }, '已回滚').then(() => setGitView(null))
  }

  const usageByMemory = new Map((usage.data?.perMemory ?? []).map((u) => [u.memoryId, u]))

  const visible = (memories.data?.memories ?? [])
    .filter((m) => search.length === 0 || `${m.topic} ${m.summary}`.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 20)

  return (
    <div style={{ padding: 10, font: 'inherit', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {notice !== null ? (
        <div
          className="mnemos-notice"
          data-kind={notice.kind}
          style={{ marginBottom: 8 }}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_OVERVIEW} />概览</div>
        <div className="mnemos-intro" style={{ margin: '4px 0 8px' }}>
          {stats.data ? `${stats.data.totalActive} 条记忆 · ${stats.data.pending} 待审批 · 上限 ${stats.data.gate.maxEntries}` : stats.error ?? '加载中…'}
        </div>
        <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => { void distill() }}>
          现在提炼
        </button>
        <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => { void cleanupStale() }}>
          清理失效
        </button>
        <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => { void exportAll() }}>
          导出
        </button>
        <button className="mnemos-button" disabled={busy} onClick={refreshAll}>
          刷新
        </button>
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_PENDING} />待审批</div>
        {(pending.data?.pending ?? []).map((p) => (
          <div key={p.id} style={{ marginTop: 8 }}>
            <div className="mnemos-intro" style={{ margin: 0 }}>
              [{p.kind}] {p.payload?.topic ?? p.id} — {p.payload?.summary ?? p.payload?.text ?? ''}（by {p.proposedBy}）
              {p.kind === 'memory' && p.payload?.scope ? ` · ${p.payload.scope}/${p.payload.type}` : ''}
            </div>
            {editingApproval === p.id ? (
              <>
                <input
                  className="mnemos-input"
                  style={{ marginTop: 6 }}
                  value={approvalDraft}
                  onChange={(e) => setApprovalDraft(e.target.value)}
                  placeholder="修改后批准"
                />
                <button
                  className="mnemos-button"
                  style={{ marginRight: 6, marginTop: 6 }}
                  disabled={busy || approvalDraft.trim().length === 0}
                  onClick={() => void act('/mnemos/api/approve', { approvalId: p.id, decision: 'approve', edited: p.kind === 'rule' ? { text: approvalDraft.trim() } : { summary: approvalDraft.trim() } }, '已编辑并批准').then(() => setEditingApproval(null))}
                >
                  保存并批准
                </button>
                <button className="mnemos-button" style={{ marginTop: 6 }} onClick={() => setEditingApproval(null)}>
                  取消
                </button>
              </>
            ) : null}
            <div style={{ marginTop: 6 }}>
              <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => void act('/mnemos/api/approve', { approvalId: p.id, decision: 'approve' }, '已批准')}>
                批准
              </button>
              <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => void act('/mnemos/api/approve', { approvalId: p.id, decision: 'reject' }, '已拒绝')}>
                拒绝
              </button>
              <button
                className="mnemos-button"
                disabled={busy || p.kind !== 'memory'}
                onClick={() => { setEditingApproval(p.id); setApprovalDraft(p.payload?.summary ?? '') }}
              >
                编辑后批准
              </button>
            </div>
          </div>
        ))}
        {pending.data && pending.data.pending.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>无待审批项</div> : null}
        {pending.data && pending.data.pending.length > 0 ? (
          <button className="mnemos-button" style={{ marginTop: 8 }} disabled={busy} onClick={() => { void batchApprove() }}>
            批量批准低风险
          </button>
        ) : null}
        {pending.error ? <div className="mnemos-error">{pending.error}</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_HEATMAP} />命中热力图</div>
        {usage.data ? (
          <>
            <div className="mnemos-intro" style={{ margin: '4px 0 0' }}>
              累计 {usage.data.totalHits} 次命中 · {usage.data.distinctSessions} 个会话
            </div>
            <Heatmap daily={usage.data.daily} />
          </>
        ) : (
          <div className="mnemos-intro" style={{ margin: '4px 0 0' }}>{usage.error ?? '加载中…'}</div>
        )}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_MEMORY} />记忆</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            className="mnemos-input"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="搜索记忆…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="mnemos-input" style={{ flex: '0 0 120px' }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">全部类型</option>
            {MEMORY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {visible.length === 0 && (memories.data?.memories.length ?? 0) === 0 ? (
          <div className="mnemos-intro" style={{ margin: '8px 0 0' }}>
            还没有记忆。让模型在会话里记录项目事实（例如"用 pnpm 安装依赖"），或在设置页导入历史会话。
          </div>
        ) : null}
        {visible.length === 0 && (memories.data?.memories.length ?? 0) > 0 ? (
          <div className="mnemos-intro" style={{ margin: '8px 0 0' }}>没有匹配「{search}」的记忆。</div>
        ) : null}
        {visible.map((m) => (
          <div key={m.id} style={{ marginTop: 8 }}>
            {editingId === m.id ? (
              <>
                <input
                  className="mnemos-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="摘要"
                />
                <button className="mnemos-button" style={{ marginRight: 6, marginTop: 6 }} disabled={busy || draft.trim().length === 0} onClick={() => void act('/mnemos/api/memory/edit', { id: m.id, summary: draft.trim() }, '已保存').then(() => setEditingId(null))}>
                  保存
                </button>
                <button className="mnemos-button" style={{ marginTop: 6 }} onClick={() => setEditingId(null)}>
                  取消
                </button>
              </>
            ) : (
              <>
                <div className="mnemos-intro" style={{ margin: 0 }}>
                  {m.topic} — {m.summary}（{usageByMemory.get(m.id)?.hits ?? m.crossSessionHits} 命中
                  {usageByMemory.get(m.id)?.sessions ? ` · ${usageByMemory.get(m.id)!.sessions} 会话` : ''}）
                </div>
                <div style={{ marginTop: 6 }}>
                  <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => startEdit(m)}>
                    编辑
                  </button>
                  <button
                    className="mnemos-button"
                    style={{ marginRight: 6 }}
                    disabled={busy}
                    onClick={() => { void showGitHistory(m.id) }}
                  >
                    版本历史
                  </button>
                  <button
                    className="mnemos-button"
                    disabled={busy}
                    onClick={() => { if (window.confirm(`删除记忆「${m.topic}」？可从"已删除"区恢复。`)) void act('/mnemos/api/memory/delete', { id: m.id }, '已删除') }}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
            {gitView !== null && gitView.id === m.id ? (
              <div style={{ marginTop: 6, borderLeft: '2px solid var(--dsw-alias-color-border, #ddd)', paddingLeft: 8 }}>
                {gitView.history.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>暂无历史提交</div> : null}
                {gitView.history.map((c) => (
                  <div key={c.sha} style={{ margin: '4px 0' }}>
                    <span style={{ opacity: 0.7 }}>{c.sha.slice(0, 8)} {c.message}</span>
                    <button className="mnemos-button" style={{ marginLeft: 6 }} disabled={busy} onClick={() => { void showGitContent(m.id, c.sha) }}>查看</button>
                    <button className="mnemos-button" style={{ marginLeft: 6 }} disabled={busy} onClick={() => rollbackTo(m.id, c.sha)}>回滚</button>
                  </div>
                ))}
                {gitContent !== null ? (
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0 0', opacity: 0.8 }}>{gitContent.content}</pre>
                ) : null}
                <button className="mnemos-button" style={{ marginTop: 4 }} onClick={() => setGitView(null)}>收起</button>
              </div>
            ) : null}
          </div>
        ))}
        {memories.error ? <div className="mnemos-error">{memories.error}</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_RESTORE} />已删除（可从 git 恢复）</div>
        {(deleted.data?.memories ?? []).map((m) => (
          <div key={m.id} style={{ marginTop: 6 }}>
            <span className="mnemos-intro" style={{ margin: 0 }}>{m.topic} — {m.summary}</span>
            <button className="mnemos-button" style={{ marginLeft: 6 }} disabled={busy} onClick={() => void act('/mnemos/api/git/restore', { id: m.id }, '已恢复').then(refreshAll)}>
              恢复
            </button>
          </div>
        ))}
        {deleted.data && deleted.data.memories.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>无已删除记忆</div> : null}
        {deleted.error ? <div className="mnemos-error">{deleted.error}</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}> <Icon path={ICON_GIT} />git 同步</div>
        <div className="mnemos-intro" style={{ margin: '4px 0 6px' }}>
          {git.data ? `${git.data.changed.length} 未提交变更` : git.error ?? '加载中…'}
        </div>
        <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => void act('/mnemos/api/git/pull', undefined, '已拉取')}>pull</button>
        <button className="mnemos-button" style={{ marginRight: 6 }} disabled={busy} onClick={() => void act('/mnemos/api/git/push', undefined, '已推送')}>push</button>
        <button className="mnemos-button" disabled={busy} onClick={() => void act('/mnemos/api/git/backup', { out: '/tmp/mnemos-backup.bundle' }, '备份已生成')}>备份</button>
      </div>
    </div>
  )
}

/** Structural face of the settings-scope service (`ctx.settingsScope.bind`). */
interface SettingsScopeLike {
  getSnapshot(): {
    status: string
    value: Record<string, unknown> | undefined
    user: unknown
    writable: boolean
    revision?: number
  }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** One editable field of the mnemos settings page. */
interface MnemosField {
  key: string
  kind: 'string' | 'number' | 'boolean' | 'stringList'
  label: string
  hint?: string
  group?: string
}

const FIELDS: MnemosField[] = [
  { key: 'enabled', kind: 'boolean', label: '插件总开关', hint: '关 = 注入、提炼、回填、同步全部静默', group: '开关' },
  { key: 'injectionEnabled', kind: 'boolean', label: '跨会话记忆注入', hint: 'agent/pre-step 注入记忆投影', group: '开关' },
  { key: 'sensitivityCheckEnabled', kind: 'boolean', label: '敏感内容检测', group: '开关' },
  { key: 'dbPath', kind: 'string', label: 'SQLite 数据库文件路径', hint: '需重启生效', group: '存储' },
  { key: 'maxEntries', kind: 'number', label: '记忆条目上限', group: '门禁' },
  { key: 'maxBytesPerEntry', kind: 'number', label: '单条记忆字节上限', group: '门禁' },
  { key: 'autoApprove', kind: 'boolean', label: '自动放行高置信度项目事实', group: '门禁' },
  { key: 'autoApproveConfidence', kind: 'number', label: '自动放行置信度阈值', group: '门禁' },
  { key: 'allowModelGlobalWrite', kind: 'boolean', label: '允许模型直接写全局记忆', group: '门禁' },
  { key: 'blacklist', kind: 'stringList', label: '拉黑写入者', hint: '逗号分隔', group: '门禁' },
  { key: 'defaultScope', kind: 'string', label: '默认作用域', hint: '提炼/导入/回填的默认作用域', group: '门禁' },
  { key: 'injectLimit', kind: 'number', label: '每轮注入记忆条数上限', group: '注入' },
  { key: 'injectMinHits', kind: 'number', label: '自动注入最低跨会话命中次数', group: '注入' },
  { key: 'injectMaxBytes', kind: 'number', label: '每轮热层注入字节预算', group: '注入' },
  { key: 'rulesInjectEnabled', kind: 'boolean', label: '向模型注入已批准规则', group: '注入' },
  { key: 'sessionLogDirs', kind: 'stringList', label: '会话日志扫描目录', hint: '逗号分隔', group: '导入' },
  { key: 'backfillEnabled', kind: 'boolean', label: '启动时回填历史会话日志', group: '导入' },
  { key: 'importCaller', kind: 'string', label: '导入写入方', hint: 'human / plugin', group: '导入' },
  { key: 'skillsDir', kind: 'string', label: '规则技能文件目录', group: '导入' },
  { key: 'llmProvider', kind: 'string', label: '提炼用 LLM provider', hint: '留空用 DSH 默认', group: '提炼' },
  { key: 'llmModel', kind: 'string', label: '提炼用 LLM 模型', hint: '留空用 DSH 默认', group: '提炼' },
  { key: 'distillAuto', kind: 'boolean', label: '自动提炼', hint: '开 = 每 N 次用户输入自动提炼；关 = 纯手动按钮', group: '提炼' },
  { key: 'distillEveryNTurns', kind: 'number', label: '自动提炼间隔（次用户输入）', group: '提炼' },
  { key: 'distillWindow', kind: 'number', label: '单次提炼缓冲消息数', group: '提炼' },
  { key: 'gitVersioning', kind: 'boolean', label: 'git 版本管理', group: 'git' },
  { key: 'gitBackend', kind: 'string', label: 'git 后端', hint: 'isomorphic / system', group: 'git' },
  { key: 'gitRemoteName', kind: 'string', label: 'git 远程名', group: 'git' },
  { key: 'gitRemoteUrl', kind: 'string', label: 'git 远程 URL', hint: '保存后即重定向 origin', group: 'git' },
  { key: 'memoryRepoDir', kind: 'string', label: 'git 记忆仓库目录', hint: '需重启生效', group: 'git' },
  { key: 'syncEnabled', kind: 'boolean', label: '自动跨机同步', group: 'git' },
  { key: 'syncIntervalMinutes', kind: 'number', label: '自动同步间隔（分钟）', group: 'git' },
]

/** `/mnemos/api/models` answer: DSH-configured providers/models. */
interface ModelsAnswer {
  default: { provider: string; model: string } | null
  providers: Array<{ id: string; name: string; models: string[] }>
}

/** `/mnemos/api/import/preview` answer. */
interface PreviewFile {
  path: string
  source: string
  messages: number
}
interface PreviewSample {
  path: string
  role: string
  text: string
}
interface ImportPreview {
  files: PreviewFile[]
  samples: PreviewSample[]
  totalFiles: number
  totalMessages: number
  totalSamples: number
  errors: string[]
}

/** `/mnemos/api/import/run` answer. */
interface ImportRunStats {
  ingested: number
  hint?: string
  errors: string[]
}

/** One control; commits immediately on change (live settings re-apply). */
function FieldControl({
  field,
  value,
  id,
  disabled,
  options,
  onSet,
}: {
  field: MnemosField
  value: unknown
  id: string
  disabled: boolean
  options?: string[]
  onSet: (value: unknown) => void
}): ReactNode {
  if (options !== undefined) {
    const selected = typeof value === 'string' ? value : ''
    return (
      <select
        id={id}
        className="mnemos-input"
        disabled={disabled}
        value={selected}
        onChange={(e) => onSet(e.target.value)}
      >
        <option value="">（使用 DSH 默认）</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }
  switch (field.kind) {
    case 'boolean':
      return (
        <input
          id={id}
          className="mnemos-check"
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onSet(e.target.checked)}
        />
      )
    case 'number':
      return (
        <input
          id={id}
          className="mnemos-input"
          type="number"
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onSet(n)
          }}
        />
      )
    case 'stringList':
      return (
        <input
          id={id}
          className="mnemos-input"
          value={Array.isArray(value) ? value.join(', ') : ''}
          disabled={disabled}
          onChange={(e) =>
            onSet(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )}
        />
      )
    default:
      return (
        <input
          id={id}
          className="mnemos-input"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onSet(e.target.value)}
        />
      )
  }
}

/** The import-history area inside the settings page. */
const DEFAULT_SESSION_DIR = '~/.dsh/sessions'

function MnemosImportSection(): ReactNode {
  const [source, setSource] = useState('dsh')
  const [dir, setDir] = useState(DEFAULT_SESSION_DIR)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [run, setRun] = useState<ImportRunStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const scan = async (): Promise<void> => {
    if (dir.length === 0) return
    setBusy(true)
    setError(null)
    setRun(null)
    try {
      const res = await fetch(`/mnemos/api/import/preview?dir=${encodeURIComponent(dir)}`)
      const data = (await res.json()) as ImportPreview & { error?: string }
      if (data.error !== undefined) setError(data.error)
      else setPreview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (): Promise<void> => {
    if (dir.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/mnemos/api/import/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
      })
      const data = (await res.json()) as ImportRunStats & { error?: string }
      if (data.error !== undefined) setError(data.error)
      else setRun(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mnemos-section">
      <h3 className="mnemos-heading">导入历史会话</h3>
      <p className="mnemos-intro">
        扫描目录里的会话记录（DSH 历史 / Claude Code / Codex / ChatGPT 自动识别），预览候选后导入。导入走与命令相同的门禁，重复与敏感内容会被跳过或拒绝。
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select className="mnemos-input" style={{ flex: '0 0 150px' }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="dsh">DSH 历史</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="auto">自动检测</option>
        </select>
        <input
          className="mnemos-input"
          style={{ flex: 1 }}
          placeholder={source === 'dsh' ? '~/.dsh/sessions' : '输入会话日志目录路径'}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button className="mnemos-button" disabled={dir.length === 0 || busy} onClick={() => { void scan() }}>
          扫描预览
        </button>
        <button className="mnemos-button" disabled={preview === null || busy} onClick={() => { void doImport() }}>
          导入
        </button>
        <button
          className="mnemos-button"
          disabled={dir === DEFAULT_SESSION_DIR}
          title="填回 DSH 默认会话日志目录"
          onClick={() => { setDir(DEFAULT_SESSION_DIR); setPreview(null); setRun(null) }}
        >
          用默认
        </button>
      </div>
      {error !== null ? <p className="mnemos-error">{error}</p> : null}
      {preview !== null && run === null ? (
        <>
          <p className="mnemos-note">
            扫描到 {preview.totalFiles} 个文件 / {preview.totalMessages} 条消息
            {preview.errors.length > 0 ? `，${preview.errors.length} 个文件失败` : ''}。确认后点"导入"（消息加入提炼缓冲，再点"现在提炼"生成记忆）。
          </p>
          <details style={{ marginTop: 6 }}>
            <summary className="mnemos-note" style={{ cursor: 'pointer' }}>
              查看 {preview.files.length} 个文件明细
            </summary>
            {preview.files.map((f) => (
              <div key={f.path} className="mnemos-intro" style={{ margin: '4px 0 0', fontSize: 12 }}>
                {f.source} · {f.path.split('/').slice(-2).join('/')} — {f.messages} 消息
              </div>
            ))}
          </details>
          <div style={{ marginTop: 8 }}>
            <div className="mnemos-note" style={{ marginBottom: 4 }}>消息抽样（前几条）：</div>
            {preview.samples.map((s, i) => (
              <div key={i} className="mnemos-intro" style={{ margin: '4px 0 0', fontSize: 12 }}>
                [{s.role}] {s.text}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {run !== null ? (
        <p className="mnemos-note">
          已把 {run.ingested} 条消息加入提炼缓冲。
          {run.hint !== undefined ? ` ${run.hint}。` : ''}
          {run.errors !== undefined && run.errors.length > 0 ? `${run.errors.length} 个文件失败` : ''}
        </p>
      ) : null}
    </div>
  )
}

/** The top-level settings page (settings.section id `mnemos`). */
export function MnemosSettingsSection({ scope }: { scope: SettingsScopeLike }): ReactNode {
  const snapshot = useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )
  const models = useJson<ModelsAnswer>('/mnemos/api/models')
  if (snapshot.status === 'loading') {
    return (
      <div className="mnemos-section">
        <h2 className="mnemos-heading">dsh-mnemos</h2>
        <p className="mnemos-intro">正在加载设置…</p>
      </div>
    )
  }
  if (snapshot.status === 'unavailable') {
    return (
      <div className="mnemos-section">
        <h2 className="mnemos-heading">dsh-mnemos</h2>
        <p className="mnemos-intro">
          mnemos 设置命名空间尚未暴露：Host 未注册该命名空间，或连接处于内存模式。请确认 dsh-mnemos 已加载（`dsh plugin add dsh-mnemos`），并刷新页面。
        </p>
      </div>
    )
  }
  const value = snapshot.value ?? {}
  const user = (snapshot.user ?? {}) as Record<string, unknown>
  const writable = snapshot.writable
  const providers = models.data?.providers ?? []
  const selectedProvider = (value['llmProvider'] as string | undefined) ?? models.data?.default?.provider
  const providerOptions = providers.map((p) => p.id)
  const modelOptions = providers.find((p) => p.id === selectedProvider)?.models ?? []
  return (
    <div className="mnemos-section">
      <h2 className="mnemos-heading">dsh-mnemos</h2>
      <p className="mnemos-intro">
        跨会话记忆：写入门禁、自进化提炼、git 版本化与跨机同步。改动即时生效（结构字段需重启）。提炼复用 DSH 已配置的模型，无需单独 API key。
      </p>
      {models.data?.default ? (
        <p className="mnemos-note">DSH 当前默认模型：{models.data.default.provider}/{models.data.default.model}</p>
      ) : null}
      {!writable ? <p className="mnemos-note">当前设置文档只读。</p> : null}
      <div className="mnemos-fields">
        {FIELDS.map((field, index) => {
          const groupChanged = index === 0 || FIELDS[index - 1]?.group !== field.group
          const options = field.key === 'llmProvider'
            ? providerOptions
            : field.key === 'llmModel'
              ? modelOptions
              : field.key === 'defaultScope'
                ? ['workspace', 'global']
                : undefined
          return (
            <div key={field.key}>
              {groupChanged ? <h3 className="mnemos-group">{field.group}</h3> : null}
              <div className="mnemos-field">
                <div className="mnemos-head">
                  <label className="mnemos-label" htmlFor={`mnemos-${field.key}`}>{field.label}</label>
                  {user[field.key] !== undefined ? (
                    <span className="mnemos-badges">
                      <span className="mnemos-badge">已覆盖</span>
                      <button
                        type="button"
                        className="mnemos-reset"
                        disabled={!writable}
                        onClick={() => { void scope.unset(field.key) }}
                      >
                        重置
                      </button>
                    </span>
                  ) : null}
                </div>
                <FieldControl
                  field={field}
                  value={value[field.key]}
                  id={`mnemos-${field.key}`}
                  disabled={!writable}
                  options={options}
                  onSet={(v) => { void scope.set(field.key, v) }}
                />
                {field.hint ? <p className="mnemos-hint">{field.hint}</p> : null}
              </div>
            </div>
          )
        })}
      </div>
      <MnemosImportSection />
    </div>
  )
}

/** Cordis client plugin face (browser half). */
export const name = 'dsh-mnemos'

/** Catches a settings-page render error so it cannot blank the whole settings panel. */
class SettingsBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: string | null } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="mnemos-section">
          <h2 className="mnemos-heading">dsh-mnemos</h2>
          <p className="mnemos-error">设置页渲染出错：{this.state.error}</p>
        </div>
      )
    }
    return this.props.children
  }
}

/** Services the browser half needs: the sidebar registry, the slot system and the settings-scope mirror. */
export const inject = ['betterSidebar', 'slots', 'settingsScope']

/**
 * Register the settings page and the memory-console tab.
 * @param ctx - the browser cordis context (services declared by inject).
 */
export function apply(ctx: unknown): void {
  const c = ctx as {
    betterSidebar: { registerTab(tab: unknown): () => void }
    slots: {
      inject(name: string, cb: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    settingsScope: { bind(spec: { namespace: string }): SettingsScopeLike }
  }
  const styleId = 'dsh-mnemos-styles'
  if (typeof document !== 'undefined') {
    let el = document.getElementById(styleId) as HTMLStyleElement | null
    if (el === null) {
      el = document.createElement('style')
      el.id = styleId
      el.textContent = css
      document.head.appendChild(el)
    }
  }
  c.betterSidebar.registerTab({
    id: 'mnemos:memory',
    title: '记忆',
    single: true,
    component: MnemosTab,
  })
  c.slots.inject('settings.section', () => {
    const scope = c.settingsScope.bind({ namespace: 'mnemos' })
    return c.slots.register(
      {
        name: 'settings.section',
        id: 'mnemos',
        order: 25,
        label: 'dsh-mnemos',
      },
      () => (
        <SettingsBoundary>
          <MnemosSettingsSection scope={scope} />
        </SettingsBoundary>
      ),
    )
  })
}
