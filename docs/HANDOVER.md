# dsh-mnemos 交接文档（HANDOVER）

> 完整的功能清单、实现方案、操作手册、全部 33 个配置字段、使用场景与故障排查、实现亮点与改进方向。
> 面向维护者与深度使用者；新用户请先看 [README](../README.md)。

---

# dsh-mnemos

**DSH 跨会话记忆插件**：有治理、会自我进化、写入门禁的长期记忆系统。

- 模型在会话里写的/提炼出的记忆跨会话保留，下一次会话开头自动注入（模型"记得你"）。
- 所有写入过**两级门禁**（程序检查 → 风险分诊），敏感/重复/越权写被硬打回并留审计。
- 自进化：会话隔离提炼 → 记忆提案 → 人工审批 → 记忆注入 / SKILL 正式化。
- 数据全本地：SQLite（`node:sqlite` + FTS5 + WAL）+ git 版本化 Markdown 镜像（历史/回滚/跨机同步/备份）。
- 无 LLM 依赖的确定性召回：FTS5 BM25 与 bigram-Jaccard 的 **RRF 融合**（dsh-evolve 机制）。

> 状态：M0–M5 全部完成并在真实 `dsh web` profile 装运行，156 个单测 + typecheck 全绿。

---

## 一、一句话架构

```
模型/用户/第三方 ──工具 /memory /总线──▶ MemoryService（唯一写入路径）
                                          │  ① 程序检查（预算/敏感/去重/作用域/黑名单）
                                          │  ② 风险分诊（自动放行 / 进待审批队列）
                                          ▼
                           SQLite (memories/audit/approval/usage_ledger)
                                     │      └─  git Markdown 镜像（版本化/同步/备份）
                                     ▼
                        注入（每会话冻结快照）/ 总线通知 / 管理界面 / 提炼流水线
```

写入路径只有一条，且全部可审计；浏览器、模型工具、命令、第三方插件都不能绕过治理。

---

## 二、已完成的全部功能

### M0 · 门禁写入路径（核心，一切围绕它）

- **两级门禁**（`src/domain/service.ts`）：
  1. **程序检查**（确定性，命中即打回 + 审计 `denied=1`）：字节/条数预算、敏感内容、内容哈希精确去重、模型禁写全局作用域、写入者黑名单。
  2. **风险分诊**：人类写入直接落库；模型写入**高置信度 + 工作区 + 带溯源证据**的自动放行（用户锚定，见下）；其余进待审批队列。
- **用户锚定放行**（对齐 dsh-evolve / evolve-modes）：自动放行**不看模型自报的类型**（模型自报标签豁免 = 没有门禁），只认"工作区（可逆）+ 置信度 ≥ 阈值 + evidence 非空（证据逐字来自用户消息）"。
- **审计**：每次写入/批准/拒绝/替换/撤销/回滚/旧结构迁移都落 `audit` 表，`by_agent` 标模型发起、`denied` 标被程序打回。
- **敏感检测**（`sensitive.ts`）：正则 + 熵检测（API key、token、密钥特征）。可用 `sensitivityCheckEnabled` 整个关闭。

### M1 · 装完即满 + 冷热分层注入

- **历史导入**：Claude Code / Codex / ChatGPT / **DSH 历史会话** 四种适配器 + 自动格式检测；DSH 日志是拼接的 **zstd 多帧**，逐帧解压。导入只把消息**吸入提炼缓冲**（不做任何正则启发式抽取），随后由 LLM 提炼生成记忆。
- **回填**（`backfill.ts`）：增量 + 断点续传（字节 checkpoint）；启动时扫描 `sessionLogDirs`，消息进提炼缓冲。
- **关键词触发注入**（`recall.ts` + `hooks.ts`）：**低频**扫描——仅当 `agent/pre-step` 携带**新的用户消息**时，把用户文本与每条记忆的 `keywords`（无关键词则回退 topic）做子串匹配；命中即在下一条模型请求注入该记忆。无启发式、无嵌入、无每会话冻结快照。每次命中记一次 `usage_ledger`。

