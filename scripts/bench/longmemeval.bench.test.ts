/**
 * LongMemEval-S benchmark for dsh-mnemos, mirroring deja-vu's methodology
 * (scripts/longmemeval/main.go) so the numbers are directly comparable.
 *
 * Methodology:
 *  - Every question's haystack sessions are written into a fresh in-memory
 *    store, one memory per haystack session (id = session id).
 *  - The memory's summary/detail carry the FULL session text, so the FTS5
 *    index covers everything in the session — session-level retrieval, the
 *    same object deja indexes.
 *  - Each question is issued VERBATIM (no rewriting, no LLM, no embeddings).
 *  - Two retrieval modes, reported side by side:
 *      current — the production path today (MemoryStore.searchMemories:
 *                FTS5 AND, all query tokens must match, LIKE fallback).
 *      ladder  — a multi-tier lexical ladder on the same FTS5 engine
 *                (exact-AND -> OR -> single-token substring), the shape
 *                deja's production ladder has. NOT the product today; it
 *                isolates how much of the gap is strategy, not engine.
 *  - Metrics: session-level hit@1/5/10/20, MRR, official evidence-recall@k.
 *
 * Run:
 *   BENCH_DATA=/path/to/longmemeval_s_cleaned.json \
 *     BENCH_SKIP_ABS=1 BENCH_LIMIT=470 \
 *     npx vitest run scripts/bench/longmemeval.bench.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryStore, type MemoryStore } from '../../src/domain/store.js';
import { createMemoryService, DEFAULT_GATE } from '../../src/domain/service.js';
import { createSensitiveDetector } from '../../src/domain/sensitive.js';
import type { Memory } from '../../src/domain/types.js';

interface LmeTurn {
  role: string;
  content: string;
}
interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids: string[];
  answer: unknown;
}

const TOP = 50;

export function sessionMemory(id: string, turns: LmeTurn[]): Memory {
  const text = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  return {
    id,
    type: 'project_fact',
    scope: 'global',
    topic: id.slice(0, 60),
    summary: text,
    detail: text,
    evidence: [{ sessionId: id, eventRange: [0, 0], quote: '' }],
    confidence: 1,
    source: 'third_party',
    writer: 'bench',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    crossSessionHits: 0,
    status: 'active',
  };
}

export function rankOf(ids: string[], want: Set<string>): number {
  for (let i = 0; i < ids.length; i++) if (want.has(ids[i]!)) return i + 1;
  return 0;
}

export interface BenchResult {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  r20: number;
  miss: number;
  mrr: number;
  ev: Record<number, number>;
}
const newBucket = (): BenchResult => ({ n: 0, r1: 0, r5: 0, r10: 0, r20: 0, miss: 0, mrr: 0, ev: { 1: 0, 5: 0, 10: 0, 20: 0 } });

function toks(q: LmeQuestion): string[] {
  return q.question.trim().replace(/[",]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Ladder tier 1 (and product path): FTS5 AND over query tokens. */
function fts(db: DatabaseSync, q: LmeQuestion, join: ' AND ' | ' OR '): string[] {
  const t = toks(q);
  if (t.length === 0) return [];
  try {
    return db
      .prepare('SELECT m.id FROM memory_fts f JOIN memories m ON m.rowid=f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(t.map((x) => `"${x}"`).join(join), TOP)
      .map((r) => (r as { id: string }).id);
  } catch {
    return [];
  }
}

/** Ladder tier 3: single-token substring scan (weakest, deja's relevance analogue). */
function substring(db: DatabaseSync, q: LmeQuestion): string[] {
  for (const tok of toks(q)) {
    const rows = db
      .prepare("SELECT id FROM memories WHERE status='active' AND summary LIKE ? ORDER BY rowid LIMIT ?")
      .all(`%${tok}%`, TOP) as Array<{ id: string }>;
    if (rows.length > 0) return rows.map((r) => r.id);
  }
  return [];
}

interface QuestionRanks {
  current: { ids: string[]; rank: number };
  ladder: { ids: string[]; rank: number };
}

/**
 * Build one in-memory store per mode (identical schema/triggers; :memory: dbs
 * are per-connection) and rank the question under both modes.
 */
function rankQuestion(q: LmeQuestion, want: Set<string>): QuestionRanks {
  const mkStore = (): { store: MemoryStore; ids: Map<string, string> } => {
    const store = openMemoryStore(':memory:');
    const ids = new Map<string, string>();
    const seen = new Set<string>();
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const id = q.haystack_session_ids[si]!;
      if (seen.has(id)) continue; // dataset may repeat a session id; deja overwrites the file, we dedupe
      seen.add(id);
      store.addMemory(sessionMemory(id, q.haystack_sessions[si]!));
      ids.set(id, id);
    }
    return { store, ids };
  };
  const mkRaw = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE memories(rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`);
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(summary, content='memories', content_rowid='rowid');`);
    db.exec(`CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(rowid,summary) VALUES (new.rowid,new.summary); END;`);
    const ins = db.prepare('INSERT INTO memories(id,summary) VALUES (?,?)');
    const seen = new Set<string>();
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const id = q.haystack_session_ids[si]!;
      if (seen.has(id)) continue;
      seen.add(id);
      ins.run(id, q.haystack_sessions[si]!.map((t) => `${t.role}: ${t.content}`).join('\n'));
    }
    return db;
  };

  const { store } = mkStore();
  let currentIds: string[];
  try {
    // Production path: the service's hybrid search (FTS5 rank + bigram
    // similarity, fused by reciprocal rank) — what memory_search actually uses.
    const service = createMemoryService(store, createSensitiveDetector(), DEFAULT_GATE);
    currentIds = service.search(q.question, TOP).map((r) => r.id);
  } finally {
    store.close();
  }

  const db = mkRaw();
  let ladderIds: string[];
  try {
    const and = fts(db, q, ' AND ');
    ladderIds = and.length > 0 ? and : fts(db, q, ' OR ').length > 0 ? fts(db, q, ' OR ') : substring(db, q);
  } finally {
    db.close();
  }

  return {
    current: { ids: currentIds, rank: rankOf(currentIds, want) },
    ladder: { ids: ladderIds, rank: rankOf(ladderIds, want) },
  };
}

