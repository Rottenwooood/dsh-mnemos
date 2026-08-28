# dsh-mnemos

> **没有效果数据的记忆插件都是玩具。** dsh-mnemos 自带可复跑的效果评测，每次改动都能看到数字变化（见下"效果"）。

DSH（DeepSeek Harness）的**跨会话记忆插件**。它会记住你在会话里告诉模型的重要事实，下次会话自动想起来；所有写入都过一道审批门禁，数据全在本地，还带 git 版本历史和跨机同步。

## 效果（可复跑，确定性，无 LLM）

```sh
# 在 deepseek-harness 目录运行
node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/eval/run-eval.mts
```

| 指标 | 数值 |
|---|---|
| 事实召回 hit@1 | 0.94 |
| 事实召回 MRR | 0.94 |
| 噪音查询精度（不该召回的不召回） | 1.00 |
| 状态追踪（事实被修订后答当前值） | 通过 |
| 每会话冻结记忆索引 | 8 行 ≈ 207 token（一次性，KV 缓存友好） |
| 索引覆盖正确记忆 | 100% |

管理页"记忆"页签顶部有**效果卡**（注入次数/命中率/平均 token/已验证记忆数），数据来自 `usage_ledger` 效果账本——每次注入会记录用了多少 token，模型下一条消息若引用了注入内容就记为命中并给该记忆打"已验证"标记。

## 它能做什么

- **跨会话记忆**：这次会话说的"用 pnpm 装依赖"，下次会话模型自动知道，不用重复教。
- **有门禁**：敏感内容、重复、越界的写入被自动打回；普通写入直接入库，有风险的进"待审批"等人工确认。
- **会自我进化**：定时/手动把会话提炼成记忆和规则；规则批准后注入模型；还能固化成 SKILL。
- **会做梦（整合）**：定时/手动把散记忆归组成"场景"，从偏好/决策里归纳"人格画像"（证据加权）；全部只产生候选，你批了才算数。
- **记忆有生命周期**：失效清理按热度（冷的最先归档）走"活跃→归档→可还原"；`固定` 的记忆不参与清理；事实被新事实取代时新旧都保留并接上"接替链"，召回时新值在前、旧值标注"已被取代"。
- **记得住教训**：失败的命令会被记录，下次一模一样再来直接拦下并告诉模型为什么失败；成功重试后自动解除。
- **防投毒**：模型/导入产生的记忆标记"未验证"，注入时数量有上限且排在人工确认的记忆后面，来源标记模型可见。
- **可审计**：每一次写入/批准/拒绝都有记录。
- **数据你的**：全部存本地 SQLite；每条记忆同时是一份 Markdown 文件，走 git 历史（可回滚、可恢复、可跨机同步、可备份）。

## 快速开始

```sh
# 安装（web profile）
dsh plugin --profile web add dsh-mnemos

# 重启后浏览器"设置 → dsh-mnemos"可配置；侧边栏出现"记忆"页签
dsh web
```

记一条记忆：在会话里让模型用 `memory_record` 写（带上 `keywords`，例如 `pnpm`、`deploy to us-east-1`），或到设置页**导入历史会话**（目录默认预填 `~/.dsh/sessions`，导入后点"现在提炼"让 LLM 生成记忆）。

## 日常用法

- **模型工具**：`memory_search`（搜索）、`memory_get`（取某条记忆全文，下钻）、`memory_record`（写，含 keywords）、`memory_distill`（提炼缓冲会话 → 记忆/规则，写 keywords）、`memory_list`、`memory_stats` —— 模型在会话里自己会用。
- **记忆注入**：每会话开头注入一次**冻结的记忆索引**（每条一行：类型·短id·主题·关键词，字节稳定、命中 KV 缓存），模型需要细节时用 `memory_get` 下钻——"检索 ≠ 注入"，不把全文塞进请求。无启发式/正则抽取。
- **提炼**：LLM 生成记忆（每条带 2-5 个关键词，供触发注入）；可手动（`memory_distill` 工具 / "现在提炼"按钮 / `/memory distill`），或开 `distillAuto` 后**每 N 次用户输入自动执行**（`distillEveryNTurns`）。
- **人类命令** `/memory`：
  ```
  /memory search <关键词>          搜索记忆
  /memory list | stats             查看/统计
  /memory archive <id> | restore <id> | pin <id> | unpin <id>   生命周期管理
  /memory approve <id> | reject <id>   审批待确认项
  /memory import <来源> <路径>      导入历史会话（进提炼缓冲）
  /memory distill [路径]            提炼（生成记忆/规则候选）
  /memory consolidate               整合（场景 + 人格候选）
  /memory scenes | persona          查看/批准/拒绝 场景与人格候选
  /memory rules <list|activate|...>   管理规则
  /memory skill <list|promote>     规则 → SKILL
  /memory git <status|push|pull|rollback|restore|backup|...>  版本/同步
  /memory bus <blacklist|...>      第三方插件治理
  ```