### M2 · 自进化（提炼流水线 + SKILL）

- **提炼流水线**（`distill.ts`）：**隔离专职角色**（独立 system prompt，不继承主对话历史）→ 严格 JSON 输出 → schema 校验（不合法即丢弃计数，绝不半生效）→ 过门禁。复用 DSH 已配置的 LLM，**无需单独 API key**（`llmProvider`/`llmModel` 留空自动回落到 `agent-default-model`）。
  - 每条记忆由 LLM 写 **`keywords`**（2-5 个简短、可区分的词/短语，用户日后可能原样说出，如 `pnpm`、`deploy to us-east-1`）——它们是关键词触发注入的依据。工具的说明与提炼 prompt 都会指导 LLM 怎么写。
  - 事实、流程、偏好、失败、决策都进入普通记忆；`protocol` 记忆走独立环境约定注入通道。
  - **冲突裁决**：同一话题说法不同 → 打标**替换提案**（`proposeReplacement`），强制人工裁决，批准后替换原记忆，绝不自动放行。
- **SKILL 正式化**（`skill.ts`）：`memory_to_skill` 仅处理活跃的非 `protocol` 记忆，写入 `SKILL.md`（frontmatter + 来源证据）成功后软删除源记忆。
- **三层触发时机**：① **模型工具** `memory_distill`（LLM 主动调用）② **每 N 次用户输入自动执行**（`distillAuto` + `distillEveryNTurns`，按用户消息计数，非定时器）③ **手动**（"现在提炼"按钮 / `/memory distill`）。增量用每会话游标（序号 + 内容哈希）。

### M3 · 开放记忆总线（`bus.ts` + `ctx.mnemosBus`）

- **三原语**：`recall`（只读查询，从不写）、`record`（申请写入，**必须声明身份** 插件名+版本）、`subscribe`（订阅变化：新记忆/提案/替换/撤销）。
- **第三方治理**：第三方写入盖章 `plugin:<name>@<version>`、`source=third_party`，**只能进审批队列**（绝不直接落库）；运行时拉黑（`bus_blacklist` 表）后其写入即拒绝并审计；撤销只允许写入者本人或人类。
- 按写入者分组 `listByWriter`，供审批面板按来源过滤。

### M4 · git 版本管理 + 跨机同步 + 备份

- **Markdown 镜像**（`mirror.ts`）：一条记忆一个 `.md`，可读 diff、逐条 git 历史；镜像可从 store 同步、也可回灌 store。
- **GitBackend 抽象**：**isomorphic-git（纯 JS，默认，免系统 git）** 与**系统 git CLI** 双后端，同一套 GitStore 单测参数化全过。
- **每条记忆变更自动提交**（记忆 add/delete/edit/批准/回滚后 1s 去抖提交），消息关联审计。
- **逐条合并同步**：`pull` 时独立条目自动合并（最新胜出），**同条目双端修改标记冲突交人裁决，绝不静默覆盖**；合并成功回灌 store。
- **回滚 / 恢复**：`show` 任意 sha 内容、一键回滚、已删除记忆从 git 历史恢复（软删除行仍在 store）。
- **备份**：`exportBundle` 生成标准 `# v2 git bundle`，新装仓库自动播种初始提交。
- 已知限制：isomorphic 后端支持 **https 同步**（真实 node http 客户端 + 自动读取 `~/.git-credentials` 鉴权，与系统 git 同一套凭据）；**本地路径 remote**（`git@` 或裸目录）仍用 `gitBackend: system` + 裸仓库。push/pull 失败时返回真实错误信息（不再吞成 push-failed）。

### M5 · 真实 DSH 界面

