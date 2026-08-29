# dsh-mnemos 架构

跨会话记忆插件，DeepSeek Harness（DSH）。目标：让助手在会话之间记住并
进化——用治理（审批、信任、审计）约束自动进化（蒸馏、召回、遗忘）。

## 分层总览

```
┌─ DSH 宿主（cordis / dsh-tools / dsh-settings / dsh-session / dsh-commands）
│
├─ src/dsh/            宿主适配层：工具、命令、路由、钩子、设置、ABI
│    index.ts          插件入口（apply），装配所有适配层
│    hooks.ts          注入（registerInjection / registerProtocolInjection）
│    tools.ts          模型工具 memory_search/record/get/stats/distill/approve...
│    command.ts        /memory 命令
│    routes.ts         HTTP 路由（宿主 RPC）
│    adapter.ts        开放测量 ABI（ctx.mnemosAbi / ctx.mnemosBus / ctx.mnemos）
│    settings.ts       Schemastery 配置定义（34 项）
│    llm-adapter.ts    DSH 配置的 LLM 适配
│
├─ src/domain/         纯领域逻辑（零 DSH 依赖，可单测）
│    store.ts          SQLite 存储 + FTS5 全文索引 + 迁移
│    service.ts        记忆服务：门禁、审批、去重、审计、原地更新
│    recall.ts         检索：recallIndex / recallByKeywords / heatOf
│    distill.ts        LLM 蒸馏：DISTILL_SYSTEM_PROMPT、冲突检测
│    gitstore.ts       git 镜像存储（版本化/回滚/跨机同步）
│    git/              git 后端抽象（isomorphic-git / system-git）
│    mirror.ts         镜像格式 B（frontmatter summary + 详情/溯源）
│    bus.ts            开放记忆总线（身份/黑名单/吊销）
│    sensitive.ts      敏感内容检测
│    dedup.ts          规范化与去重（normalizeTopic）
│    imports/          历史导入适配器（dsh/claude-code/codex/chatgpt）
│    backfill.ts       倒排索引回填
│    skill.ts          规则 → skill 合成
│    llm.ts            LLM 接口抽象
│    types.ts          领域类型
│
├─ src/client/         浏览器端管理面板（构建到 lib/client.js）
└─ scripts/            验证与基准
     run-verify.sh      一键验证（typecheck+test+eval+conformance+composition）
     eval/              确定性效果评测（scorecard）
     conformance.mts    ABI 一致性套件
     verify-real-composition.mts 真实链路组合验证
     bench/             公开数据集基准（LongMemEval-S / LoCoMo-10）
```

## 数据模型（SQLite）

`memories` 表核心字段：id、type（project_fact/procedure/preference/error_fix/
decision/protocol）、scope（global/workspace）、workspace、topic、summary、
detail、evidence、confidence、source、writer、created_at、updated_at、
keywords、cross_session_hits、observation_count、accessed_at、verified、
pinned、supersedes_id、superseded_by_id、trust（trusted/untrusted）、
status（active/archived/deleted/superseded）。

- **FTS5 外部内容表** `memory_fts(summary)` + 三触发器（insert/delete/update）
  保证主表与索引同步；检索按 `rank`（bm25）排序。
- 检索多级阶梯：FTS5 全词 AND（精确）→ 空则 FTS5 任词 OR（bm25 排序）→
  空则包含扫描。服务层再与二元组相似度做 RRF 融合（`hybridSearch`）。
- 辅助表：`rules`、`audit`、`approval`、`usage_ledger`、`bus_blacklist`。
- 迁移策略：`IF NOT EXISTS` 建表 + 幂等 `ALTER TABLE ADD COLUMN`（逐列探测），
  `user_version` 校验。

## 数据流

### 写入（审批门禁，service.programChecks）

1. 模型调用 `memory_record` / 蒸馏 / 导入 → `proposeMemory`。
2. `programChecks`：预算（字节/条数）、敏感检测、写入者黑名单、去重、
   scope 策略。
3. 决策：低风险项目事实 + 高置信度 → 自动批准；否则进 `approval` 队列等人工。
4. `approve` 分支处理两种载荷：普通新增，或 `__update`（原地更新，
   `replaceMemoryId`，topic/type/scope 不可变）。
5. 每次写落 `audit`；被拒写也落 `*-denied`。

### 检索与注入

- **会话开头一次**：`recallIndex` 渲染冻结索引（指针行，默认 2048 字节 /
  50 行 / untrusted 上限 3），字节稳定以命中 KV 缓存；细节靠 `memory_get`
  下钻。
- **会话中途**：`registerInjection` 以"间隔到点 + 用户消息命中关键词"双门控
  调用 `recallByKeywords`，部分索引刷新。
- 热度排序：`heatOf = 1/(1+0.2·Δt_days)`，刷新 `accessed_at` 强化。
- 信任有界占用：untrusted 排 trusted 之后、限量，来源标 `/未验证`。

### 蒸馏（distill.ts）

会话日志窗口（200 条）→ LLM（DSH 配置）→ 结构化记忆/规则，字段参考见
`DISTILL_SYSTEM_PROMPT`；`detectConflicts` 决定走接替链还是规则；
`distillAuto` 默认关闭（计数触发，每 5 条用户消息）。

### 镜像（mirror.ts + gitstore.ts）

记忆变更提交到 git 镜像（格式 B：frontmatter summary + 详情/溯源），
per-entry 历史可回滚，支持跨机同步。git 后端可插拔。

## 宿主集成要点

- 注入走 `systemPrompt` 段（协议记忆常驻 + 冻结索引 + 关键词部分刷新），
  一次性且字节稳定。
- 工具经 `dsh-tools` 注册；`/memory` 命令经 `dsh-commands`；设置经
  `dsh-settings`（Schemastery，34 项配置）；事件用 rc.2 真实签名。
- 开放测量 ABI `ctx.mnemosAbi`（recall/get/state/probe，versioned）+ 总线
  get/state 对齐三原语，供客户端与评测统一测量真实实现（一致性套件校验
  非 stub）。

## 验证体系

- `npm run test`：vitest，单元 + 接线（19 文件 / 149 测试）。
- `scripts/eval/`：确定性效果评测（T1 召回 / T3 状态追踪 / T4 注入效率）。
- `scripts/conformance.mts`：ABI 一致性（9/9）。
- `scripts/verify-real-composition.mts`：真实 ToolRuntime/命令注册表/挂载服务
  组合验证。
- `scripts/bench/`：公开数据集基准（LongMemEval-S / LoCoMo-10，见
  `BENCHMARKS.md`）。

## 关键配置（默认值）

`injectRefreshIntervalMinutes=10`、
`injectPartialLimit=5`、
`allowModelGlobalWrite=false`、`distillAuto=false`、`distillEveryNTurns=5`。
完整清单见 `src/dsh/settings.ts`。
