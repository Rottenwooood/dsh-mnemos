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
  payload?: { topic?: string; summary?: string; scope?: string; type?: string; confidence?: number }
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

/** The memory-console tab body (better-sidebar). */
export function MnemosTab(): ReactNode {
  const stats = useJson<{ totalActive: number; pending: number; gate: { maxEntries: number } }>('/mnemos/api/stats')
  const pending = useJson<{ pending: PendingRow[] }>('/mnemos/api/pending')
  const [typeFilter, setTypeFilter] = useState('')
  const memories = useJson<{ memories: MemoryRow[] }>(`/mnemos/api/memories?scope=workspace&type=${encodeURIComponent(typeFilter)}`)
  const deleted = useJson<{ memories: MemoryRow[] }>('/mnemos/api/memories?status=deleted')
  const usage = useJson<UsageStats>('/mnemos/api/usage')
  const history = useJson<{ state: string; count: number; items: PendingRow[] }>('/mnemos/api/history?state=rejected')
  const git = useJson<{ changed: string[] }>('/mnemos/api/git/status')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingApproval, setEditingApproval] = useState<number | null>(null)
  const [approvalDraft, setApprovalDraft] = useState('')
  const [historySource, setHistorySource] = useState('')
  const [gitView, setGitView] = useState<{ id: string; history: GitCommit[] } | null>(null)
  const [gitContent, setGitContent] = useState<{ sha: string; content: string } | null>(null)

  const refreshAll = useCallback(() => {
    stats.reload()
    pending.reload()
    memories.reload()
    deleted.reload()
    usage.reload()
    history.reload()
    git.reload()
  }, [stats, pending, memories, deleted, usage, history, git])

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
    <div style={{ padding: 10, font: 'inherit' }}>
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>概览</div>
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>待审批</div>
        {(pending.data?.pending ?? []).map((p) => (
          <div key={p.id} style={{ marginTop: 8 }}>
            <div className="mnemos-intro" style={{ margin: 0 }}>
              [{p.kind}] {p.payload?.topic ?? p.id} — {p.payload?.summary ?? ''}（by {p.proposedBy}）
              {p.kind === 'memory' && p.payload?.scope ? ` · ${p.payload.scope}/${p.payload.type}` : ''}
            </div>
            {editingApproval === p.id ? (
              <>
                <input
                  className="mnemos-input"
                  style={{ marginTop: 6 }}
                  value={approvalDraft}
                  onChange={(e) => setApprovalDraft(e.target.value)}
                  placeholder="修改摘要后批准"
                />
                <button
                  className="mnemos-button"
                  style={{ marginRight: 6, marginTop: 6 }}
                  disabled={busy || approvalDraft.trim().length === 0}
                  onClick={() => void act('/mnemos/api/approve', { approvalId: p.id, decision: 'approve', edited: { summary: approvalDraft.trim() } }, '已编辑并批准').then(() => setEditingApproval(null))}
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>命中热力图</div>
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>记忆</div>
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>已删除（可从 git 恢复）</div>
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
        <div className="mnemos-heading" style={{ fontSize: 13 }}>被拒历史</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            className="mnemos-input"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="按来源（proposedBy）过滤…"
            value={historySource}
            onChange={(e) => setHistorySource(e.target.value)}
          />
        </div>
        {(history.data?.items ?? [])
          .filter((r) => historySource.length === 0 || r.proposedBy.includes(historySource))
          .slice(0, 20)
          .map((r) => (
            <div key={r.id} className="mnemos-intro" style={{ margin: '6px 0 0' }}>
              [{r.kind}] {r.payload?.topic ?? r.id} — {r.payload?.summary ?? ''}（by {r.proposedBy}）
            </div>
          ))}
        {history.data && history.data.items.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>无被拒记录</div> : null}
        {history.error ? <div className="mnemos-error">{history.error}</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}>git 同步</div>
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
  { key: 'distillAuto', kind: 'boolean', label: '自动提炼', hint: '关 = 纯手动按钮', group: '提炼' },
  { key: 'distillIntervalMinutes', kind: 'number', label: '定时提炼间隔（分钟）', group: '提炼' },
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
  candidates: number
  duplicates: number
}
interface PreviewCandidate {
  path: string
  signal: string
  type: string
  topic: string
  summary: string
  duplicate: { id: string; similarity: number } | null
}
interface ImportPreview {
  files: PreviewFile[]
  candidates: PreviewCandidate[]
  totalFiles: number
  totalMessages: number
  totalCandidates: number
  totalDuplicates: number
  errors: string[]
}

/** `/mnemos/api/import/run` answer. */
interface ImportRunStats {
  parsedMessages: number
  candidates: number
  committed: number
  proposed: number
  denied: number
  duplicateSkipped: number
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
            扫描到 {preview.totalFiles} 个文件 / {preview.totalMessages} 条消息 / {preview.totalCandidates} 个候选
            {preview.totalDuplicates > 0 ? `，其中 ${preview.totalDuplicates} 个已存在（导入时跳过）` : ''}
            {preview.errors.length > 0 ? `，${preview.errors.length} 个文件失败` : ''}。确认后点"导入"。
          </p>
          <details style={{ marginTop: 6 }}>
            <summary className="mnemos-note" style={{ cursor: 'pointer' }}>
              查看 {preview.files.length} 个文件明细
            </summary>
            {preview.files.map((f) => (
              <div key={f.path} className="mnemos-intro" style={{ margin: '4px 0 0', fontSize: 12 }}>
                {f.source} · {f.path.split('/').slice(-2).join('/')} — {f.messages} 消息 / {f.candidates} 候选
                {f.duplicates > 0 ? ` / ${f.duplicates} 已存在` : ''}
              </div>
            ))}
          </details>
          <div style={{ marginTop: 8 }}>
            <div className="mnemos-note" style={{ marginBottom: 4 }}>候选明细（灰色 = 已存在，导入跳过）：</div>
            {preview.candidates.map((c, i) => (
              <div key={i} style={{ margin: '4px 0 0', fontSize: 12 }}>
                {c.duplicate !== null ? (
                  <span className="mnemos-intro" style={{ opacity: 0.5 }}>
                    [已存在{typeof c.duplicate.similarity === 'number' && c.duplicate.similarity < 1 ? ` ${Math.round(c.duplicate.similarity * 100)}%` : ''}] {c.type} · {c.topic} — {c.summary}
                  </span>
                ) : (
                  <span className="mnemos-intro">
                    [{c.signal}] {c.type} · {c.topic} — {c.summary}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {run !== null ? (
        <p className="mnemos-note">
          导入完成：{run.committed} 提交 / {run.proposed} 待审批 / {run.denied} 拒绝 / {run.duplicateSkipped} 重复跳过
          {run.errors !== undefined && run.errors.length > 0 ? `，${run.errors.length} 个文件失败` : ''}
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