- **设置页**（浏览器"设置 → dsh-mnemos"，`settings.section` id `mnemos`）：schemastery schema 驱动 33 个配置字段，分 开关/存储/门禁/注入/导入/提炼/git 七组；用户覆盖持久化、变更**实时重应用**（门禁、注入开关、git 远程 URL 即时生效；结构字段需重启）。底部含**导入历史会话**工具（选来源 + 目录 → 扫描预览 → 导入）。
- **管理页签**（better-sidebar `registerTab`，标题"记忆"）：
  - 概览（条数/待审批/上限）+ 现在提炼 + **清理失效**（长期未用未更新的记忆）+ **导出 JSON** + 刷新
  - **命中热力图**（近 30 天，`usage_ledger` 驱动）+ 累计命中/去重会话数
  - 待审批：批准 / 拒绝 / **编辑后批准** / **批量批准低风险**（工作区项目事实 + 高置信度）
  - 记忆列表：搜索 + **类型筛选**；每条可 编辑 / **版本历史**（查看任意 sha 内容、一键回滚）/ 删除
  - **已删除区**：一键从 git 恢复
  - **被拒历史**：按来源（proposedBy）过滤
  - git 同步：pull / push / 备份
- **Host RPC**（`/mnemos/api/*`，`webServer.register({kind:'prefix'})`，仅 web profile 挂）：所有浏览器操作都走 `MemoryService` 门禁与 `GitStore`，浏览器不能绕过治理。

### 后续修复与生态对齐

- **usage_ledger 单一数据源**：命中/热力图全部由账本表聚合（`usageStats()`），`recordHit` 记为注入事件。
- **RRF 确定性召回**：`service.search` 把 store 的 FTS5 BM25（或 LIKE 回退）与 active 记忆的 bigram-Jaccard 排名做 Reciprocal Rank Fusion（k=60），`memory_search` 工具、`/mnemos/api/search`、命令搜索全部走它（dsh-evolve 零 token 召回）。
- **/memory 命令名**：卸载 dsh-memento 后夺回自然命令名（原为避开冲突用 `/mnemos`）。
- **管理台空参数修复**：`?type=`（全部类型）正确归一化为"不过滤"。

### 2026 计划落地（docs/QUALITY_PLAN_2026.md）

P0 效果账本/评测/仪表、P1 冻结索引+memory_get 下钻+幂律热度、P2 遗忘归档/pinned/知识接替链、P3 防投毒（有界占用+trust）/开放测量 ABI+conformance/压缩防御（protocol 刷新轮次）全部落地。验证入口：

- 一键：`scripts/run-verify.sh`（typecheck+单测 → 评测 → conformance → 真实组合）
- 真实组合（harness 目录）：`node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/verify-real-composition.mts`
- conformance（harness 目录）：`node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/conformance.mts`

新表：`memories.trust/pinned/supersedes_id/superseded_by_id`、`memories` 增 `observation_count/accessed_at`（幂律热度输入）。开放 ABI 为 `ctx.mnemosAbi`（`recall/get/state/probe`），bus 对齐到 `recall/get/state`。

> 注：P2.3"场景+人格整合"曾实现后**移除**（评审结论：人格与源记忆同源信息重复注入、纯冗余；场景无运行时作用且都不可编辑）。`scenes`/`persona` 表、`consolidation` 相关命令/路由/设置/客户端区块已全部删除。

---

## 三、安装后用户可用的全部新增操作

### 模型可见（DSH 会话里，工具）
| 工具 | 作用 |
|---|---|
| `memory_search` | 跨会话搜索记忆（RRF 混合召回），参数 `query`/`scope`/`limit` |
| `memory_record` | 单条即写即审：提议写一条记忆，参数 `topic`/`summary`/`detail`/`keywords`/`type`/`scope`/`confidence`；过门禁（committed / proposed / denied）。`keywords` 是触发注入的关键词；`replaceMemoryId` 可原地更新旧记忆（git 可回滚，不新建重复条目） |
| `memory_distill` | 批量提炼缓冲会话（或转录文件）→ 记忆候选，独立提炼角色 + 增量游标去重 + 冲突强制人工，LLM 为每条记忆写 keywords；过门禁 |
| `memory_to_skill` | 将一条活跃的非 `protocol` 记忆正式化为 SKILL.md，写入成功后软删除源记忆 |
| `memory_list` | 列出 active 记忆，按 `scope`/`workspace`/`type` 过滤 |
| `memory_stats` | 统计：总数、按作用域/类型分布、门禁配置 |

