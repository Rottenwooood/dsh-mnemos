# dsh-mnemos

Cross-session memory with governance, self-evolution and an approval-gated write path for DeepSeek Harness.

> 开发中（M0 完成）。领域核心（存储 / 写入门禁 / 审计 / 敏感检测 / 去重冲突）与 DSH 接线层（工具 / `/memory` 命令 / 会话信号采集 / `ctx.mnemos` 服务）已实现并全部可单测。管理页签（better-sidebar）与提炼流水线在后续里程碑。

## 设计要点

- 所有写入收敛到 `MemoryService`：程序检查（预算 / 敏感内容 / 去重 / 作用域 / 黑名单）→ 命中即打回并留审计；通过后高置信低风险纯事实自动放行，其余进待审批队列。
- 审计表记录每次写入 / 批准 / 拒绝，`by_agent` 标记模型发起、`denied` 标记被程序打回。
- 存储：SQLite（node:sqlite，零原生依赖）+ FTS5 全文索引 + WAL；记忆条目带 `(sessionId, eventRange)` 溯源。
- 敏感内容：正则 + 熵检测，写前拦截；近似重复：bigram-Jaccard 相似度。

## DSH 接线

- 插件入口 `src/index.ts`：打开存储、构造 `MemoryService`、注册工具 / 命令 / hooks、`ctx.provide('mnemos', ...)` 开放给第三方插件（审批门禁）。
- 模型工具（`src/dsh/tools.ts`）：`memory_search` / `memory_record` / `memory_list` / `memory_stats`。模型写经门禁，无法绕过治理。
- 人类命令（`src/dsh/command.ts`）：`/memory search|list|stats|approve|reject`。审批只走人类命令，不交给模型。
- 会话信号（`src/dsh/hooks.ts`）：监听 `session/event`，维护每会话游标；M0 仅识别"记住"类高价值信号并打日志，提炼流水线在 M2。
- `src/dsh/dsh.d.ts` 是对 DSH 上下文表面的占位类型增强（`dsh-*` 包未发布到 npm）；接入真实类型后删除即可。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
```
