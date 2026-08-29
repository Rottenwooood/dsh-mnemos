# dsh-mnemos

[简体中文](README.zh.md)

**Governed, self-evolving, cross-session memory for DeepSeek Harness.** Everything the model remembers is written through an approval gate, lives in local SQLite, and is versioned in git — with reproducible effect numbers that move every time you change the code.

![CI](https://img.shields.io/github/actions/workflow/status/Rottenwooood/dsh-mnemos/ci.yml?branch=main&label=CI) ![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/tag/Rottenwooood/dsh-mnemos?label=version) ![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)

---

## What it is / what it isn't

**What it is.** A DSH plugin that gives the model cross-session memory. Facts you tell it in one session are injected at the start of the next, so you don't re-explain yourself. Every write path — model tools, /memory commands, third-party plugins, the browser panel — goes through a single approval-gated `MemoryService`. Data is fully local: SQLite (WAL + FTS5) with a git-versioned Markdown mirror for history, rollback, backup, and cross-machine sync.

**What it isn't.**

- Not a memory *warehouse* or a vector store — it does not attempt unbounded accumulation.
- Not a silent rewriter — conflicting facts become *replacement proposals* that wait for a human decision, never auto-overwritten.
- Not a trust-everything sink — model/import/third-party writes are marked *untrusted*, bounded in number, ranked behind human-confirmed memories at injection time, and the source is visible to the model.

## Why mnemos

1. **Effect numbers that beat the field, reproducibly.** LongMemEval-S hit@1 **87.2%** vs deja-vu's published **85.3%** — same data, same metrics, same query text. Run it yourself (see [Benchmarks](#benchmarks)); it is deterministic and does not use an LLM.
2. **A real memory lifecycle.** Active → archived → restorable, evicted by heat (coldest first). `pinned` memories never leave. When a fact is superseded, both versions are kept and chained — recall returns the new value with the old one marked *superseded*.
3. **Remembers failures, not just facts.** Failed commands are recorded; if the exact failure recurs, the model is stopped and told why. A successful retry clears it automatically.
4. **Memory as code.** One Markdown file per memory, in a git repo. Per-entry history, diff, rollback, recovery of deleted memories, merge-based sync across machines, and standard bundle backup. Pure-JS git backend (`isomorphic-git`) means no system git required.
5. **Open, measured, governable.** A memory bus (`ctx.mnemosBus`) lets other plugins read/write — writes require a declared identity and always enter the approval queue; a plugin can be blacklisted at runtime. A versioned measurement ABI (`ctx.mnemosAbi`) exposes real effect data, proven by a conformance suite.

## Features

### For users

- **Model tools** (the model uses them in-session):
  `memory_search` (recall) · `memory_record` (write, with keywords) · `memory_distill` (summarize buffered sessions → memory/rule proposals) · `memory_list` · `memory_stats`.
- **Cold-start injection, not prompt stuffing.** Once per session, a *frozen memory index* is injected (one line per memory: type · short-id · topic · keywords, byte-stable for KV-cache reuse). The model drills into details with `memory_get`. No heuristic/regular-expression extraction anywhere.
- **/memory commands** — the complete list, scenarios, and troubleshooting live in [docs/HANDOVER.md](docs/HANDOVER.md); the key ones:
  ```
  /memory search <query> | list | stats
  /memory approve <id> | reject <id>
  /memory import <source> <path>       auto-detected: chatgpt|claude|codex|dsh
  /memory distill [path]
  /memory rules <list|activate|rollback|deprecate>
  /memory skill <list|promote <ruleId>>
  /memory git <status|log|rollback|restore|remote|push|pull|backup>
  /memory bus <blacklist|unblacklist|list|revoke|writers>
  ```
- **Browser UI** (better-sidebar "记忆" tab): overview, 30-day hit heatmap, approval queue (approve / reject / edit-then-approve / batch-approve low-risk), memory list with search/filter/edit/version-history/rollback/delete, deleted-memory recovery, rejection history, and git sync.
- **Distillation.** LLM-generated memories (each with 2–5 keywords that trigger injection), and rules — procedures/preferences/error-fixes become *rule proposals* that enter the approval flow. Approved rules are injected; approved ones can be promoted to **SKILL files** (`~/.dsh/mnemos/skills/`).
- **Import foreign history.** Auto-detects and ingests ChatGPT exports, Claude Code logs, Codex logs, and DSH's own session logs — content-hashed, so re-importing dedupes.
- **Cross-machine sync & backup.** git remote (reuses `~/.git-credentials`) with merge-based sync; conflicts are flagged for human resolution, never silently overwritten. Standard `git bundle` export for backup.

### For developers

- **Memory bus — `ctx.mnemosBus`.** Third-party-facing read/write/subscribe:
  - `recall({query})` — read-only.
  - `record(input, identity)` — write; a declared `plugin:<name>@<version>` identity is required and the write **always** enters the approval queue (never direct, never auto-approved), audited, and attributable to its writer.
  - `subscribe(listener)` — watch events (new memory, proposal, replacement, revocation, rule approval).
  - Governance: runtime blacklist (`bus.blacklistPlugin`), revocation (only the owning plugin or a human).
- **Measurement ABI — `ctx.mnemosAbi`.** Versioned `recall / get / state / probe` so external tools and evals read real numbers (active/pending/untrusted/verified/injections/usage-rate). `scripts/conformance.mts` proves it is the actual implementation, not a stub.
- **Import adapters.** `src/domain/imports/` — chatgpt, claude-code, codex, dsh; auto source detection in `detect.ts`.

## Benchmarks

### Deterministic effect eval (no LLM)

```sh
# from the deepseek-harness directory (adjust the plugin path)
node --import tsx/esm /path/to/dsh-mnemos/scripts/eval/run-eval.mts
```

| Metric | Value |
|---|---|
| Fact recall hit@1 | 0.94 |
| Fact recall MRR | 0.94 |
| Noise-query precision (don't recall what shouldn't be) | 1.00 |
| State tracking (current value after revision) | pass |
| Frozen memory index per session | 8 lines ≈ 207 tokens (KV-cache friendly) |
| Index covers the correct memory | 100% |

The "记忆" tab header shows a live **effect card** (injections / hit-rate / avg tokens / verified memories) fed by the `usage_ledger` — every injection records its token cost, and a model message that references the injected content counts as a hit and marks the memory *verified*.

### Public dataset benchmarks (LongMemEval-S / LoCoMo-10)

Measured on the production retrieval path (FTS5 multi-level ladder: all-words AND → any-word OR → substring, fused with bigram-similarity via RRF) against deja-vu's published numbers. Methodology details: [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md).

| Dataset | dsh-mnemos (production path) | deja-vu (official) |
|---|---|---|
| LongMemEval-S (cleaned, 470 q, hit@1) | **87.2%** | 85.3% |
| LoCoMo-10 (1982 QA, R@1) | 60.9% | 69.6% |

Honest notes:

- **LongMemEval-S:** we beat deja-vu on every reported metric (hit@1 87.2% vs 85.3%, MRR 0.914 vs 0.896, evidence-recall@1 56.3% vs 55.0%).
- **LoCoMo-10:** we trail (60.9% vs 69.6%). LoCoMo sessions are longer and the questions lean on cross-session reasoning; deja-vu's stem layer and stronger ranking variants win there. Closing this gap is on the roadmap, not a defect.
- **Attribution is honest:** deja-vu's numbers are their published values — we cannot rerun the original locally (it requires go1.25; this machine has go1.22 and the toolchain download is unreachable). Same data, same metrics, same query text.
- Before the retrieval ladder, the production path scored ~10% (LongMemEval-S) and ~7% (LoCoMo); the entire gap came from a query constructor that forced all-words AND, not from the underlying engine.

## Install & quick start

**Compatibility** (honest): developed and verified on **Linux / Node ≥ 22.19 / DSH web profile**. Windows/macOS are untested (see [Roadmap](#roadmap)). The model for distillation reuses DSH's configured default LLM (`agent-default-model`) — no separate API key needed.

```sh
# npm channel (once published)
dsh plugin --profile web add dsh-mnemos

# git channel (latest main)
dsh plugin --profile web add git+https://github.com/Rottenwooood/dsh-mnemos.git

# tarball channel
npm pack   # in this repo
dsh plugin --profile web add ./dsh-mnemos-<version>.tgz
```

Restart with `dsh web`; configure under Settings → dsh-mnemos; the "记忆" tab appears in the sidebar. Uninstall: `dsh plugin --profile web remove dsh-mnemos` (the memory database is kept).

**3 steps to your first memory:**

1. In a session, tell the model to remember something (it calls `memory_record`), **or** import history from the settings page (default directory `~/.dsh/sessions`).
2. Click "现在提炼" (Distill now) — or enable `distillAuto` — so the LLM turns buffered sessions into memories.
3. Next session, the model starts with the injected memory index and drills down with `memory_get`.

## Configuration

All settings live in Settings → dsh-mnemos and mostly apply live. Highlights:

| Key | Purpose |
|---|---|
| `enabled` | master switch |
| `autoApprove` / `autoApproveConfidence` | auto-approve high-confidence model writes / threshold |
| `injectionEnabled` / `injectLimit` / `injectMaxBytes` | injection on/off, count and byte budgets |
| `protocolRefreshTurns` | re-inject the environment protocol every N turns (context-compression defense) |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | cross-machine sync: remote / backend / auto-sync |
| `distillAuto` / `distillEveryNTurns` | auto-distill on/off and interval (user turns) |
| `sessionLogDirs` / `backfillEnabled` | backfill historical session logs at startup |
| `negativeMemoryEnabled` / `negativeMemoryTtlMs` | failed-command interception and expiry |

The full 31-field table, YAML snippets, usage scenarios, and troubleshooting: [docs/HANDOVER.md](docs/HANDOVER.md).

## How it compares

### vs dsh-memento

Different philosophies. **dsh-memento** is a *capability seam*: a typed `ctx.memory` contract, hard per-track/per-layer character budgets, and a dsh-memory-protocol with an adapter registry (mem0 / Hermes / CLAUDE.md) and a read-only MCP server — strong on ecosystem interoperability. **dsh-mnemos** is a complete memory *product*: distillation, rules/SKILL, a full lifecycle, negative memory, and measured retrieval.

| Dimension | dsh-mnemos | dsh-memento |
|---|---|---|
| Retrieval | FTS5 ladder + bigram RRF, **public benchmark numbers** | substring search (no FTS5), no published numbers |
| Lifecycle / heat eviction / pinned | yes | no (deliberately not a store) |
| Distillation / rules / SKILL | yes (LLM, approval-gated) | no |
| Negative memory | yes | no |
| git version history + cross-machine sync | yes (one .md per memory) | no |
| Third-party writes | bus: identity-stamped, approval-queue, blacklist, revoke | adapter registry (pure data conversion), MCP server |
| Protocol spec / MCP / adapters | bus + ABI + conformance; **no protocol spec, no MCP yet** | dsh-memory-protocol v1 + MCP + adapters |
| npm / releases | not yet published | published, multi-channel install |
| README | English + 中文 | 5 languages |

### vs deja-vu

deja-vu is a Go memory engine whose public long-memory benchmarks we replicate same-protocol. We win LongMemEval-S (87.2% vs 85.3%) and trail LoCoMo (60.9% vs 69.6%) — details in [Benchmarks](#benchmarks). We bring, on top of retrieval, the governance/lifecycle layer (approval gate, trust tiers, supersession chains, negative memory, git) that deja-vu does not have.

## Roadmap

Honest state of the project — these are the gaps between "functional and measured" and "formally released":

- [ ] **Cross-platform verification** — developed on Linux; test Windows / macOS.
- [ ] **Schema upgrade-path tests** — user_version 1 migrations are exercised only on dev databases.
- [ ] **npm publish** — packaging is ready (`npm pack` verified); publish + package-name availability check + post-install verification pending.
- [ ] **Distill-mode benchmark at scale** — the real-LLM distill pipeline is wired and validated on a single question; a representative sample (10–20 questions across types) is not yet run (provider quota/cost bound).
- [ ] **Stress tests** — concurrent writes, thousands of memories (index/search performance), long-run behavior (WAL growth, git repo growth).
- [ ] **MCP server** — align with memento's read-only stdio server for external clients.
- [ ] Optional: a dsh-memory-protocol spec + adapter registry to match memento's ecosystem surface.

## Security & data

- **Zero network, zero credentials.** Local SQLite (WAL + FTS5), POSIX mode 0600. No engine/agent-loop/apiproxy changes; we only consume DSH's `tools`, `commands`, and session signals.
- **Every write is audited** (denied writes included). Model-visible sources are stamped (`trusted`/`untrusted`, writer identity).
- **Fail loud.** Budget exceeded → structured error, never silent truncation. Corrupt DB / newer schema → load fails loudly.
- Data locations:
  ```
  ~/.dsh/mnemos/mnemos.db     SQLite (WAL + FTS5)
  ~/.dsh/mnemos/repo/         git memory mirror (one .md per memory)
  ~/.dsh/mnemos/skills/       SKILL files promoted from approved rules
  ~/.dsh/mnemos/backfill-checkpoint.json · distill-cursor.json   cursors
  ```
- Vulnerability reporting: see [SECURITY.md](SECURITY.md).

## Design sources

| dsh-mnemos mechanism | Aligns with |
|---|---|
| Frozen index injection + `memory_get` drill-down (recall ≠ injection) | engram / meow / memory-manager / LongMemEval |
| Power-law heat ranking + reinforcement counts | dsh-evolve decay semantics |
| Bounded occupancy + source-marked anti-poisoning | 2608.21230 / Veracium |
| Failed-command interception + self-expiry (negative memory) | dsh-negative-ledger / deja-vu |
| Active → archived → deleted + pinned (never hard-delete) | dsh-evolve state machine |
| Supersession chains (both versions kept, current flagged) | StateMemBench / MELD |
| Protocol refresh by turns (compression-cliff defense) | 2608.22752 |
| Open measurement ABI + conformance | memento conformance suite |
| Effect ledger + reproducible eval | memlab / LongMemEval methodology |
| Third-party memory bus (identity + approval + blacklist + revoke) | memento adapters / tool-memory sharing |
| Multi-source history import (ChatGPT/Claude Code/Codex/DSH) | migration-tool convention (import → distill) |

## Development & verification

```sh
pnpm install
pnpm run typecheck
pnpm test                 # 151 unit tests
pnpm run build:client     # after touching src/client/
```

One-shot full verification (includes real-environment checks):

```sh
scripts/run-verify.sh     # typecheck+unit → deterministic eval → ABI conformance → real registry composition
```

Reproduce the public benchmarks ([data download](scripts/bench/BENCHMARKS.md)):

```sh
BENCH_DATA=/path/to/longmemeval_s_cleaned.json BENCH_SKIP_ABS=1 BENCH_LIMIT=470 \
  BENCH_OUT=scripts/bench/longmemeval-scorecard.json pnpm run bench:longmemeval
BENCH_DATA=/path/to/locomo10.json BENCH_OUT=scripts/bench/locomo-scorecard.json \
  pnpm run bench:locomo
```

## License

MIT