### 人类命令（输入区 `/memory`）
```
/memory search <query>                      搜索
/memory list | stats                        列出 / 统计
/memory approve <id> | reject <id>          审批（仅人类，模型不能自批）
/memory import <auto|claude|codex|chatgpt|dsh> <path>   导入（进提炼缓冲）
/memory backfill <session-log-dir>          回填（进提炼缓冲）
/memory distill [path]                      提炼缓冲会话（或给定转录文件）
/memory skill list
/memory bus <blacklist|unblacklist|list|revoke|writers>  第三方治理
/memory git <status|log|rollback|restore|remote|push|pull|backup>
```

### 浏览器界面
- **设置 → dsh-mnemos**：全部配置 + 导入历史会话。
- **better-sidebar「记忆」页签**：概览/热力图/待审批/记忆管理/已删除/被拒历史/git 同步。

### RPC 端点（`/mnemos/api/*`，浏览器同源调用）
`stats` · `usage?days=` · `pending` · `memories?scope=&workspace=&type=&status=` · `search?q=` · `memory/delete` · `memory/edit` · `models` · `import/sources` · `import/preview?dir=` · `import/run` · `approve` · `approve/batch` · `history?state=&source=` · `export?id=` · `cleanup?days=` · `cleanup`(POST) · `distill` · `git/status` · `git/history?id=` · `git/show?id=&sha=` · `git/rollback` · `git/restore` · `git/push` · `git/pull` · `git/backup`

### 数据文件
```
~/.dsh/mnemos/mnemos.db             SQLite（WAL + FTS5）
~/.dsh/mnemos/repo/                 git 记忆镜像仓库
~/.dsh/mnemos/skills/               记忆正式化生成的 SKILL.md
~/.dsh/mnemos/backfill-checkpoint.json · distill-cursor.json   游标
```

---

## 四、极其详尽的配置指南

### 4.1 全部 33 个字段

修改方式：浏览器设置页（即时生效项标注）；或 `cordis.patch.yml` 按 id 覆盖插件 config；重启后 `settings.yaml` 分层叠加。

| 键 | 类型 | 默认 | 说明 | 生效 |
|---|---|---|---|---|
| `enabled` | bool | `true` | 插件总开关：关 = 注入/采集/提炼/回填/同步全静默，数据保留 | 即时 |
| `dbPath` | string | `~/.dsh/mnemos/mnemos.db` | SQLite 文件路径 | 重启 |
| `maxEntries` | number | `5000` | 记忆条目硬上限（超了拒绝写入） | 即时 |
| `maxBytesPerEntry` | number | `8192` | 单条 (topic+summary+detail) 字节硬上限 | 即时 |
| `autoApprove` | bool | `true` | 自动放行高置信度用户锚定写；关 = 所有模型写都进队列 | 即时 |
| `autoApproveConfidence` | number | `0.9` | 自动放行置信度阈值 | 即时 |
| `allowModelGlobalWrite` | bool | `false` | 模型可否直接写全局作用域（默认拒绝） | 即时 |
| `blacklist` | string[] | `[]` | 永远拒绝的写入者（插件名） | 即时 |
| `sensitivityCheckEnabled` | bool | `true` | 敏感内容检测（密钥/熵特征） | 即时 |
| `defaultScope` | enum | `workspace` | 提炼/导入/回填的默认作用域 | 即时 |
| `injectionEnabled` | bool | `true` | 跨会话记忆注入总开关（agent/pre-step） | 即时 |
| `injectLimit` | number | `8` | 每次会话注入的记忆条数上限 | 即时 |
| `injectMinHits` | number | `0` | 自动注入最低跨会话命中次数（≥1 只注入被反复用过的） | 即时 |
| `injectMaxBytes` | number | `2048` | 注入投影字节预算（硬限制） | 即时 |
| `sessionLogDirs` | string[] | `[]` | 启动回填扫描的会话日志目录 | 重启 |
| `backfillEnabled` | bool | `true` | 启动时回填；关 = 仅手动 | 重启 |
| `importCaller` | enum | `human` | 导入写入方：human=直接落库，model=进审批队列 | 即时 |
| `skillsDir` | string | `~/.dsh/mnemos/skills` | 记忆正式化为 SKILL.md 的目录 | 重启 |
| `llmProvider` | string | `''` | 提炼用 provider；留空用 DSH `agent-default-model` | 即时 |
| `llmModel` | string | `''` | 提炼用模型；留空同上 | 即时 |
| `distillAuto` | bool | `false` | 自动提炼；开 = 每 N 次用户输入自动执行 | 即时 |
| `distillEveryNTurns` | number | `5` | 自动提炼间隔（次用户输入） | 即时 |
| `distillWindow` | number | `200` | 单次提炼缓冲消息数 | 即时 |
| `cleanupDays` | number | `90` | 清理失效天数：多久没有注入/命中且未更新的记忆进入归档候选 | 即时 |
| `memoryRepoDir` | string | `~/.dsh/mnemos/repo` | git 镜像仓库目录 | 重启 |
| `gitVersioning` | bool | `true` | 记忆变更自动 git 提交 | 即时 |
| `gitBackend` | enum | `isomorphic` | `isomorphic`（纯 JS）/ `system`（系统 git CLI） | 重启 |
| `gitRemoteName` | string | `origin` | 同步远程名 | 即时 |
| `gitRemoteUrl` | string | `''` | 同步远程 URL；**保存即重定向 origin** | 即时 |
| `syncEnabled` | bool | `false` | 自动跨机同步（pull→push） | 即时 |
| `syncIntervalMinutes` | number | `1440` | 自动同步间隔（分钟） | 即时 |