- **浏览器界面**（better-sidebar「记忆」页签）：概览、30 天命中热力图、待审批、场景/人格候选、记忆列表（活跃/已归档，搜索/筛选/编辑/固定/归档/版本历史/删除）、已删除恢复、被拒历史、git 同步。

## 同步到 GitHub

在设置页填 `gitRemoteUrl`（如 `https://github.com/你/dsh-memory.git`）保存，然后点 push 即可。鉴权复用 `~/.git-credentials`（和系统 git 同一套凭据），无需额外配置。

## 配置

所有配置在浏览器"设置 → dsh-mnemos"页，改完大多即时生效。常用几项：

| 字段 | 作用 |
|---|---|
| `enabled` | 插件总开关 |
| `autoApprove` / `autoApproveConfidence` | 是否自动放行高置信度记忆、阈值 |
| `injectionEnabled` / `injectLimit` / `injectMaxBytes` | 是否注入、注入条数/字节预算 |
| `protocolRefreshTurns` | 环境约定重新注入间隔（轮次），防上下文压缩把常驻指令吃掉 |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | 跨机同步：远端地址 / 后端 / 自动同步 |
| `distillAuto` / `distillEveryNTurns` | 自动提炼开关与间隔（次用户输入） |
| `sessionLogDirs` / `backfillEnabled` | 启动时回填历史会话日志 |
| `negativeMemoryEnabled` / `negativeMemoryTtlMs` | 失败命令拦截与失效时长 |
| `consolidationEnabled` / `consolidationIntervalHours` | 定期整合（场景+人格）开关与周期 |

完整字段表、配置示例与使用场景见 **[docs/HANDOVER.md](docs/HANDOVER.md)**。

## 机制对照（2026 生态/研究）

| dsh-mnemos 机制 | 对齐来源 |
|---|---|
| 冻结索引注入 + `memory_get` 下钻（检索≠注入） | engram / meow / memory-manager / LongMemEval |
| 幂律热度排序 + 强化计数 | dsh-evolve 衰减语义 |
| 有界占用 + 来源标记防投毒 | 2608.21230 / Veracium |
| 失败命令拦截 + 自失效（负面记忆） | dsh-negative-ledger / deja-vu |
| 活跃→归档→删除 + pinned（绝不硬删） | dsh-evolve 状态机 |
| 场景 + 人格（propose-only 审批） | self-improved 金字塔 / meow 做梦 / mneme |
| 知识接替链（保留双方 + 标注当前值） | StateMemBench / MELD |
| protocol 按轮次刷新（防压缩悬崖） | 2608.22752 |
| 开放测量 ABI + conformance | memento conformance suite |
| 效果账本 + 可复跑评测 | memlab / LongMemEval 方法论 |

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test                  # 单元测试
pnpm run build:client      # 改了浏览器端（src/client/）后需要
```

改完跑完整验证（一键，含真实环境）：

```sh
scripts/run-verify.sh      # typecheck+单测 → 确定性评测 → ABI conformance → 真实注册表组合
```

单步（在 deepseek-harness 目录）：
```sh
# 真实命令注册表分发 /memory 各子命令 + 负面记忆 + 接替链 + 信任
node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/verify-real-composition.mts
# 开放测量 ABI 一致性（证明不是空壳）
node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/conformance.mts
```

## 数据位置

```
~/.dsh/mnemos/mnemos.db     SQLite 数据库
~/.dsh/mnemos/repo/         git 记忆镜像（每条记忆一个 .md）
~/.dsh/mnemos/skills/       规则固化的 SKILL
```

## 许可

MIT
