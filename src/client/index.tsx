/**
 * Browser half of dsh-mnemos (M5): registers the memory-console tab on the
 * better-sidebar service (`ctx.betterSidebar.registerTab`) and the settings
 * card on the shared Plugins settings section (`settings.plugin.item` keyed
 * by the `mnemos` namespace), so the plugin's settings page renders in the
 * browser exactly when the Host serves the namespace.
 *
 * The tab drives the host through the plugin's own `/mnemos/api/*` routes
 * (every action still goes through the MemoryService gate and GitStore). The
 * settings card reads and writes the `mnemos` namespace through the shared
 * settings-scope service (`ctx.settingsScope.bind`), so changes land in the
 * Host document and re-apply live.
 *
 * Built with `pnpm run build:client` (esbuild) into `lib/client.js`; the
 * module system serves it at `/plugins/dsh-mnemos/client.js`. Only `react`
 * (a platform baseline external) is imported at runtime; all DSH types here
 * are structural.
 */

import { useState, useEffect, useCallback, useSyncExternalStore, type ReactNode } from 'react'

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

const row: Record<string, React.CSSProperties> = {
  section: { marginBottom: 10, border: '1px solid var(--dsw-border, #444)', borderRadius: 6, padding: 8 },
  title: { fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--dsw-text, #ddd)' },
  text: { fontSize: 12, lineHeight: 1.5, margin: '2px 0', color: 'var(--dsw-text-soft, #bbb)' },
  button: { marginRight: 6, marginTop: 4, fontSize: 12, padding: '2px 8px' },
  input: { width: '100%', boxSizing: 'border-box', marginBottom: 6, fontSize: 12, padding: 4 },
  field: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, fontSize: 12 },
  fieldLabel: { flex: '0 0 200px', color: 'var(--dsw-text, #ddd)' },
  fieldInput: { flex: 1, minWidth: 0, fontSize: 12, padding: 3 },
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

/** Structural face of the settings-scope service (`ctx.settingsScope.bind`). */
interface SettingsScopeLike {
  getSnapshot(): {
    status: string
    value: Record<string, unknown> | undefined
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
}

const FIELDS: MnemosField[] = [
  { key: 'dbPath', kind: 'string', label: 'SQLite 数据库文件路径（需重启生效）' },
  { key: 'maxEntries', kind: 'number', label: '记忆条目上限' },
  { key: 'maxBytesPerEntry', kind: 'number', label: '单条记忆字节上限' },
  { key: 'autoApprove', kind: 'boolean', label: '自动放行高置信度项目事实' },
  { key: 'autoApproveConfidence', kind: 'number', label: '自动放行置信度阈值' },
  { key: 'allowModelGlobalWrite', kind: 'boolean', label: '允许模型直接写全局记忆' },
  { key: 'blacklist', kind: 'stringList', label: '拉黑写入者（逗号分隔）' },
  { key: 'injectLimit', kind: 'number', label: '每轮注入记忆条数上限' },
  { key: 'injectMinHits', kind: 'number', label: '自动注入最低跨会话命中次数' },
  { key: 'injectMaxBytes', kind: 'number', label: '每轮热层注入字节预算' },
  { key: 'sessionLogDirs', kind: 'stringList', label: '会话日志扫描目录（逗号分隔）' },
  { key: 'backfillEnabled', kind: 'boolean', label: '启动时回填历史会话日志' },
  { key: 'importCaller', kind: 'string', label: '导入写入方（human/plugin）' },
  { key: 'skillsDir', kind: 'string', label: '规则技能文件目录' },
  { key: 'rulesInjectEnabled', kind: 'boolean', label: '向模型注入已批准规则' },
  { key: 'distillAuto', kind: 'boolean', label: '自动提炼' },
  { key: 'distillIntervalMinutes', kind: 'number', label: '定时提炼间隔（分钟）' },
  { key: 'distillWindow', kind: 'number', label: '单次提炼缓冲消息数' },
  { key: 'memoryRepoDir', kind: 'string', label: 'git 记忆仓库目录（需重启生效）' },
  { key: 'gitVersioning', kind: 'boolean', label: 'git 版本管理' },
  { key: 'gitRemoteName', kind: 'string', label: 'git 远程名' },
  { key: 'syncEnabled', kind: 'boolean', label: '自动跨机同步' },
  { key: 'syncIntervalMinutes', kind: 'number', label: '自动同步间隔（分钟）' },
  { key: 'gitBackend', kind: 'string', label: 'git 后端（isomorphic/system）' },
]

/** The settings card for the mnemos namespace (settings.plugin.item). */
export function MnemosSettingsCard({ scope }: { scope: SettingsScopeLike }): ReactNode {
  const snapshot = useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )
  if (snapshot.status !== 'ready') {
    return null
  }
  const value = snapshot.value ?? {}
  const writable = snapshot.writable
  return (
    <div style={{ padding: 12 }}>
      {!writable ? <p style={row.text}>当前文档只读</p> : null}
      {FIELDS.map((field) => (
        <div key={field.key} style={row.field}>
          <label style={row.fieldLabel}>{field.label}</label>
          <FieldControl field={field} value={value[field.key]} disabled={!writable} onSet={(v) => { void scope.set(field.key, v) }} />
        </div>
      ))}
    </div>
  )
}

/** One control; commits immediately on change (live settings re-apply). */
function FieldControl({
  field,
  value,
  disabled,
  onSet,
}: {
  field: MnemosField
  value: unknown
  disabled: boolean
  onSet: (value: unknown) => void
}): ReactNode {
  switch (field.kind) {
    case 'boolean':
      return (
        <input
          style={{ margin: 0 }}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onSet(e.target.checked)}
        />
      )
    case 'number':
      return (
        <input
          style={row.fieldInput}
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
          style={row.fieldInput}
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
          style={row.fieldInput}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onSet(e.target.value)}
        />
      )
  }
}

/** Cordis client plugin face (browser half). */
export const name = 'dsh-mnemos'

/** Services the browser half needs: the sidebar registry, the slot system and the settings-scope mirror. */
export const inject = ['betterSidebar', 'slots', 'settingsScope']

/**
 * Register the memory-console tab and the mnemos settings card.
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
  c.betterSidebar.registerTab({
    id: 'mnemos:memory',
    title: '记忆',
    single: true,
    component: MnemosTab,
  })
  c.slots.inject('settings.plugin.item', () => {
    const scope = c.settingsScope.bind({ namespace: 'mnemos' })
    return c.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'mnemos',
      },
      () => <MnemosSettingsCard scope={scope} />,
    )
  })
}
