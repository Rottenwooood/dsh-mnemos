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
  { key: 'llmProvider', kind: 'string', label: '提炼用 LLM provider', hint: '留空用 DSH 默认' },
  { key: 'llmModel', kind: 'string', label: '提炼用 LLM 模型', hint: '留空用 DSH 默认' },
]

/** `/mnemos/api/models` answer: DSH-configured providers/models. */
interface ModelsAnswer {
  default: { provider: string; model: string } | null
  providers: Array<{ id: string; name: string; models: string[] }>
}

/** `/mnemos/api/import/preview` answer. */
interface ImportPreview {
  files: Array<{ path: string; source: string; messages: number; candidates: number }>
  totalFiles: number
  totalMessages: number
  totalCandidates: number
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
function MnemosImportSection(): ReactNode {
  const [source, setSource] = useState('dsh')
  const [dir, setDir] = useState('')
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
      <div>
        <button className="mnemos-button" disabled={dir.length === 0 || busy} onClick={() => { void scan() }}>
          扫描预览
        </button>
        <button className="mnemos-button" style={{ marginLeft: 8 }} disabled={preview === null || busy} onClick={() => { void doImport() }}>
          导入
        </button>
      </div>
      {error !== null ? <p className="mnemos-error">{error}</p> : null}
      {preview !== null && run === null ? (
        <p className="mnemos-note">
          扫描到 {preview.totalFiles} 个文件 / {preview.totalMessages} 条消息 / {preview.totalCandidates} 个候选
          {preview.errors.length > 0 ? `，${preview.errors.length} 个文件失败` : ''}。确认后点"导入"。
        </p>
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
        {FIELDS.map((field) => {
          const options = field.key === 'llmProvider'
            ? providerOptions
            : field.key === 'llmModel'
              ? modelOptions
              : undefined
          return (
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
                options={options}
                onSet={(v) => { void scope.set(field.key, v) }}
              />
              {field.hint ? <p className="mnemos-hint">{field.hint}</p> : null}
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