### 4.2 典型配置片段（cordis.patch.yml）

```yaml
- id: dsh-mnemos
  config:
    enabled: true
    autoApprove: true
    autoApproveConfidence: 0.9
    injectLimit: 8
    injectMinHits: 1          # 只注入被多次用过的记忆
    injectMaxBytes: 2048
    defaultScope: workspace
    distillAuto: true
    distillIntervalMinutes: 720
    sessionLogDirs: ["~/.dsh/sessions"]
    backfillEnabled: true
    importCaller: human
    gitVersioning: true
    gitBackend: isomorphic
    gitRemoteName: origin
    gitRemoteUrl: "git@github.com:you/mnemos-memories.git"
    syncEnabled: true
    syncIntervalMinutes: 1440
    llmProvider: ""           # 留空 = 用 DSH 默认模型提炼
    llmModel: ""
```

### 4.3 使用场景速查

1. **首次安装**：`dsh plugin --profile web add dsh-mnemos` → 重启 `dsh web` → 浏览器"设置 → dsh-mnemos"确认页出现 → better-sidebar 出现"记忆"页签。
2. **记一条记忆**：会话里让模型"记住：用 pnpm 安装依赖"（模型会调 `memory_record`），或直接在设置页导入历史会话。
3. **查看**：better-sidebar"记忆"页签；搜索 + 类型筛选；点"版本历史"看任意 sha 并一键回滚。
4. **审批**：模型写的高风险/无证据记忆进"待审批"，人类批准/拒绝/编辑后批准/批量批准。
5. **提炼**：点"现在提炼"（或用 `/memory distill`）；`distillAuto: true` 可定时。
6. **记忆与 SKILL**：`/memory list` 查看活跃记忆；模型可调用 `memory_to_skill` 将已批准的非 `protocol` 记忆正式化为 SKILL.md，写盘成功后源记忆软删除。
7. **第三方插件**：走 `ctx.mnemosBus.record()`（必须声明身份），写入只能进审批；`/memory bus blacklist <plugin>` 拉黑。
8. **跨机同步**：设置 `gitRemoteUrl` + `syncEnabled`，或手动 `/memory git pull` / `push`；冲突时 `/memory git status` 看冲突文件，人工裁决后回滚/保留。
9. **备份**：设置页"git 同步 → 备份"（或 `/memory git backup /path/out.bundle`）。

