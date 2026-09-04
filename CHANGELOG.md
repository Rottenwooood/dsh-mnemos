# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-04

### Changed
- 已适配 DSH `v0.1.2-rc.1`。
- 移除独立 rule 层：提炼结果统一作为普通记忆处理。
- 新增 `memory_to_skill`，将已批准的非 `protocol` 记忆正式化为 DSH SKILL；写入成功后源记忆软删除。
- `memory_distill` 在调用 LLM 前对会话内容进行敏感信息脱敏，以 `[REDACTED]` 替换密钥、令牌、私钥、地址和高熵长字符串；写入前仍保留拒绝检查。

## [0.1.1] - 2026-08-30

### Changed
- `protocol`（环境约定）走独立通道：每会话首步注入 + 压缩后重注入，
  **不进记忆索引**；README（中英）、面板标签、设置项措辞统一为"环境约定"。
- `cleanupDays` 新配置：清理失效天数（默认 90），`/mnemos/api/cleanup`
  无 `?days=` 时读配置，面板"清理失效"按钮与确认文案同步。

### Removed
- 负面记忆（失败命令拦截）：删除 `negative_memory` 表、`tools/pre-execute`
  拦截与相关配置/面板项，让模型自由执行。P2 历史段中的对应条目保留作记录。

### Added
- 公开数据集基准（LongMemEval-S / LoCoMo-10）：`scripts/bench/`，与 deja-vu
  同口径（每会话一条记忆、问题原文检索、session-level 指标）。详见
  `scripts/bench/BENCHMARKS.md`。
  - LongMemEval-S（cleaned, 470 题）：产品路径 hit@1 87.2%、MRR 0.914
    （deja-vu 官方 85.3% / 0.896）。
  - LoCoMo-10（1982 QA）：产品路径 R@1 60.9%（deja-vu 官方 69.6%）。
- 检索多级阶梯（产品化）：`MemoryStore.searchMemories` 从单级"全词 AND"
  升级为 AND → OR → 包含扫描 多级降级。阶梯上线前产品路径
  LongMemEval-S hit@1 约 10%、LoCoMo R@1 约 7%。
- 发布外壳：`files`/`keywords`/`publishConfig` 发布面、CHANGELOG、
  SECURITY、架构文档、GitHub Actions CI（`.github/workflows/ci.yml`）。

## [0.1.0] - 2026-08-29

首个可发布版本。DeepSeek Harness 的跨会话记忆插件：治理 + 自动进化 +
审批门禁写入路径。

### Added

**P0 — 基础能力**
- `src/domain/` 记忆服务门禁 + SQLite 存储（`node:sqlite`，零原生依赖），
  含去重与敏感内容检测。
- 模型工具（`memory_search`/`memory_record`/`memory_get` 等）、`/memory`
  命令、信号钩子接入 DSH 宿主。
- 历史导入（`~/.dsh/sessions`）、倒排索引回填、冷/热分层注入。
- 蒸馏管线：通过 DSH 配置的 LLM 蒸馏（无独立 API key），规则生命周期，
  skill 合成。
- 开放记忆总线：身份、黑名单、吊销。
- git 版本化、跨机同步、备份；可插拔 git 后端（isomorphic-git 默认，
  系统 git CLI 备选）。
- 效果账本（usage_ledger）与遥测面板，确定性可复跑评测（`scripts/eval/`）。

**P1 — 检索与注入**
- 渐进式披露：每会话冻结记忆索引 + `memory_get` 下钻。
- 幂律热度衰减排序 + 强化计数（`accessed_at` 刷新）。

**P2 — 遗忘与演化**
- 负面记忆：记录失败命令（指纹 = 工具+目录+归一化命令），拒绝重试，
  成功/TTL 自失效（`negative_memory`）。
- 遗忘策略：`pinned` 保护 + 热度排序归档（active→archived→deleted 状态机）。
- 知识接替：替换生成新记忆 + 旧记忆标记被取代（`supersedes_id`/
  `superseded_by_id`），召回新值在前、旧值标注"已被新值取代"。
- 记忆原地更新：`replaceMemoryId` 同 id 更新，topic/type/scope 不可变，
  git 版本化、per-entry 历史 + 回滚。
- 移除 P2.3 场景/人格整合（评审后判为冗余抽象）。

**P3 — 可靠性**
- 防投毒：`trust` 来源分级（模型/导入 = untrusted），注入有界占用
  （untrusted 上限 3 且排后），`/未验证` 来源标记。
- 开放测量 ABI：`ctx.mnemosAbi`（recall/get/state/probe）+ 一致性套件
  （`scripts/conformance.mts`）。
- 压缩防御：协议记忆按 `protocolRefreshTurns` 轮次重新注入。
- 工程可靠性：`scripts/run-verify.sh` 一键验证；README 机制对照表。
- 修复：summary 查询缺 `created_at` 导致访问时间回退、热度 NaN；
  协议记忆 topic 被 40 字符截断。

**蒸馏提示词（字段参考）**
- 全字段参考（type 六类 / topic / scope 默认与覆盖 / confidence 判据 /
  keywords 判别词），scope 输入输出支持。

**注入（当前形态）**
- 会话开头全量冻结索引一次（字节稳定、命中 KV 缓存）+ 间隔与关键词双门控的
  部分索引刷新（`injectRefreshIntervalMinutes` / `injectPartialLimit`）。

### Changed
- 镜像格式 B：summary 进 frontmatter，body 只剩详情/溯源；兼容解析旧格式；
  溯源（evidence）读回。
- 常驻指令改为协议记忆，而非隐藏规则。

### Fixed
- 全局/工作区作用域逻辑错误与既有记忆重新归类。
- 跨会话注入死锁（命中计数从未增长）。
- 注入时机从每 step 修正为每会话冻结。
- isomorphic-git 后端状态误报、未暂存删除、https 推送/拉取超时。
- 审批/请求事件签名对齐 DSH rc.2。
