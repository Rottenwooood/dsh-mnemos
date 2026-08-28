/**
 * Real DSH settings-page wiring (M5).
 *
 * Registers the `mnemos` namespace on the harness `ctx.settings` seam, so the
 * web settings UI renders a "dsh-mnemos" form and user overrides persist in
 * the settings document. The plugin keeps its own repo dependency-free: the
 * schemastery schema is built lazily from a declarative field spec through a
 * dynamic import, and the settings service is consumed through a structural
 * face (same pattern dsh-better-sidebar uses) instead of a hard dependency.
 *
 * When no settings service is mounted (headless profiles, tests), the wiring
 * degrades to the composition entry config — the namespace simply does not
 * register and the plugin behaves exactly as before.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config.js';

/** Minimal structural face of the dsh-settings service consumed here. */
export interface SettingsServiceFace {
  register<T>(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ): {
    get(): T;
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
  };
}

/** One declarative mnemos settings field; drives both the schema and the UI. */
export interface MnemosSettingsField {
  key: keyof Config;
  kind: 'string' | 'number' | 'boolean' | 'stringList';
  /** Short label for the settings form. */
  label: string;
}

/** The full configuration surface exposed on the settings page. */
export const MNEMOS_SETTINGS_FIELDS: MnemosSettingsField[] = [
  { key: 'enabled', kind: 'boolean', label: '插件总开关（关 = 全部静默）' },
  { key: 'dbPath', kind: 'string', label: 'SQLite 数据库文件路径（需重启生效）' },
  { key: 'maxEntries', kind: 'number', label: '记忆条目上限' },
  { key: 'maxBytesPerEntry', kind: 'number', label: '单条记忆字节上限' },
  { key: 'autoApprove', kind: 'boolean', label: '自动放行高置信度项目事实' },
  { key: 'autoApproveConfidence', kind: 'number', label: '自动放行置信度阈值' },
  { key: 'allowModelGlobalWrite', kind: 'boolean', label: '允许模型直接写全局记忆' },
  { key: 'blacklist', kind: 'stringList', label: '拉黑写入者（插件 id，逗号分隔）' },
  { key: 'sensitivityCheckEnabled', kind: 'boolean', label: '敏感内容检测' },
  { key: 'defaultScope', kind: 'string', label: '默认作用域（workspace / global）' },
  { key: 'injectionEnabled', kind: 'boolean', label: '跨会话记忆注入（agent/pre-step）' },
  { key: 'injectLimit', kind: 'number', label: '每轮注入记忆条数上限' },
  { key: 'injectMinHits', kind: 'number', label: '自动注入最低跨会话命中次数' },
  { key: 'injectMaxBytes', kind: 'number', label: '每轮热层注入字节预算' },
  { key: 'sessionLogDirs', kind: 'stringList', label: '会话日志扫描目录（逗号分隔）' },
  { key: 'backfillEnabled', kind: 'boolean', label: '启动时回填历史会话日志' },
  { key: 'importCaller', kind: 'string', label: '导入写入方（human=直接提交，model=进审批）' },
  { key: 'skillsDir', kind: 'string', label: '规则提升为技能文件的目录' },
  { key: 'protocolInjectEnabled', kind: 'boolean', label: '每会话注入环境/工具约定（protocol 记忆）' },
  { key: 'distillAuto', kind: 'boolean', label: '自动提炼（关=纯手动；开=每 N 次用户输入自动提炼）' },
  { key: 'distillEveryNTurns', kind: 'number', label: '自动提炼间隔（次用户输入）' },
  { key: 'distillWindow', kind: 'number', label: '单次提炼缓冲消息数' },
  { key: 'memoryRepoDir', kind: 'string', label: 'git 记忆仓库目录（需重启生效）' },
  { key: 'gitVersioning', kind: 'boolean', label: 'git 版本管理' },
  { key: 'gitRemoteName', kind: 'string', label: 'git 远程名' },
  { key: 'gitRemoteUrl', kind: 'string', label: 'git 远程 URL（保存后即重定向 origin）' },
  { key: 'syncEnabled', kind: 'boolean', label: '自动跨机同步' },
  { key: 'syncIntervalMinutes', kind: 'number', label: '自动同步间隔（分钟）' },
  { key: 'gitBackend', kind: 'string', label: 'git 后端（isomorphic=纯 JS / system=系统 git）' },
  { key: 'negativeMemoryEnabled', kind: 'boolean', label: '负面记忆（失败命令自动拦截）' },
  { key: 'negativeMemoryTtlMs', kind: 'number', label: '负面记忆失效时长（毫秒）' },
  { key: 'protocolRefreshTurns', kind: 'number', label: 'protocol 刷新间隔（轮次，压缩防御）' },
  { key: 'llmProvider', kind: 'string', label: '提炼用 LLM provider（留空用 DSH 默认）' },
  { key: 'llmModel', kind: 'string', label: '提炼用 LLM 模型（留空用 DSH 默认）' },
];

