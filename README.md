# dsh-mnemos

Cross-session memory with governance, self-evolution and an approval-gated write path for DeepSeek Harness.

> 开发中（M0）。领域核心（存储 / 写入门禁 / 审计 / 敏感检测 / 去重冲突）已实现并可单测；DSH 接线层在 `src/dsh/`。

## 设计要点

- 所有写入收敛到 `MemoryService`：程序检查（预算 / 敏感内容 / 去重 / 作用域 / 黑名单）→ 命中即打回并留审计；通过后高置信低风险纯事实自动放行，其余进待审批队列。
- 审计表记录每次写入 / 批准 / 拒绝 / 回滚，`by_agent` 标记模型发起、`denied` 标记被程序打回。
- 存储：SQLite（node:sqlite）+ FTS5 全文；记忆条目带 `(sessionId, eventRange)` 溯源。
- 敏感内容：正则 + 熵检测，写前拦截。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
```