### 4.4 故障排查
- 记忆页空："全部类型"下空 → 确认是本插件库（卸载 memento 后模型走 `memory_record`）；`curl :3080/mnemos/api/memories?scope=workspace&type=` 应返回数据。
- 注入不出现：`injectionEnabled`/`enabled` 是否开、`injectMinHits` 是否太高、该会话是否已冻结（每会话一次，写后才刷新）。
- 端口 3080 被占：`fuser -k 3080/tcp` 后重启。
- 提炼不跑：`llmProvider`/`llmModel` 留空时需要 DSH `agent-default-model` 已配置。

---

## 五、实现新颖性亮点（当前）

1. **零 token 确定性召回**（RRF = FTS5 BM25 ⊕ bigram-Jaccard，k=60）——同 dsh-evolve，不耗 LLM/嵌入。
2. **用户锚定自动放行**——放行条件不含模型可自报的字段，只认"工作区 + 置信度 + 溯源证据"（反"自我豁免"）。
3. **每会话冻结快照 + 变更 revision 刷新**——一次会话一份投影，写后即时刷新，兼顾 prompt cache 与新记忆可见。
4. **冲突即替换提案**——语义近似但说法不同的写不打成新记忆，而强制人工裁决替换。
5. **记忆即代码**——一条记忆一个 Markdown 文件走 git：逐条历史/diff/回滚/恢复、逐条合并同步、标准 bundle 备份。
6. **usage_ledger 单源统计**——命中/热力图/去重会话数全部由账本表聚合，天然支持"清理失效"与热排序。
7. **双 git 后端抽象**——纯 JS 免系统依赖，系统 CLI 保本地裸仓库同步能力。

---

## 六、改进方向（用户体验 × 实现新颖性，无上限，供取舍）

> 以下按"投入从轻到重"排，均不承诺落地，作为迭代弹药。参考文献/仓库用于吸收思想，不是照搬。

### A. 用户体验

1. **注入可视化**：会话里显式展示"本次注入了 N 条记忆"（每条一行 + 溯源链接），用户一眼知道模型"记得什么"、为什么这么答。参考 Vercel 等 agent 面板的"context 面板"。
2. **证据回链到原文**：记忆/热力图点某条 → 跳到源会话对应消息（DSH 会话日志已解压可定位 `(sessionId, eventRange)`）。
3. **冲突裁决向导**：并排 diff（旧 vs 新）+ 三键（保留旧/替换/合并），而不是纯文本审批行。
4. **记忆时间线/热区视图**：热力图点击某天 → 当天命中列表下钻；加"最近未用"置灰。
5. **设置页分层**：33 个字段拆"基础/进阶/专家"，默认只露基础；开关配"我不知道该开还是关"的合理化建议。
6. **冷启动引导**：首次安装弹引导，扫描历史会话 → 建议导入 → 一键批准低风险。
7. **批量审批增强**：全选/按来源批量、快捷键（j/k 选择 + a/r 审批）、操作可撤销（软删已支持）。
8. **移动端/窄屏**：better-sidebar 页签做响应式；热力图可横滑（已有 overflow）。

### B. 实现新颖性（含论文/高星仓库思想）

