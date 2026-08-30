<div align="center">

# dsh-mnemos

[English](README.md)

**有治理、会自我进化、可拓展的 DSH 跨会话记忆插件。** 

![CI](https://img.shields.io/github/actions/workflow/status/Rottenwooood/dsh-mnemos/ci.yml?branch=main&label=CI) ![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/tag/Rottenwooood/dsh-mnemos?label=version) ![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)
---
</div>


## 特色

整个设计挂在四条理念上。

1. **所有记忆经过门禁，可审计。** 每一次写入——模型工具、/memory、第三方插件、浏览器——都走同一个审批门禁：敏感/重复/越界的直接打回，有风险的等人工。模型/导入/第三方记忆标记"未验证"并在注入时设上限（防投毒）。每次写入/批准/拒绝都记审计。

2. **会自我进化、会自我修正。** 会话被提炼成记忆**和规则**。规则活在记忆库里、由 mnemos 注入模型；批准后还可以**提升为 DSH SKILL**——任何 agent 都能按需加载，让这份知识脱离 mnemos 也能在 harness 里用。事实就地更新（旧值 git 可回滚）；只有真正的冲突才变成**替换提案**交人裁决。热度清理让存储有界（活跃 → 归档 → 可还原；`固定` 永不离开）。

3. **数据可从其他Agent导入、可管理、可跨设备同步。** 本地 SQLite（WAL + FTS5）；每条记忆同时是一个 git 仓库里的 Markdown 文件——历史、diff、回滚、恢复、备份、可跨设备（通过push/pull）。可导入 ChatGPT / Claude Code / Codex / DSH 历史。

4. **开放记忆总线。** `ctx.mnemosBus` 是一条开放记忆总线：任何 DSH 插件都能接入， `recall` 记忆、`record` 自己的记忆（盖身份章、永远进人工审批队列）、`subscribe` 记忆变化——外加运行时拉黑和撤销。。详见[给开发者](#给开发者)。

## 功能

### 给使用者

- **模型工具**（模型在会话里自己用）：
  `memory_search`（主动检索）· `memory_record`（单条即写即审，可原地更新旧记忆）· `memory_distill`（批量提炼缓冲会话→记忆/规则候选，增量去重）· `memory_list` · `memory_stats`。
- **注入**  每个会话开头注入一次**记忆索引**（每条一行：类型·短id·主题·关键词，字节稳定，命中 KV 缓存，token消耗极少）；模型要详细信息用 `memory_get`或 `memory_research` 查询。时间间隔大于N分钟且检测到关键词时，再次注入对应的记忆索引。
- **环境约定**  `protocol` 类型的记忆（环境约定，如沙箱规则）走**独立通道**：每会话首步注入一次、上下文压缩完成后重新注入，保证在 agent 行动前始终在场；**不进入记忆索引**。
- **命中** `memory_get`与`memory_search`执行即视为命中。
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
- **浏览器界面**（better-sidebar「记忆」页签）：概览、待审批（批准/拒绝/编辑后批准/批量批准低风险）、记忆列表（搜索/筛选/编辑/版本历史/回滚/删除）、已删除恢复、被拒历史、git 同步。
- **提炼。** 与 `memory_record` 的单条即写即审不同，提炼把**整段对话缓冲**交给独立提炼角色**批量**挖掘：一次性产出记忆候选、规则候选与冲突替换提案，增量游标保证不重复处理已提炼过的内容。每条带 2-5 个关键词（触发注入），全部过门禁；冲突强制人工裁决，规则类走规则提案；批准后的规则由 mnemos 注入模型，还能**提升为 DSH SKILL**，任何 agent 都能通过 DSH 的 `skill` 工具按需加载，让这份知识脱离 mnemos 也能用。


### 给开发者

#### 开放记忆总线 —— `ctx.mnemosBus`

dsh-mnemos 不只是给模型和人用——它把记忆库通过总线开放给**任何其他 DSH 插件**。插件用 `ctx.inject(['mnemosBus'])` 挂上，拿到三个原语：

| 原语 | 干什么 | 护栏 |
|---|---|---|
| `bus.recall({ query, limit })` | 搜索记忆（或按作用域/工作区列出）。只读——绝不写入、绝不计入效果账本。 | — |
| `bus.record(input, identity)` | 申请写入一条记忆。 | **必须声明身份**（`{ name, version }` → 盖 `plugin:<名字>@<版本>` 章、`source: third_party`）。写入**永远进人工审批队列**——不管置信度多高，绝不直接落库、绝不自动放行。记审计。 |
| `bus.subscribe(listener)` | 订阅存储变化：新记忆落库 / 提案待审 / 记忆被替换 / 记忆被撤销 / 规则被批准。 | 订阅方报错也不会弄坏总线。 |

对每一次第三方写入都生效的治理：

- **运行时拉黑** —— `bus.blacklistPlugin('名字', 原因)`（或 `/memory bus blacklist`）：从那一刻起该插件的写入全部拒绝并记审计。`unblacklistPlugin` / `listBlacklist` 管理。
- **可撤销** —— `bus.revoke(memoryId, identity)`：第三方写入可以被删除，但只有**写入方插件**或**人类**能撤。
- **按写入者归属** —— `bus.state()` / `bus.listByWriter(name)`，让审批面板能按"哪个插件提的"分组。

所以另一个插件得到的待遇和模型**完全一样**：身份烙印、审批门禁、审计轨迹、紧急关停。**总线默认不信任任何东西**——跟 mnemos 共享记忆是有权限的，不是默认开放的。

#### 测量 ABI —— `ctx.mnemosAbi`

版本化的 `recall / get / state / probe`，让外部工具和评测读到真实数字（活跃/待审批/未验证/已验证/注入/命中率）。`scripts/conformance.mts` 证明它就是实际实现，不是空壳。

#### 导入适配器

`src/domain/imports/` —— chatgpt、claude-code、codex、dsh，自动格式检测在 `detect.ts`。

## 效果

### 确定性效果评测

```sh
# 在 deepseek-harness 目录运行
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

### 公开数据集基准（LongMemEval-S / LoCoMo-10）

在产品检索路径（FTS5 多级阶梯：全词 AND → 任词 OR → 包含扫描，再与二元组相似度做 RRF 融合）上测得，与 deja-vu 官方公布数字同口径。方法论详见 [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md)。

| 数据集 | dsh-mnemos 产品路径 | deja-vu 官方 |
|---|---|---|
| LongMemEval-S（cleaned, 470 题, hit@1） | **87.2%** | 85.3% |
| LoCoMo-10（1982 QA, R@1） | 60.9% | 69.8% |

说明：

- **LongMemEval-S：** 每一项指标都超过 deja-vu（hit@1 87.2% vs 85.3%、MRR 0.914 vs 0.896、evidence-recall@1 56.3% vs 55.0%）。
- **LoCoMo-10：** 落后（60.9% vs 69.8%）。LoCoMo 会话更长、问题更依赖跨会话推理；deja 的词形还原（stem）层和更强的排序变体在这里占优。缩小差距在路线图上，不是缺陷。
- **口径诚实：** deja-vu 的官方数字已在本机**真实复现**（go1.25，跑其官方 `scripts/longmemeval` / `scripts/locomo`，同数据、同指标、同问题原文）：LongMemEval-S hit@1=85.3%、LoCoMo R@1=69.8%。复现命令见 [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md)。

## 安装与快速开始

**兼容性**：在 **Linux / Node ≥ 22.19 / DSH web profile** 上开发并验证；Windows/macOS 尚未测试。

```sh
# npm 通道
dsh plugin --profile web add dsh-mnemos

# git 通道
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
| `protocolInjectEnabled` | 注入环境约定（`protocol`）记忆——每会话首步注入一次，上下文压缩完成后重新注入；**不进记忆索引** |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | 跨机同步：远端 / 后端 / 自动同步 |
| `distillAuto` / `distillEveryNTurns` | 自动提炼开关与间隔（次用户输入） |
| `cleanupDays` | 清理失效天数：多久没有注入/命中且未更新的记忆进入归档候选 |
| `sessionLogDirs` / `backfillEnabled` | 启动时回填历史会话日志 |

全部 34 个字段、YAML 片段、使用场景、故障排查：[docs/HANDOVER.md](docs/HANDOVER.md)。

## 与其他方案对比

### vs dsh-memento

两条路线。**dsh-memento** 是一个*能力接缝*：类型化的 `ctx.memory` 契约、按轨×层的硬字符预算、dsh-memory-protocol 规范 + adapter 注册表（mem0 / Hermes / CLAUDE.md）+ 只读 MCP server——生态互操作强。**dsh-mnemos** 是完整记忆*产品*：提炼、规则/SKILL、完整生命周期、带数字的检索。

| 维度 | dsh-mnemos | dsh-memento |
|---|---|---|
| 检索 | FTS5 阶梯 + 二元组 RRF，**有公开基准数字** | 子串搜索（无 FTS5），无公开数字 |
| 生命周期 / 热度清理 / pinned | 有 | 无 |
| 提炼 / 规则 / SKILL | 有（LLM，过门禁） | 无 |
| git 版本历史 + 跨机同步 | 有（每条记忆一个 .md） | 无 |
| 第三方写入 | 总线：身份烙印 + 审批队列 + 拉黑 + 撤销 | adapter 注册表（纯数据转换）+ MCP server |
| 协议规范 / MCP / adapter | 总线 + ABI + conformance；暂无 MCP | dsh-memory-protocol v1 + MCP + adapters |
| npm / releases | 尚未发布 | 已发布，多通道安装 |
| README | 英文 + 中文 | 5 种语言 |

### vs deja-vu

deja-vu 是 Go 写的记忆引擎，它的公开长期记忆基准我们用同口径复现。LongMemEval-S 我们赢（87.2% vs 85.3%）、LoCoMo 落后（60.9% vs 69.8%），细节见[效果](#效果)。在检索之上，我们还带了 deja-vu 没有的治理/生命周期层（审批门禁、信任分级、冲突替换提案、git）。

## 路线图

诚实状态——这些是"功能可用且有数字"与"正式发布"之间的差距：

- [ ] **跨平台验证** —— 仅在 Linux 上开发；尚未测试 Windows / macOS。
- [ ] **schema 升级路径测试** —— user_version 1 的迁移只在开发库上跑过。
- [ ] **npm 发布** —— 打包已就绪（`npm pack` 验证过）；发布 + 包名占用检查 + 装后验证待做。
- [ ] **蒸馏模式规模验证** —— 真实 LLM 蒸馏管线已接通、单题验证过；代表性样本（跨题型 10-20 题）还没跑（受 provider 配额/成本限制）。
- [ ] **压测** —— 并发写入、几千条记忆（索引/搜索性能）、长时间运行（WAL 膨胀、git 仓库膨胀）。
- [ ] **加固 `isomorphic` git 后端** —— 实测在慢网络下有概率超时/不稳；值得做一轮可靠性打磨，或把 `system` 定为推荐的同步后端。
- [ ] **MCP server** —— 对齐 memento 的只读 stdio server，供外部客户端查询。
- [ ] 可选：dsh-memory-protocol 规范 + adapter 注册表，对齐 memento 的生态面。


## 机制对照（设计来源）

| dsh-mnemos 机制 | 对齐来源 |
|---|---|
| 冻结索引注入 + `memory_get` 下钻（检索≠注入） | engram / meow / memory-manager / LongMemEval |
| 幂律热度排序 + 强化计数 | dsh-evolve 衰减语义 |
| 有界占用 + 来源标记防投毒 | 2608.21230 / Veracium |
| 活跃→归档→删除 + pinned（绝不硬删） | dsh-evolve 状态机 |
| 冲突替换提案（新值取代旧值，矛盾不静默丢弃） | StateMemBench / MELD |
| 环境约定按会话首步+压缩后重注入（防压缩悬崖） | 2608.22752 |
| 开放测量 ABI + conformance | memento conformance suite |
| 效果账本 + 可复跑评测 | memlab / LongMemEval 方法论 |
| 第三方记忆总线（身份烙印 + 审批 + 拉黑 + 撤销） | memento adapters / tool-memory 共享 |
| 多来源历史导入（ChatGPT/Claude Code/Codex/DSH） | 迁移类工具惯例（导入即提炼） |

## 开发与验证

```sh
pnpm install
pnpm run typecheck
pnpm test                 # 156 个单测
pnpm run build:client     # 改了 src/client/ 后需要

scripts/run-verify.sh     # typecheck+单测 → 确定性评测 → ABI conformance → 真实注册表组合
```


## 许可

MIT

## Star History

<a href="https://www.star-history.com/?repos=Rottenwooood%2Fdsh-mnemos&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&theme=dark&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
 </picture>
</a>