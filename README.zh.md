# dsh-mnemos

[English](README.md)

**有治理、会自我进化、带可复跑效果数据的 DSH 跨会话记忆插件。** 模型记住的每一条，都经过一道审批门禁写入；数据全在本地 SQLite，同时是一份 git 版本化的 Markdown 镜像——每次改动效果数字都会跟着动。

![CI](https://img.shields.io/github/actions/workflow/status/Rottenwooood/dsh-mnemos/ci.yml?branch=main&label=CI) ![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/tag/Rottenwooood/dsh-mnemos?label=version) ![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)

---

## 它是什么 / 不是什么

**它是什么。** 一个 DSH 插件，给模型跨会话记忆。你在一个会话里告诉它的重要事实，下个会话开头自动注入，不用重复教。所有写入路径——模型工具、/memory 命令、第三方插件、浏览器界面——都走同一个带审批门禁的 `MemoryService`。数据全在本地：SQLite（WAL + FTS5）+ git 版本化的 Markdown 镜像（历史、回滚、备份、跨机同步）。

**跨设备同步就是 git，git 有两个后端。** 每条记忆是一个 git 仓库里的 Markdown 文件，这个仓库就是同步通道。填一个 git 远端，mnemos 按条目合并：独立记忆干净合并；两端都改过的记忆标记为冲突交你裁决——绝不静默覆盖。两种后端：`gitBackend: system`（你的 git CLI，更稳）和 `gitBackend: isomorphic`（纯 JS 的 npm 包，默认，免系统 git——实测在慢网络下有概率超时/不稳；同步多的话建议用 `system`）。

**它不是什么。**

- 不是记忆**仓库**或向量库——不做无上限的堆积。
- 不是悄悄改写器——互相矛盾的事实会变成**替换提案**等人工裁决，绝不自动覆盖。
- 不是"信任一切"的收容所——模型/导入/第三方写入都被标记为"未验证"，注入时数量有上限、排在人工确认的记忆后面，来源对模型可见。

## 为什么选它

1. **效果数字可复跑、超过同口径对手。** LongMemEval-S hit@1 **87.2%**，deja-vu 官方公布 **85.3%**——同数据、同指标、同问题原文。确定性的、不用 LLM，自己跑一遍即可。大多数记忆插件一个数字都不发。
2. **跨会话记忆。** 这个会话告诉模型的，下个会话开头自动注入——它"知道用 pnpm 装依赖"，不用你重复教。
3. **绕不过的审批门禁。** 敏感内容、重复、越界写入自动打回；普通写入直接入库，有风险的进"待审批"等人工确认。模型工具、/memory 命令、第三方插件、浏览器——所有写入路径走同一个门禁。
4. **会自我进化。** 会话被提炼成记忆**和规则**；批准后的规则注入模型，还能固化成 **SKILL 文件**。按需执行，或开 `distillAuto` 每 N 次用户输入自动跑。
5. **有真实的记忆生命周期。** 按热度清理走"活跃→归档→可还原"（冷的最先）；`固定` 的记忆不参与清理；删掉的记忆仍可恢复。
6. **事实就地修正，不堆矛盾。** 事实变了，直接在原记忆上改——旧值通过 git 历史可回滚。只有真正互相矛盾的声明才变成**替换提案**等人工裁决；检索永远不会返回同一事实的两个活跃版本。
7. **失败靠机制记，不是玄学。** 命令失败时，记录"工具 + 工作目录 + 逐字命令"并带证据。下一次一模一样再执行，直接拦下、用存下的证据告诉模型为什么。记录在 TTL 到期或第一次成功重试后自动失效。负面记忆**从不注入提示词**——它是在执行时拦截的。
8. **防投毒。** 模型/导入/第三方写入标记"未验证"：注入数量有上限、排在人工确认的记忆后面、来源对模型可见。
9. **可审计。** 每次写入/批准/拒绝/替换/撤销都落审计账本——被拒的也记。
10. **数据你的。** 本地 SQLite（WAL + FTS5）；每条记忆同时是一个 git 仓库里的 Markdown 文件——历史、diff、回滚、恢复、备份、跨机同步。
11. **跨设备同步就是 git，git 有两个后端。** 独立记忆跨机干净合并；两端都改过的记忆标记为冲突交你裁决——绝不静默覆盖。`gitBackend: system`（你的 git CLI，更稳）或 `gitBackend: isomorphic`（纯 JS npm 包，默认，免系统 git——实测在慢网络下有概率超时/不稳；同步多建议用 `system`）。
12. **导入别家历史。** 自动识别并摄取 ChatGPT 导出、Claude Code 日志、Codex 日志、DSH 自己的会话日志——按内容哈希去重，重复导入不产生重复记忆。
13. **对别的插件开放——记忆总线。** `ctx.mnemosBus`：只读查询、必须声明插件身份且永远进审批队列的写入、变化订阅、运行时拉黑、可撤销（只有写入方插件或人类）。
14. **对测量开放——版本化 ABI。** `ctx.mnemosAbi` 暴露 `recall / get / state / probe`，外部工具和评测读真实数字（活跃/待审批/未验证/已验证/注入/命中率）——conformance 套件证明不是空壳。

## 功能

### 给使用者

- **模型工具**（模型在会话里自己用）：
  `memory_search`（检索）· `memory_record`（写入，带关键词）· `memory_distill`（把缓冲会话提炼成记忆/规则提案）· `memory_list` · `memory_stats`。
- **冷启动注入，不是塞全文。** 每个会话开头注入一次**冻结的记忆索引**（每条一行：类型·短id·主题·关键词，字节稳定、命中 KV 缓存）；模型要细节用 `memory_get` 下钻。全程没有任何启发式/正则抽取。
- **/memory 命令**——完整清单、使用场景、故障排查在 [docs/HANDOVER.md](docs/HANDOVER.md)；关键几条：
  ```
  /memory search <关键词> | list | stats
  /memory approve <id> | reject <id>
  /memory import <来源> <路径>       自动识别：chatgpt|claude|codex|dsh
  /memory distill [路径]
  /memory rules <list|activate|rollback|deprecate>
  /memory skill <list|promote <ruleId>>
  /memory git <status|log|rollback|restore|remote|push|pull|backup>
  /memory bus <blacklist|unblacklist|list|revoke|writers>
  ```
- **浏览器界面**（better-sidebar「记忆」页签）：概览、30 天命中热力图、待审批（批准/拒绝/编辑后批准/批量批准低风险）、记忆列表（搜索/筛选/编辑/版本历史/回滚/删除）、已删除恢复、被拒历史、git 同步。
- **提炼。** LLM 生成记忆（每条带 2-5 个关键词，触发注入），流程/偏好/失败提炼成**规则提案**进审批；批准后的规则注入模型，还能固化成 **SKILL 文件**（只有已批准的规则能固化——草稿/待审的一律不行；幂等）。

### 给开发者

- **记忆总线 —— `ctx.mnemosBus`**。给第三方插件的读/写/订阅接口：
  - `recall({query})` —— 只读。
  - `record(input, identity)` —— 写入；必须声明 `plugin:<名字>@<版本>` 身份，且写入**永远进审批队列**（绝不直接落库、绝不自动放行）、记审计、归属到写入者。
  - `subscribe(listener)` —— 订阅事件（新记忆、提案、被取代、被撤销、规则批准）。
  - 治理：运行时拉黑（`bus.blacklistPlugin`）、撤销（只有写入者插件或人类）。
- **测量 ABI —— `ctx.mnemosAbi`**。版本化的 `recall / get / state / probe`，让外部工具和评测读到真实数字（活跃/待审批/未验证/已验证/注入/命中率）。`scripts/conformance.mts` 证明它就是实际实现。
- **导入适配器。** `src/domain/imports/` —— chatgpt、claude-code、codex、dsh，自动格式检测在 `detect.ts`。

## 效果

### 确定性效果评测（无 LLM）

```sh
# 在 deepseek-harness 目录运行（把插件路径换成你的）
node --import tsx/esm /path/to/dsh-mnemos/scripts/eval/run-eval.mts
```

| 指标 | 数值 |
|---|---|
| 事实召回 hit@1 | 0.94 |
| 事实召回 MRR | 0.94 |
| 噪音查询精度（不该召回的不召回） | 1.00 |
| 状态追踪（事实被修订后答当前值） | 通过 |
| 每会话冻结记忆索引 | 8 行 ≈ 207 token（KV 缓存友好） |
| 索引覆盖正确记忆 | 100% |

「记忆」页签顶部有**效果卡**（注入次数/命中率/平均 token/已验证记忆数），数据来自 `usage_ledger` 账本——每次注入记录 token 成本，模型下一条消息若引用了注入内容就记为命中并给该记忆打"已验证"标记。

### 公开数据集基准（LongMemEval-S / LoCoMo-10）

在产品检索路径（FTS5 多级阶梯：全词 AND → 任词 OR → 包含扫描，再与二元组相似度做 RRF 融合）上测得，与 deja-vu 官方公布数字同口径。方法论详见 [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md)。

| 数据集 | dsh-mnemos 产品路径 | deja-vu 官方 |
|---|---|---|
| LongMemEval-S（cleaned, 470 题, hit@1） | **87.2%** | 85.3% |
| LoCoMo-10（1982 QA, R@1） | 60.9% | 69.6% |

诚实说明：

- **LongMemEval-S：** 每一项指标都超过 deja-vu（hit@1 87.2% vs 85.3%、MRR 0.914 vs 0.896、evidence-recall@1 56.3% vs 55.0%）。
- **LoCoMo-10：** 落后（60.9% vs 69.6%）。LoCoMo 会话更长、问题更依赖跨会话推理；deja 的词形还原（stem）层和更强的排序变体在这里占优。缩小差距在路线图上，不是缺陷。
- **口径诚实：** deja-vu 的数字是其官方公布值——我们无法在本地重跑原版（它需要 go1.25，本机 go1.22 且工具链下载不可达）。同数据、同指标、同问题原文。
- 检索阶梯上线前，产品路径约为 10%（LongMemEval-S）与 7%（LoCoMo）——全部差距来自"全词必须命中"的查询构造，不是底层引擎。

## 安装与快速开始

**兼容性**（诚实）：在 **Linux / Node ≥ 22.19 / DSH web profile** 上开发并验证；Windows/macOS 未测（见[路线图](#路线图)）。提炼复用的 LLM 是 DSH 配置的默认模型（`agent-default-model`），不需要单独的 API key。

```sh
# npm 通道（发布后）
dsh plugin --profile web add dsh-mnemos

# git 通道（最新 main）
dsh plugin --profile web add git+https://github.com/Rottenwooood/dsh-mnemos.git

# tarball 通道
npm pack   # 在仓库里
dsh plugin --profile web add ./dsh-mnemos-<version>.tgz
```

重启 `dsh web`；在"设置 → dsh-mnemos"配置；侧边栏出现「记忆」页签。卸载：`dsh plugin --profile web remove dsh-mnemos`（记忆数据库会保留）。

**3 步拥有第一条记忆：**

1. 会话里让模型"记住"（它会调 `memory_record`），或在设置页**导入历史会话**（默认目录 `~/.dsh/sessions`）。
2. 点"现在提炼"（或开 `distillAuto`），让 LLM 把缓冲会话变成记忆。
3. 下个会话，模型带着注入的记忆索引开场，需要细节用 `memory_get` 下钻。

## 配置

全部在"设置 → dsh-mnemos"，大多即时生效。常用几项：

| 字段 | 作用 |
|---|---|
| `enabled` | 总开关 |
| `autoApprove` / `autoApproveConfidence` | 自动放行高置信度模型写入 / 阈值 |
| `injectionEnabled` / `injectLimit` / `injectMaxBytes` | 注入开关、条数与字节预算 |
| `protocolRefreshTurns` | 环境约定每隔 N 轮重注入（防上下文压缩） |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | 跨机同步：远端 / 后端 / 自动同步 |
| `distillAuto` / `distillEveryNTurns` | 自动提炼开关与间隔（次用户输入） |
| `sessionLogDirs` / `backfillEnabled` | 启动时回填历史会话日志 |
| `negativeMemoryEnabled` / `negativeMemoryTtlMs` | 失败命令拦截与失效时长 |

全部 31 个字段、YAML 片段、使用场景、故障排查：[docs/HANDOVER.md](docs/HANDOVER.md)。

## 与其他方案对比

### vs dsh-memento

两条路线。**dsh-memento** 是一个*能力缝*：类型化的 `ctx.memory` 契约、按轨×层的硬字符预算、dsh-memory-protocol 规范 + adapter 注册表（mem0 / Hermes / CLAUDE.md）+ 只读 MCP server——生态互操作强。**dsh-mnemos** 是完整记忆*产品*：提炼、规则/SKILL、完整生命周期、负面记忆、带数字的检索。

| 维度 | dsh-mnemos | dsh-memento |
|---|---|---|
| 检索 | FTS5 阶梯 + 二元组 RRF，**有公开基准数字** | 子串搜索（无 FTS5），无公开数字 |
| 生命周期 / 热度清理 / pinned | 有 | 无（刻意不做仓库） |
| 提炼 / 规则 / SKILL | 有（LLM，过门禁） | 无 |
| 负面记忆 | 有 | 无 |
| git 版本历史 + 跨机同步 | 有（每条记忆一个 .md） | 无 |
| 第三方写入 | 总线：身份烙印 + 审批队列 + 拉黑 + 撤销 | adapter 注册表（纯数据转换）+ MCP server |
| 协议规范 / MCP / adapter | 总线 + ABI + conformance；**暂无协议规范、暂无 MCP** | dsh-memory-protocol v1 + MCP + adapters |
| npm / releases | 尚未发布 | 已发布，多通道安装 |
| README | 英文 + 中文 | 5 种语言 |

### vs deja-vu

deja-vu 是 Go 写的记忆引擎，它的公开长期记忆基准我们用同口径复现。LongMemEval-S 我们赢（87.2% vs 85.3%）、LoCoMo 落后（60.9% vs 69.6%），细节见[效果](#效果)。在检索之上，我们还带了 deja-vu 没有的治理/生命周期层（审批门禁、信任分级、冲突替换提案、负面记忆、git）。

## 路线图（TODO）

诚实状态——这些是"功能可用且有数字"与"正式发布"之间的差距：

- [ ] **跨平台验证** —— 在 Linux 上开发；测试 Windows / macOS。
- [ ] **schema 升级路径测试** —— user_version 1 的迁移只在开发库上跑过。
- [ ] **npm 发布** —— 打包已就绪（`npm pack` 验证过）；发布 + 包名占用检查 + 装后验证待做。
- [ ] **蒸馏模式规模验证** —— 真实 LLM 蒸馏管线已接通、单题验证过；代表性样本（跨题型 10-20 题）还没跑（受 provider 配额/成本限制）。
- [ ] **压测** —— 并发写入、几千条记忆（索引/搜索性能）、长时间运行（WAL 膨胀、git 仓库膨胀）。
- [ ] **加固 `isomorphic` git 后端** —— 实测在慢网络下有概率超时/不稳；值得做一轮可靠性打磨，或把 `system` 定为推荐的同步后端。
- [ ] **MCP server** —— 对齐 memento 的只读 stdio server，供外部客户端查询。
- [ ] 可选：dsh-memory-protocol 规范 + adapter 注册表，对齐 memento 的生态面。

## 安全与数据

- **零网络、零凭据。** 本地 SQLite（WAL + FTS5），POSIX 0600。不改 DSH 引擎/agent 循环/apiproxy；只消费 `tools`、`commands`、会话信号。
- **每次写入都审计**（被拒的也记）。来源对模型可见（`trusted`/`untrusted`、写入者身份）。
- **失败即响亮。** 预算超限 → 结构化错误，绝不静默截断；库损坏/更新 schema → 加载时响亮失败。
- 数据位置：
  ```
  ~/.dsh/mnemos/mnemos.db     SQLite（WAL + FTS5）
  ~/.dsh/mnemos/repo/         git 记忆镜像（一条记忆一个 .md）
  ~/.dsh/mnemos/skills/       批准规则固化的 SKILL
  ~/.dsh/mnemos/backfill-checkpoint.json · distill-cursor.json   游标
  ```
- 漏洞上报：见 [SECURITY.md](SECURITY.md)。

## 机制对照（设计来源）

| dsh-mnemos 机制 | 对齐来源 |
|---|---|
| 冻结索引注入 + `memory_get` 下钻（检索≠注入） | engram / meow / memory-manager / LongMemEval |
| 幂律热度排序 + 强化计数 | dsh-evolve 衰减语义 |
| 有界占用 + 来源标记防投毒 | 2608.21230 / Veracium |
| 失败命令拦截 + 自失效（负面记忆） | dsh-negative-ledger / deja-vu |
| 活跃→归档→删除 + pinned（绝不硬删） | dsh-evolve 状态机 |
| 冲突替换提案（新值取代旧值，矛盾不静默丢弃） | StateMemBench / MELD |
| protocol 按轮次刷新（防压缩悬崖） | 2608.22752 |
| 开放测量 ABI + conformance | memento conformance suite |
| 效果账本 + 可复跑评测 | memlab / LongMemEval 方法论 |
| 第三方记忆总线（身份烙印 + 审批 + 拉黑 + 撤销） | memento adapters / tool-memory 共享 |
| 多来源历史导入（ChatGPT/Claude Code/Codex/DSH） | 迁移类工具惯例（导入即提炼） |

## 开发与验证

```sh
pnpm install
pnpm run typecheck
pnpm test                 # 151 个单测
pnpm run build:client     # 改了 src/client/ 后需要
```

一键完整验证（含真实环境）：

```sh
scripts/run-verify.sh     # typecheck+单测 → 确定性评测 → ABI conformance → 真实注册表组合
```

复现公开基准（数据下载见 [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md)）：

```sh
BENCH_DATA=/path/to/longmemeval_s_cleaned.json BENCH_SKIP_ABS=1 BENCH_LIMIT=470 \
  BENCH_OUT=scripts/bench/longmemeval-scorecard.json pnpm run bench:longmemeval
BENCH_DATA=/path/to/locomo10.json BENCH_OUT=scripts/bench/locomo-scorecard.json \
  pnpm run bench:locomo
```

## 许可

MIT