function record(out: BenchResult, ids: string[], rank: number, want: Set<string>): void {
  out.n++;
  if (rank >= 1) out.mrr += 1 / rank;
  if (rank === 0) out.miss++;
  else {
    if (rank <= 1) out.r1++;
    if (rank <= 5) out.r5++;
    if (rank <= 10) out.r10++;
    if (rank <= 20) out.r20++;
  }
  for (const k of [1, 5, 10, 20]) {
    let got = 0;
    for (let i = 0; i < Math.min(k, ids.length); i++) if (want.has(ids[i]!)) got++;
    out.ev[k]! += got / want.size;
  }
}

export interface BenchSummary {
  mode: 'current' | 'ladder';
  n: number;
  hit_at_1: number;
  hit_at_5: number;
  hit_at_10: number;
  hit_at_20: number;
  mrr: number;
  evidence_recall: Record<string, number>;
  by_type: Record<string, { n: number; hit_at_1: number; mrr: number }>;
}

export function runLongMemEval(
  questions: LmeQuestion[],
  log: (line: string) => void = console.log,
  outPath?: string,
): { current: BenchSummary; ladder: BenchSummary } {
  const current = newBucket();
  const ladder = newBucket();
  const byType = new Map<string, BenchResult>();
  const t0 = Date.now();

  for (const q of questions) {
    const want = new Set(q.answer_session_ids);
    const r = rankQuestion(q, want);
    const bucket = byType.get(q.question_type) ?? newBucket();
    record(current, r.current.ids, r.current.rank, want);
    record(ladder, r.ladder.ids, r.ladder.rank, want);
    record(bucket, r.current.ids, r.current.rank, want);
    byType.set(q.question_type, bucket);
  }

  const summarize = (b: BenchResult): BenchSummary => ({
    mode: b === current ? 'current' : 'ladder',
    n: b.n,
    hit_at_1: +(b.r1 / b.n).toFixed(3),
    hit_at_5: +(b.r5 / b.n).toFixed(3),
    hit_at_10: +(b.r10 / b.n).toFixed(3),
    hit_at_20: +(b.r20 / b.n).toFixed(3),
    mrr: +(b.mrr / b.n).toFixed(3),
    evidence_recall: { '1': +(b.ev[1]! / b.n).toFixed(3), '5': +(b.ev[5]! / b.n).toFixed(3), '10': +(b.ev[10]! / b.n).toFixed(3), '20': +(b.ev[20]! / b.n).toFixed(3) },
    by_type: {},
  });
  const sumCurrent = summarize(current);
  const sumLadder = summarize(ladder);
  for (const [t, b] of byType) {
    sumCurrent.by_type[t] = { n: b.n, hit_at_1: +(b.r1 / b.n).toFixed(3), mrr: +(b.mrr / b.n).toFixed(3) };
  }
  const fmt = (s: BenchSummary, label: string) => {
    log(`${label.padEnd(10)} hit@1=${(100 * s.hit_at_1).toFixed(1)}% hit@5=${(100 * s.hit_at_5).toFixed(1)}% hit@10=${(100 * s.hit_at_10).toFixed(1)}% hit@20=${(100 * s.hit_at_20).toFixed(1)}% MRR=${s.mrr} ev@1=${(100 * s.evidence_recall['1']!).toFixed(1)}%`);
  };
  log(`\nLongMemEval-S · dsh-mnemos (n=${current.n}, wall=${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  log(`deja-vu published anchor:  hit@1=85.3% hit@5=95.5% MRR=0.896 (cleaned set, official)`);
  log(`(not re-run locally: go1.25 toolchain unreachable from this host)`);
  fmt(sumCurrent, 'current');
  fmt(sumLadder, 'ladder');

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), dataset: 'longmemeval_s_cleaned', skip_abs: true, current: sumCurrent, ladder: sumLadder, deja_anchor: { hit_at_1: 0.853, hit_at_5: 0.955, mrr: 0.896 } }, null, 2));
  }
  return { current: sumCurrent, ladder: sumLadder };
}

// Skipped by default (no BENCH_DATA): `vitest run` must not require the
// multi-hundred-MB dataset. Set BENCH_DATA to enable.
const suite = process.env.BENCH_DATA ? describe : describe.skip;

suite('LongMemEval-S benchmark (public dataset)', () => {
  it('runs the cleaned subset through the production path and the ladder', () => {
    const dataPath = process.env.BENCH_DATA;
    expect(dataPath, 'set BENCH_DATA=/path/to/longmemeval_s_cleaned.json').toBeTruthy();
    const raw = readFileSync(dataPath!, 'utf8');
    let questions = JSON.parse(raw) as LmeQuestion[];
    if (process.env.BENCH_SKIP_ABS) {
      questions = questions.filter((q) => !q.question_id.includes('_abs'));
    }
    const limit = Number(process.env.BENCH_LIMIT);
    if (Number.isFinite(limit) && limit > 0 && limit < questions.length) {
      questions = questions.slice(0, limit);
    }
    const res = runLongMemEval(questions, console.log, process.env.BENCH_OUT);
    expect(res.current.n).toBeGreaterThan(0);
    expect(res.ladder.n).toBe(res.current.n);
  }, 600000);
});
