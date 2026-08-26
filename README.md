# dsh-mnemos

Cross-session memory with governance, self-evolution and an approval-gated write path for DeepSeek Harness.

> 开发中（M1 完成）。领域核心（存储 / 写入门禁 / 审计 / 敏感检测 / 去重冲突）、DSH 接线层（工具 / `/memory` 命令 / 会话信号 / pre-step 注入）、会话回填 + 三个历史导入适配器 + 冷热分层注入已实现并全部可单测。管理页签（better-sidebar）、提炼流水线、开放总线、git 版本/同步在后续里程碑。

## 设计要点

- 所有写入收敛到 `MemoryService`：程序检查（预算 / 敏感内容 / 去重 / 作用域 / 黑名单）→ 命中即打回并留审计；通过后高置信低风险纯事实自动放行，其余进待审批队列。
- 审计表记录每次写入 / 批准 / 拒绝，`by_agent` 标记模型发起、`denied` 标记被程序打回。
- 存储：SQLite（node:sqlite，零原生依赖）+ FTS5 全文索引 + WAL；记忆条目带 `(sessionId, eventRange)` 溯源。
- 敏感内容：正则 + 熵检测，写前拦截；近似重复：bigram-Jaccard 相似度。

## M1：装完即满 + 冷热分层

- **历史导入**（`src/domain/imports/`）：Claude Code（`projects/**/*.jsonl`）/ Codex（`sessions/**/*.jsonl`，兼容新旧 envelope）/ ChatGPT（`conversations.json`）三个适配器 + 自动格式检测；DSH 会话日志适配器（best-effort，接真日志后校准）。
- **确定性提炼**（`src/domain/extract.ts`）：显式"记住/remember" → preference；用户纠正前一条助手/失败工具结论 → error_fix。每条候选带原文证据，走同一门禁。
- **回填**（`src/domain/backfill.ts`）：增量 + 断点续传（按文件字节 checkpoint，JSON 持久化）+ 内容哈希去重；`/memory backfill <dir>` 或后台 job（`sessionLogDirs`）。
- **冷热分层**（`src/domain/recall.ts`）：热层 = 每轮注入的压缩投影（硬字节预算，超预算丢弃并计数、绝不静默截断）；温/冷层按需 FTS5+bigram 召回。注入走 `agent/pre-step` 同请求 `agent.inject()`，不产生第二次 API 调用。
- `/memory import <auto|claude|codex|chatgpt|dsh> <path>` 手动导入；`importCaller` 控制候选是直接入库还是进审批队列。

## DSH 接线

- 插件入口 `src/index.ts`：打开存储、构造 `MemoryService`、注册工具 / 命令 / hooks / 注入 / 回填 job、`ctx.provide('mnemos', ...)` 开放给第三方插件（审批门禁）。
- 模型工具（`src/dsh/tools.ts`）：`memory_search` / `memory_record` / `memory_list` / `memory_stats`。模型写经门禁，无法绕过治理。
- 人类命令（`src/dsh/command.ts`）：`/memory search|list|stats|approve|reject|import|backfill`。审批只走人类命令。
- `src/dsh/dsh.d.ts` 是对 DSH 上下文表面的占位类型增强（`dsh-*` 包未发布到 npm）；接入真实类型后删除即可。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
```