1. **记忆衰减与强化**（轻量，收益高）：把现有 `usage_ledger` 时间戳换成**热力学冷度** `H = 1/(1+λ·Δt)^α`，时间基准用 `accessedAt||createdAt` 而非 `updatedAt`（dsh-evolve v0.4.2）；配合**观察计数强化**（重复观测 → 计数+1、importance 提升、保留更佳表述，不盲目覆盖）。吸收 Ebbinghaus 遗忘曲线。→ 清理失效/热排序立即升级。
2. **层次化记忆（L0→L3 金字塔）**：曾实现 L2 场景分组 + L3 人格画像（TencentDB Agent Memory 思想），后**移除**——人格与源偏好记忆同源信息重复注入（纯冗余），场景无运行时作用且均不可编辑。结论：抽象层除非"批准即取代源记忆"且可编辑，否则不如不做。
3. **MemGPT 式记忆分页/虚拟上下文**：记忆不一次全注入，而是像 OS 页换入换出——主记忆驻留、档案/工作记忆按需换入，冷数据 paged 到"磁盘"（SQLite 已天然冷存储）。参考 Letta（原 MemGPT，高星）的核心论文 "MemGPT: Towards LLMs as Operating Systems"。
4. **检索升级**：
   - 稀疏侧：给 FTS5 上 `sqlite-vec`（或 ollama 本地嵌入）做**稠密检索**，与现有稀疏 RRF 再做一层混合；参考 "ColBERT 后期交互"、"Hybrid search"（BM25 + dense）工程实践。
   - 查询改写：零成本做法是给 `memory_search` 一次"查询生成"（把当前消息转成 2–3 个检索子查询再 RRF）。
5. **Agentic 记忆抽取**（论文方向）：
   - "A-Mem"（Agentic Memory，2024）的**记忆生成-更新分离**与时间戳感知。
   - "Reflexion"/"Self-Refine"：任务失败后自动提炼"失败教训"（error_fix），而非只等用户教。
   - 用 **LoCoMo / LongMemEval** 基准评测插件检索精度，用数据驱动召回参数。
6. **贝叶斯置信度更新**：每条记忆带先验置信度，新证据做贝叶斯更新而非"直接替换/直接放行"；与现有冲突裁决结合，替换提案显示"证据强度差异"。参考 knowledge tracing / calibration 文献。
7. **记忆安全**（重要且常被忽略）：研究 **memory poisoning / 提示注入经记忆回放**的攻防（OWASP LLM Top 10；论文 "Not what you've signed up for" 对上下文注入的实证）。门禁里加"注入内容来源标记 + 敏感词回放过滤"，测试记忆投毒路径。
8. **记忆即代码的协作流**：git 已有，升级为 **PR 式记忆审查**——变更集（diff 摘要）、review/approve/reject、CI 检查（budget/敏感/重复）在 commit 前拦截；跨机用 git 做**联邦记忆**（多机合并、冲突标记已有雏形）。参考 git-worktree 式"记忆分支 + 合并"。
9. **隐私与可移植**：本地加密存储（age/gpg）可选开启；一键**导出/擦除**（GDPR 式 right to forget，已有 `export`）；记忆格式公开为开放标准（参考 memory-standard 的 `mm://` URI + JSON Schema，跨 agent 互认）。
10. **调度与预算**：
    - 提炼/同步用 **skillopt 式夜间批处理**（默认 22:00 全量演进，白天只做免费维护）而非均匀间隔。
    - 注入预算从"字节"升级为 **token 预算**（用 `llm.tokenize` 精确控制），避免 CJK/长摘要把预算吃光。

### C. 高星仓库参考清单（吸收思想用）
- **Letta / MemGPT**：记忆分页、虚拟上下文管理。
- **Mem0**：两阶段抽取-更新流水线、评分/去重/更新策略。
- **Zep**：时间知识图谱记忆 + 图查询。
- **LangMem**（LangChain）：记忆服务化、记忆"写者角色"。
- **TencentDB Agent Memory**：L0–L3 金字塔（dsh-self-improved 已引）。
- **dsh-evolve**：RRF 召回、热力学衰减、tiered approval（本项目已部分吸收）。
- **memory-standard / patchouli / MemOS**（DSH 生态）：开放标准、update/retrieve/subscribe 服务缝、多 agent 共享。

---

## 七、开发

```sh
pnpm install
pnpm run typecheck
pnpm test                 # 156 个单测
pnpm run build:client     # 产出 lib/client.js（浏览器半，改 client/ 后必跑）
```

> 已卸载 dsh-memento（本插件与它都在时，模型会优先用 memento 的 `memory` 工具，记忆进它自己的库；卸载后 `/memory` 命令名与模型记忆工具归 dsh-mnemos）。
