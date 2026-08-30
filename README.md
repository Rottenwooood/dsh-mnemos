<div align="center">

# dsh-mnemos

[简体中文](README.zh.md)

**A governed, self-evolving, extensible DSH plugin for cross-session memory.**

![CI](https://img.shields.io/github/actions/workflow/status/Rottenwooood/dsh-mnemos/ci.yml?branch=main&label=CI) ![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/tag/Rottenwooood/dsh-mnemos?label=version) ![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)

---
</div>

## Why mnemos

The whole thing hangs on four design principles.

1. **Every memory passes a gate — auditable.** Every write — model tools, /memory, third-party plugins, the browser — goes through one approval gate: sensitive / duplicate / out-of-budget writes are rejected, risky ones wait for a human. Model/import/third-party memories are marked *unverified* and bounded at injection (anti-poisoning). Every write / approval / rejection is audited.

2. **It evolves and corrects itself.** Sessions distill into memories *and* rules. A rule lives in the memory store and is injected by mnemos — or, once approved, **promoted to a DSH SKILL**: a standard Markdown skill file any agent can load on demand, so the knowledge leaves mnemos and works anywhere in the harness. Facts update in place (the old value stays recoverable in git); only genuine conflicts become *replacement proposals* for a human. Heat-based cleanup keeps the store bounded (active → archived → restorable; `pinned` never leaves).

3. **Your data — importable from other agents, manageable, cross-device syncable.** Local SQLite (WAL + FTS5); every memory is also a Markdown file in a git repo — history, diff, rollback, restore, backup, and cross-device sync (via push/pull). Imports ChatGPT / Claude Code / Codex / DSH history.

4. **An open memory bus.** `ctx.mnemosBus` is an open memory bus: any DSH plugin can `recall` memories, `record` its own (stamped with a declared identity, always routed to the human approval queue), and `subscribe` to memory changes — plus runtime blacklist and revocation. A versioned ABI (`ctx.mnemosAbi`) exposes real effect numbers to external tools, proven by a conformance suite. Details in the [For developers](#for-developers) section.

## Features

### For users

- **Model tools** (the model uses them in-session):
  `memory_search` (recall) · `memory_record` (write one entry now, gated, can update an outdated memory in place) · `memory_distill` (batch-distill the buffered conversation → memory/rule candidates, incremental dedup) · `memory_list` · `memory_stats`.
- **Injection.** Once per session, a *memory index* is injected (one line per memory: type · short-id · topic · keywords, byte-stable, KV-cache friendly, negligible token cost). The model drills into details with `memory_get` or `memory_research`. When more than N minutes have passed and a keyword hits, the matching index entries are injected again.
- **Environment conventions.** `protocol`-typed memories (environment/tool conventions, e.g. sandbox rules) ride a **separate channel**: injected once at the session's first step and re-attached after each context compaction, so they are always present before the agent acts; **they never enter the memory index**.
- **Hits.** A `memory_get` or `memory_search` call counts as a hit.
- **/memory commands** — the complete list, usage scenarios, and troubleshooting live in [docs/HANDOVER.md](docs/HANDOVER.md); the key ones:
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
- **Browser UI** (better-sidebar "记忆" tab): overview, approval queue (approve / reject / edit-then-approve / batch-approve low-risk), memory list with search/filter/edit/version-history/rollback/delete, deleted-memory recovery, rejection history, and git sync.
- **Distillation.** Unlike `memory_record` (one entry written now), distillation hands the **whole buffered conversation** to a dedicated specialist that **batch-mines** memory candidates, rule candidates and conflict-replacement proposals in one pass; an incremental cursor ensures already-distilled content is never reprocessed. Each memory carries 2–5 keywords (triggering injection), all candidates pass the approval gate; conflicts always go to a human, rule-class entries become rule proposals. Approved rules are injected by mnemos, and can additionally be **promoted to a DSH SKILL** that any agent can load on demand through DSH's `skill` tool, making the knowledge usable outside mnemos.

### For developers

#### The open memory bus — `ctx.mnemosBus`

dsh-mnemos isn't just for the model and the human — it exposes its memory store to **any other DSH plugin** through a bus. A plugin mounts it with `ctx.inject(['mnemosBus'])` and gets three primitives:

| Primitive | What it does | Guardrails |
|---|---|---|
| `bus.recall({ query, limit })` | Search memories (or list by scope/workspace). Read-only — never writes, never bumps the usage ledger. | — |
| `bus.record(input, identity)` | Request a memory write. | **Must declare who it is** (`{ name, version }` → stamped `plugin:<name>@<version>`, `source: third_party`). The write **always enters the human approval queue** — never direct, never auto-approved, regardless of confidence. Audited. |
| `bus.subscribe(listener)` | Watch store changes: memory committed / proposal pending / memory replaced / memory revoked / rule approved. | Subscriber errors never break the bus. |

Governance that applies to every third-party write:

- **Runtime blacklist** — `bus.blacklistPlugin('name', reason)` (or `/memory bus blacklist`): from then on that plugin's writes are denied with an audit entry. `unblacklistPlugin` / `listBlacklist` to manage.
- **Revocation** — `bus.revoke(memoryId, identity)`: a third-party write can be deleted, but only the **owning plugin** or a **human** may revoke it.
- **Per-writer attribution** — `bus.state()` / `bus.listByWriter(name)` let the approval panel group pending items by which plugin proposed them.

So another plugin gets the *same* treatment as the model: an identity stamp, the approval gate, an audit trail, and a kill switch. **The bus does not trust anything by default** — sharing memory with mnemos is permissioned, not assumed.

#### Measurement ABI — `ctx.mnemosAbi`

Versioned `recall / get / state / probe` for external tools and evals to read real numbers (active / pending / unverified / verified / injections / hit-rate). 

#### Import adapters

`src/domain/imports/` — chatgpt, claude-code, codex, dsh; auto source detection in `detect.ts`.

## Benchmarks

### Deterministic effect eval

```sh
# from the deepseek-harness directory
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

### Public dataset benchmarks (LongMemEval-S / LoCoMo-10)

Measured on the production retrieval path (FTS5 multi-level ladder: all-words AND → any-word OR → substring, fused with bigram-similarity via RRF) against deja-vu's published numbers, same protocol. Methodology details: [scripts/bench/BENCHMARKS.md](scripts/bench/BENCHMARKS.md).

| Dataset | dsh-mnemos (production path) | deja-vu (official) |
|---|---|---|
| LongMemEval-S (cleaned, 470 q, hit@1) | **87.2%** | 85.3% |
| LoCoMo-10 (1982 QA, R@1) | 60.9% | 69.8% |

Honest notes:

- **LongMemEval-S:** we beat deja-vu on every reported metric (hit@1 87.2% vs 85.3%, MRR 0.914 vs 0.896, evidence-recall@1 56.3% vs 55.0%).
- **LoCoMo-10:** we trail (60.9% vs 69.8%). LoCoMo sessions are longer and the questions lean on cross-session reasoning; deja-vu's stem layer and stronger ranking variants win there. Closing this gap is on the roadmap, not a defect.


## Install & quick start

**Compatibility** (honest): developed and verified on **Linux / Node ≥ 22.19 / DSH web profile**. Windows/macOS are untested.

```sh
# npm channel
dsh plugin --profile web add dsh-mnemos

# git channel
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
| `protocolInjectEnabled` | inject environment/tool-convention (`protocol`) memories — once at the session's first step, re-attached after each context compaction; **not part of the memory index** |
| `gitRemoteUrl` / `gitBackend` / `syncEnabled` | cross-machine sync: remote / backend / auto-sync |
| `distillAuto` / `distillEveryNTurns` | auto-distill on/off and interval (user turns) |
| `cleanupDays` | archive-candidate age: how many days without any injection/hit or update before a memory becomes a cleanup candidate |
| `sessionLogDirs` / `backfillEnabled` | backfill historical session logs at startup |

The full 34-field table, YAML snippets, usage scenarios, and troubleshooting: [docs/HANDOVER.md](docs/HANDOVER.md).

## How it compares

### vs dsh-memento

Different philosophies. **dsh-memento** is a *capability seam*: a typed `ctx.memory` contract, hard per-track/per-layer character budgets, and a dsh-memory-protocol with an adapter registry (mem0 / Hermes / CLAUDE.md) and a read-only MCP server — strong on ecosystem interoperability. **dsh-mnemos** is a complete memory *product*: distillation, rules/SKILL, a full lifecycle, and measured retrieval.

| Dimension | dsh-mnemos | dsh-memento |
|---|---|---|
| Retrieval | FTS5 ladder + bigram RRF, **public benchmark numbers** | substring search (no FTS5), no published numbers |
| Lifecycle / heat eviction / pinned | yes | no |
| Distillation / rules / SKILL | yes (LLM, approval-gated) | no |
| git version history + cross-machine sync | yes (one .md per memory) | no |
| Third-party writes | bus: identity-stamped, approval-queue, blacklist, revoke | adapter registry (pure data conversion), MCP server |
| Protocol spec / MCP / adapters | bus + ABI + conformance; **no MCP yet** | dsh-memory-protocol v1 + MCP + adapters |
| npm / releases | not yet published | published, multi-channel install |
| README | English + 中文 | 5 languages |

### vs deja-vu

deja-vu is a Go memory engine whose public long-memory benchmarks we replicate same-protocol. We win LongMemEval-S (87.2% vs 85.3%) and trail LoCoMo (60.9% vs 69.8%) — details in [Benchmarks](#benchmarks). We bring, on top of retrieval, the governance/lifecycle layer (approval gate, trust tiers, conflict replacement proposals, git) that deja-vu does not have.

## TODO

These are the gaps between "functional and measured" and "formally released":

- [ ] **Cross-platform verification** — developed on Linux; test Windows / macOS.
- [ ] **Schema upgrade-path tests** — user_version 1 migrations are exercised only on dev databases.
- [ ] **npm publish** — have published .
- [ ] **Distill-mode benchmark at scale** — the real-LLM distill pipeline is wired and validated on a single question; a representative sample (10–20 questions across types) is not yet run (provider quota/cost bound).
- [ ] **Stress tests** — concurrent writes, thousands of memories (index/search performance), long-run behavior (WAL growth, git repo growth).
- [ ] **Stabilize the `isomorphic` git backend** — it can time out / be flaky on slow connections in our testing; worth a reliability pass or documenting `system` as the recommended sync backend.
- [ ] **MCP server** — align with memento's read-only stdio server for external clients.
- [ ] Optional: a dsh-memory-protocol spec + adapter registry to match memento's ecosystem surface.

## Design sources

| dsh-mnemos mechanism | Aligns with |
|---|---|
| Frozen index injection + `memory_get` drill-down (recall ≠ injection) | engram / meow / memory-manager / LongMemEval |
| Power-law heat ranking + reinforcement counts | dsh-evolve decay semantics |
| Bounded occupancy + source-marked anti-poisoning | 2608.21230 / Veracium |
| Active → archived → deleted + pinned (never hard-delete) | dsh-evolve state machine |
| Conflict replacement proposal (new value supersedes old; contradictions never silently dropped) | StateMemBench / MELD |
| Environment conventions re-attached at first step + after compaction (compression-cliff defense) | 2608.22752 |
| Open measurement ABI + conformance | memento conformance suite |
| Effect ledger + reproducible eval | memlab / LongMemEval methodology |
| Third-party memory bus (identity + approval + blacklist + revoke) | memento adapters / tool-memory sharing |
| Multi-source history import (ChatGPT/Claude Code/Codex/DSH) | migration-tool convention (import → distill) |

## Development & verification

```sh
pnpm install
pnpm run typecheck
pnpm test                 # 156 unit tests
pnpm run build:client     # after touching src/client/

scripts/run-verify.sh     # typecheck+unit → deterministic eval → ABI conformance → real registry composition
```

## License

MIT

## Star History

<a href="https://www.star-history.com/?repos=Rottenwooood%2Fdsh-mnemos&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&theme=dark&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Rottenwooood/dsh-mnemos&type=date&legend=top-left&sealed_token=Emh6TOB7Y22Eu7IoGad8JCvsL9DIYOGipsgjy0cdzBDf-hM8UNsqA1POgNgz9ya9L0_mKWnl_zsMaWXZghDth55h0rNCcJB-ocdezAyzmXewf4Ryo0k8V6pby_XyFOf0e8NFozoy3mx1CkKqsmWLb2OYU-xB4IzfvmHj5XxvhMbKm8K1UOZccTtsgRFv" />
 </picture>
</a>