# dsh-mnemos

Cross-session memory with governance, self-evolution and an approval-gated write path for DeepSeek Harness.

> 开发中（M3 完成）。领域核心、DSH 接线层、历史导入 + 回填、冷热分层注入、提炼流水线（隔离角色 + JSON 校验 + 冲突裁决 + 规则生命周期 + SKILL 合成）、开放记忆总线（recall/record/subscribe + 身份 + 拉黑 + 撤销）已实现并全部可单测。管理页签（better-sidebar）与 git 版本/同步在后续里程碑。

## 设计要点

- 所有写入收敛到 `MemoryService`：程序检查（预算 / 敏感内容 / 去重 / 作用域 / 黑名单）→ 命中即打回并留审计；通过后高置信低风险纯事实自动放行，其余进待审批队列。
- 审计表记录每次写入 / 批准 / 拒绝 / 替换 / 撤销 / 规则状态变更，`by_agent` 标记模型发起、`denied` 标记被程序打回。
- 存储：SQLite（node:sqlite，零原生依赖）+ FTS5 全文索引 + WAL；记忆条目带 `(sessionId, eventRange)` 溯源。
- 敏感内容：正则 + 熵检测，写前拦截；近似重复/冲突：bigram-Jaccard 相似度。

## M3：开放记忆总线（`src/domain/bus.ts` + `ctx.mnemosBus`）

- **三原语**：`recall`（只读查询，从不写）、`record`（申请写入，**必须声明身份** 插件名+版本）、`subscribe`（订阅变化事件：新记忆生效 / 提案 / 替换 / 撤销 / 规则批准）。事件同时以 cordis `mnemos/memory` 发出。
- **治理**：
  - 第三方写入被盖章为 `plugin:<name>@<version>`、`source=third_party`，**只能进待审批队列**（forcePropose，绝不直接入库、绝不自动放行）。
  - 运行时拉黑插件（`bus_blacklist` 表持久化），其写入即拒绝并留审计（`denied + plugin-blacklisted`）。
  - 撤销只允许写入者本人或人类（`/memory bus revoke`），软删除可恢复。
- **按写入者分组**：`listByWriter`（跨版本），供热力图/审批面板按来源插件过滤。
- 命令：`/memory bus <blacklist|unblacklist|list|revoke|writers>`。

## M2：自进化（提炼流水线 + 规则 + SKILL）

- **提炼流水线**（`src/domain/distill.ts`）：隔离专职角色（独立 system prompt，不继承主对话历史）→ 严格 JSON 输出 → schema 校验（不合法即丢弃并计数，绝不半生效）→ 过门禁。
  - 事实/决策 → 记忆；流程/偏好/失败 → **规则提案**；类型到规则 kind 的映射固定（procedure→skill / preference→preference / error_fix→system_prompt）。
  - **冲突裁决**：同一话题近似文本但说法不同 → 打标为**替换提案**（`proposeReplacement`），强制人工裁决，批准后**替换**原记忆而非新增，绝不自动放行。
- **规则生命周期**（`src/domain/service.ts`）：提案（进 rules 表 + 审批队列）→ 批准/拒绝 → 生效（`agent/request` 注入带标记）→ 弃用/回滚（状态机校验非法迁移）。
- **SKILL 合成**（`src/domain/skill.ts`）：仅批准后的规则才能固化为 Markdown skill 文件（frontmatter + 来源证据），写盘后规则标记 `promoted`。
- **三层提炼时机**：① 事件触发——`session/event` 高价值信号缓冲（`SignalCollector`）；② 定时批量——`distillIntervalMinutes` 定时 job（`distillAuto` 默认关 = 纯手动）；③ 手动——`/memory distill`。增量用每会话游标（消息序号 + 内容哈希），会话更新只处理尾部。
- `/memory rules <list|activate|rollback|deprecate>`、`/memory skill <list|promote>`。

## M1：装完即满 + 冷热分层

- 历史导入（Claude Code / Codex / ChatGPT + DSH 日志适配器）+ 自动格式检测；确定性提炼（记住/纠正 → 候选）。
- 回填：增量 + 断点续传（按文件字节 checkpoint）+ 内容哈希去重。
- 冷热分层：热层每轮注入的压缩投影（硬字节预算）；温/冷层按需 FTS5+bigram；`agent/pre-step` 同请求注入，不产生第二次 API 调用。

## DSH 接线

- 插件入口 `src/index.ts`：存储、`MemoryService`、`MemoryBus`、工具 / 命令 / hooks / 注入 / 规则注入 / 回填 job / 定时提炼、`ctx.provide('mnemos' | 'mnemosBus', ...)`。
- 模型工具：`memory_search` / `memory_record` / `memory_list` / `memory_stats`。模型写经门禁。
- 人类命令：`/memory search|list|stats|approve|reject|import|backfill|distill|rules|skill|bus`。审批/拉黑只走人类命令。
- `src/dsh/dsh.d.ts` / `types.ts` / `llm-adapter.ts` 是对 DSH 上下文与 LLM 接缝的占位类型与适配（`dsh-*` 包未发布到 npm）；接入真实类型后替换即可。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
```
