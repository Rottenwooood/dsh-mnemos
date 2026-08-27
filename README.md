# dsh-mnemos

DSH（DeepSeek Harness）的**跨会话记忆插件**。它会记住你在会话里告诉模型的重要事实，下次会话自动想起来；所有写入都过一道审批门禁，数据全在本地，还带 git 版本历史和跨机同步。

## 它能做什么

- **跨会话记忆**：这次会话说的"用 pnpm 装依赖"，下次会话模型自动知道，不用重复教。
- **有门禁**：敏感内容、重复、越界的写入被自动打回；普通写入直接入库，有风险的进"待审批"等人工确认。
- **会自我进化**：定时/手动把会话提炼成记忆和规则；规则批准后注入模型；还能固化成 SKILL。
- **可审计**：每一次写入/批准/拒绝都有记录。
- **数据你的**：全部存本地 SQLite；每条记忆同时是一份 Markdown 文件，走 git 历史（可回滚、可恢复、可跨机同步、可备份）。

## 快速开始

```sh
# 安装（web profile）
dsh plugin --profile web add dsh-mnemos

# 重启后浏览器"设置 → dsh-mnemos"可配置；侧边栏出现"记忆"页签
dsh web
```

记一条记忆：在会话里让模型"记住：用 pnpm 安装依赖"（模型会调用 `memory_record`），或者到设置页**导入历史会话**（支持 Claude Code / Codex / ChatGPT / DSH 历史日志，目录默认预填 `~/.dsh/sessions`，点"扫描预览"即可）。

## 日常用法

- **模型工具**：`memory_search`（搜索）、`memory_record`（写）、`memory_list`、`memory_stats` —— 模型在会话里自己会用。
- **人类命令** `/memory`：
  ```
  /memory search <关键词>          搜索记忆
  /memory list | stats             查看/统计
  /memory approve <id> | reject <id>   审批待确认项
  /memory import <来源> <路径>      导入历史会话
  /memory distill [路径]            提炼（生成记忆/规则候选）
  /memory rules <list|activate|...>   管理规则
  /memory skill <list|promote>     规则 → SKILL
  /memory git <status|push|pull|rollback|restore|backup|...>  版本/同步
  /memory bus <blacklist|...>      第三方插件治理
  ```
- **浏览器界面**（better-sidebar「记忆」页签）：概览、30 天命中热力图、待审批、记忆列表（搜索/筛选/编辑/版本历史/删除）、已删除恢复、被拒历史、git 同步。

## 同步到 GitHub

在设置页填 `gitRemoteUrl`（如 `https://github.com/你/dsh-memory.git`）保存，然后点 push 即可。鉴权复用 `~/.git-credentials`（和系统 git 同一套凭据），无需额外配置。

## 配置

所有配置在浏览器"设置 → dsh-mnemos"页，改完大多即时生效。常用几项：

| 字段 | 作用 |
|---|---|
| `enabled` | 插件总开关 |
| `autoApprove` / `autoApproveConfidence` | 是否自动放行高置信度记忆、阈值 |
| `injectionEnabled` / `injectLimit` / `injectMaxBytes` | 是否注入、注入条数/字节预算 |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | 跨机同步：远端地址 / 后端 / 自动同步 |
| `distillAuto` / `distillIntervalMinutes` | 自动提炼开关与间隔 |
| `sessionLogDirs` / `backfillEnabled` | 启动时回填历史会话日志 |

完整字段表、配置示例与使用场景见 **[docs/HANDOVER.md](docs/HANDOVER.md)**。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test                  # 单元测试
pnpm run build:client      # 改了浏览器端（src/client/）后需要
```

改完建议跑完整验证（真实环境）：

```sh
# 1) 真实命令注册表分发 /memory 各子命令（在 deepseek-harness 目录）
node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/verify-real-composition.mts
# 2) 全部 /mnemos/api HTTP 流程（先启动 dsh web）
node --import tsx/esm /home/c6h4o2/dsh-mnemos/scripts/e2e-http.mts
```

## 数据位置

```
~/.dsh/mnemos/mnemos.db     SQLite 数据库
~/.dsh/mnemos/repo/         git 记忆镜像（每条记忆一个 .md）
~/.dsh/mnemos/skills/       规则固化的 SKILL
```

## 许可

MIT
