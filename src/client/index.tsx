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

import { useState, useEffect, useCallback, useSyncExternalStore, type ReactNode } from 'react'
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

/** The memory-console tab body (better-sidebar). */
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
    <div style={{ padding: 10, font: 'inherit' }}>
      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}>概览</div>
        <div className="mnemos-intro" style={{ margin: '4px 0 8px' }}>
          {stats.data ? `${stats.data.totalActive} 条记忆 · ${stats.data.pending} 待审批 · 上限 ${stats.data.gate.maxEntries}` : stats.error ?? '加载中…'}
        </div>
        <button className="mnemos-button" onClick={() => act('/mnemos/api/distill')}>现在提炼</button>
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}>待审批</div>
        {(pending.data?.pending ?? []).map((p) => (
          <div key={p.id} style={{ marginTop: 8 }}>
            <div className="mnemos-intro" style={{ margin: 0 }}>
              [{p.kind}] {p.payload?.topic ?? p.id} — {p.payload?.summary ?? ''}（by {p.proposedBy}）
            </div>
            <button className="mnemos-button" style={{ marginRight: 6, marginTop: 6 }} onClick={() => act('/mnemos/api/approve', { approvalId: p.id, decision: 'approve' })}>
              批准
            </button>
            <button className="mnemos-button" style={{ marginTop: 6 }} onClick={() => act('/mnemos/api/approve', { approvalId: p.id, decision: 'reject' })}>
              拒绝
            </button>
          </div>
        ))}
        {pending.data && pending.data.pending.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>无待审批项</div> : null}
        {pending.error ? <div className="mnemos-error">{pending.error}</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}>记忆</div>
        <input
          className="mnemos-input"
          style={{ marginTop: 6 }}
          placeholder="搜索记忆…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(memories.data?.memories ?? [])
          .filter((m) => search.length === 0 || `${m.topic} ${m.summary}`.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 20)
          .map((m) => (
            <div key={m.id} className="mnemos-intro" style={{ margin: '6px 0 0' }}>
              {m.topic} — {m.summary}（命中 {m.crossSessionHits}）
            </div>
          ))}
        {memories.data && memories.data.memories.length === 0 ? <div className="mnemos-intro" style={{ margin: 0 }}>暂无记忆</div> : null}
      </div>

      <div className="mnemos-section" style={{ padding: 0 }}>
        <div className="mnemos-heading" style={{ fontSize: 13 }}>git 同步</div>
        <div className="mnemos-intro" style={{ margin: '4px 0 6px' }}>
          {git.data ? `${git.data.changed.length} 未提交变更` : git.error ?? '加载中…'}
        </div>
        <button className="mnemos-button" style={{ marginRight: 6 }} onClick={() => act('/mnemos/api/git/pull')}>pull</button>
        <button className="mnemos-button" style={{ marginRight: 6 }} onClick={() => act('/mnemos/api/git/push')}>push</button>
        <button className="mnemos-button" onClick={() => act('/mnemos/api/git/backup', { out: '/tmp/mnemos-backup.bundle' })}>备份</button>
      </div>

      {message ? <div className="mnemos-note">{message}</div> : null}
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
}

const FIELDS: MnemosField[] = [
  { key: 'dbPath', kind: 'string', label: 'SQLite 数据库文件路径', hint: '需重启生效' },
  { key: 'maxEntries', kind: 'number', label: '记忆条目上限' },
  { key: 'maxBytesPerEntry', kind: 'number', label: '单条记忆字节上限' },
  { key: 'autoApprove', kind: 'boolean', label: '自动放行高置信度项目事实' },
  { key: 'autoApproveConfidence', kind: 'number', label: '自动放行置信度阈值' },
  { key: 'allowModelGlobalWrite', kind: 'boolean', label: '允许模型直接写全局记忆' },
  { key: 'blacklist', kind: 'stringList', label: '拉黑写入者', hint: '逗号分隔' },
  { key: 'injectLimit', kind: 'number', label: '每轮注入记忆条数上限' },
  { key: 'injectMinHits', kind: 'number', label: '自动注入最低跨会话命中次数' },
  { key: 'injectMaxBytes', kind: 'number', label: '每轮热层注入字节预算' },
  { key: 'sessionLogDirs', kind: 'stringList', label: '会话日志扫描目录', hint: '逗号分隔' },
  { key: 'backfillEnabled', kind: 'boolean', label: '启动时回填历史会话日志' },
  { key: 'importCaller', kind: 'string', label: '导入写入方', hint: 'human / plugin' },
  { key: 'skillsDir', kind: 'string', label: '规则技能文件目录' },
  { key: 'rulesInjectEnabled', kind: 'boolean', label: '向模型注入已批准规则' },
  { key: 'distillAuto', kind: 'boolean', label: '自动提炼', hint: '关 = 纯手动按钮' },
  { key: 'distillIntervalMinutes', kind: 'number', label: '定时提炼间隔（分钟）' },
  { key: 'distillWindow', kind: 'number', label: '单次提炼缓冲消息数' },
  { key: 'memoryRepoDir', kind: 'string', label: 'git 记忆仓库目录', hint: '需重启生效' },
  { key: 'gitVersioning', kind: 'boolean', label: 'git 版本管理' },
  { key: 'gitRemoteName', kind: 'string', label: 'git 远程名' },
  { key: 'syncEnabled', kind: 'boolean', label: '自动跨机同步' },
  { key: 'syncIntervalMinutes', kind: 'number', label: '自动同步间隔（分钟）' },
  { key: 'gitBackend', kind: 'string', label: 'git 后端', hint: 'isomorphic / system' },
]

/** One control; commits immediately on change (live settings re-apply). */
function FieldControl({
  field,
  value,
  id,
  disabled,
  onSet,
}: {
  field: MnemosField
  value: unknown
  id: string
  disabled: boolean
  onSet: (value: unknown) => void
}): ReactNode {
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

/** The top-level settings page (settings.section id `mnemos`). */
export function MnemosSettingsSection({ scope }: { scope: SettingsScopeLike }): ReactNode {
  const snapshot = useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )
  if (snapshot.status !== 'ready') {
    return null
  }
  const value = snapshot.value ?? {}
  const user = (snapshot.user ?? {}) as Record<string, unknown>
  const writable = snapshot.writable
  return (
    <div className="mnemos-section">
      <h2 className="mnemos-heading">dsh-mnemos</h2>
      <p className="mnemos-intro">
        跨会话记忆：写入门禁、自进化提炼、git 版本化与跨机同步。改动即时生效（结构字段需重启）。
      </p>
      {!writable ? <p className="mnemos-note">当前设置文档只读。</p> : null}
      <div className="mnemos-fields">
        {FIELDS.map((field) => (
          <div key={field.key} className="mnemos-field">
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
              onSet={(v) => { void scope.set(field.key, v) }}
            />
            {field.hint ? <p className="mnemos-hint">{field.hint}</p> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Cordis client plugin face (browser half). */
export const name = 'dsh-mnemos'

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
      () => <MnemosSettingsSection scope={scope} />,
    )
  })
}