/**
 * Build a schemastery object schema from the declarative field spec. The
 * constructor is a parameter so unit tests can pass a fake; production passes
 * the dynamically imported `@deepseek-ai/schemastery` default export.
 * @param Schema - the schemastery constructor (default export of the package).
 * @param fields - the field spec driving the schema.
 * @returns a schemastery object schema.
 */
export function buildSchema(
  Schema: { object(shape: Record<string, unknown>): unknown; string(): unknown; number(): unknown; boolean(): unknown; array(item: unknown): unknown },
  fields: readonly MnemosSettingsField[],
): unknown {
  const shape: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field.kind) {
      case 'string':
        shape[field.key] = Schema.string();
        break;
      case 'number':
        shape[field.key] = Schema.number();
        break;
      case 'boolean':
        shape[field.key] = Schema.boolean();
        break;
      case 'stringList':
        shape[field.key] = Schema.array(Schema.string());
        break;
    }
  }
  return Schema.object(shape);
}

/**
 * Mount the `mnemos` namespace on a settings service. Runs inside the inject
 * fiber, so the registration unwinds when the service or this plugin unloads.
 * @param ctx - the plugin context.
 * @param schema - a schemastery schema resolving the namespace value.
 * @param entry - the composition entry config, layered below the user section.
 * @param onChange - notified with each resolved value (attach, change, detach).
 * @returns a disposer removing the namespace registration.
 */
export function mountMnemosNamespace(
  ctx: Context,
  schema: unknown,
  entry: Config,
  onChange: (next: Config) => void,
): () => void {
  const settings = (ctx as unknown as { settings?: SettingsServiceFace }).settings;
  if (!settings) {
    return () => {};
  }
  const scope = settings.register<Config>('mnemos', schema, { base: entry });
  onChange(scope.get());
  const off = scope.watch((next) => onChange(next as Config));
  return () => off();
}

/**
 * Register the mnemos settings page against the real harness settings seam.
 * The schemastery schema is imported lazily (keeps this plugin's own install
 * dependency-free); when the import or the settings service is unavailable the
 * wiring degrades to the entry config.
 * @param ctx - the plugin context.
 * @param entry - the composition entry config.
 * @param onChange - notified with the resolved config (initial + every change).
 * @returns a disposer that prevents a still-pending registration.
 */
export function installMnemosSettings(
  ctx: Context,
  entry: Config,
  onChange: (next: Config) => void,
): () => void {
  let disposed = false;
  void Promise.resolve().then(async () => {
    if (disposed) return;
    const mod = await import('@deepseek-ai/schemastery').catch(() => null);
    if (!mod || typeof mod.default !== 'function' || disposed) {
      return;
    }
    const Schema = mod.default as {
      object(shape: Record<string, unknown>): unknown;
      string(): unknown;
      number(): unknown;
      boolean(): unknown;
      array(item: unknown): unknown;
    };
    const schema = buildSchema(Schema, MNEMOS_SETTINGS_FIELDS);
    const inject = (ctx as unknown as { inject?: (deps: string[], cb: (sctx: Context) => void) => void }).inject;
    if (typeof inject === 'function') {
      inject(['settings'], (sctx) => {
        const off = mountMnemosNamespace(sctx, schema, entry, onChange);
        sctx.effect(() => off);
      });
    }
  });
  return () => {
    disposed = true;
  };
}
