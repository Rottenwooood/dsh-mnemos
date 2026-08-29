/**
 * LoCoMo-10 benchmark for dsh-mnemos, mirroring deja-vu's methodology
 * (scripts/locomo/main.go). Same mapping and modes as longmemeval.bench.test.ts.
 *
 *  - Each sample's sessions (conversation.session_N, keyed sess-N) become
 *    memories with FULL text in summary/detail.
 *  - Gold sessions derive from each question's evidence turn ids (D<session>:<turn>).
 *  - Categories reported separately; category 5 is adversarial by design.
 *  - current = production path (FTS5 AND); ladder = AND->OR->substring.
 *
 * Run:
 *   BENCH_DATA=/path/to/locomo10.json \
 *     npx vitest run scripts/bench/locomo.bench.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryStore, type MemoryStore } from '../../src/domain/store.js';
import { createMemoryService, DEFAULT_GATE } from '../../src/domain/service.js';
import { createSensitiveDetector } from '../../src/domain/sensitive.js';
import type { Memory } from '../../src/domain/types.js';

interface LoCoMoQA {
  question: string;
  answer: unknown;
  evidence: unknown;
  category: unknown;
}
interface LoCoMoSample {
  sample_id: string;
  qa: LoCoMoQA[];
  conversation: Record<string, unknown>;
}

const TOP = 20;
const evidenceRE = /D(\d+):\d+/g;

function sessionMemory(id: string, text: string): Memory {
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

function toks(text: string): string[] {
  return text.trim().replace(/[",]/g, ' ').split(/\s+/).filter(Boolean);
}

function rankOf(ids: string[], want: Set<string>): number {
  for (let i = 0; i < ids.length; i++) if (want.has(ids[i]!)) return i + 1;
  return 0;
}

function collectSessions(sample: LoCoMoSample): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const key of Object.keys(sample.conversation)) {
    const m = /^session_(\d+)$/.exec(key);
    if (!m) continue;
    const turns = sample.conversation[key];
    if (!Array.isArray(turns)) continue;
    const text = turns
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => `${String(t.speaker ?? '')}: ${String(t.text ?? '')}`)
      .join('\n');
    if (text.trim()) out.push({ id: `sess-${m[1]}`, text });
  }
  return out;
}

function goldFromEvidence(evidence: unknown): Set<string> {
  const gold = new Set<string>();
  const s = String(evidence);
  for (const m of s.matchAll(evidenceRE)) gold.add(`sess-${m[1]}`);
  return gold;
}

interface QuestionRanks {
  current: { ids: string[]; rank: number };
  ladder: { ids: string[]; rank: number };
}

function rankQuestion(sessions: Array<{ id: string; text: string }>, question: string, want: Set<string>): QuestionRanks {
  const store = openMemoryStore(':memory:');
  let currentIds: string[];
  try {
    for (const s of sessions) store.addMemory(sessionMemory(s.id, s.text));
    // Production path: the service's hybrid search (FTS5 ladder + bigram).
    const service = createMemoryService(store, createSensitiveDetector(), DEFAULT_GATE);
    currentIds = service.search(question, TOP).map((r) => r.id);
  } finally {
    store.close();
  }

  const db = new DatabaseSync(':memory:');
  let ladderIds: string[];
  try {
    db.exec(`CREATE TABLE memories(rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`);
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(summary, content='memories', content_rowid='rowid');`);
    db.exec(`CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(rowid,summary) VALUES (new.rowid,new.summary); END;`);
    const ins = db.prepare('INSERT INTO memories(id,summary) VALUES (?,?)');
    for (const s of sessions) ins.run(s.id, s.text);
    const t = toks(question);
    const fts = (join: string): string[] => {
      if (t.length === 0) return [];
      try {
        return db.prepare('SELECT m.id FROM memory_fts f JOIN memories m ON m.rowid=f.rowid WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?').all(t.map((x) => `"${x}"`).join(join), TOP).map((r) => (r as { id: string }).id);
      } catch {
        return [];
      }
    };
    const and = fts(' AND ');
    if (and.length > 0) ladderIds = and;
    else {
      const or = fts(' OR ');
      if (or.length > 0) ladderIds = or;
      else {
        let sub: string[] = [];
        for (const tok of t) {
          const rows = db.prepare("SELECT id FROM memories WHERE status='active' AND summary LIKE ? ORDER BY rowid LIMIT ?").all(`%${tok}%`, TOP) as Array<{ id: string }>;
          if (rows.length > 0) {
            sub = rows.map((r) => r.id);
            break;
          }
        }
        ladderIds = sub;
      }
    }
  } finally {
    db.close();
  }

  return {
    current: { ids: currentIds, rank: rankOf(currentIds, want) },
    ladder: { ids: ladderIds, rank: rankOf(ladderIds, want) },
  };
}

export interface LoCoMoSummary {
  n: number;
  r1: number;
  mrr: number;
  by_category: Record<string, { n: number; r1: number; mrr: number }>;
}

export function runLoCoMo(samples: LoCoMoSample[], log: (line: string) => void = console.log, outPath?: string): { current: LoCoMoSummary; ladder: LoCoMoSummary } {
  const cur: LoCoMoSummary = { n: 0, r1: 0, mrr: 0, by_category: {} };
  const lad: LoCoMoSummary = { n: 0, r1: 0, mrr: 0, by_category: {} };
  for (const sample of samples) {
    const sessions = collectSessions(sample);
    for (const qa of sample.qa) {
      const want = goldFromEvidence(qa.evidence);
      if (want.size === 0) continue;
      const { current, ladder } = rankQuestion(sessions, qa.question, want);
      const cat = String(qa.category);
      for (const [summary, r] of [[cur, current.rank], [lad, ladder.rank]] as [LoCoMoSummary, number][]) {
        summary.n++;
        if (r >= 1) summary.mrr += 1 / r;
        if (r === 1) summary.r1++;
        const c = summary.by_category[cat] ?? { n: 0, r1: 0, mrr: 0 };
        c.n++;
        if (r >= 1) c.mrr += 1 / r;
        if (r === 1) c.r1++;
        summary.by_category[cat] = c;
      }
    }
  }
  const name = (cat: string): string => ({ '1': 'multi-hop', '2': 'temporal', '3': 'open-domain', '4': 'single-hop', '5': 'adversarial*' } as Record<string, string>)[cat] ?? cat;
  for (const [summary, label] of [[cur, 'current'], [lad, 'ladder']] as [LoCoMoSummary, string][]) {
    log(`\nLoCoMo-10 · ${label} (n=${summary.n})`);
    log(`${'category'.padEnd(16)} ${'n'.padStart(4)} ${'R@1'.padStart(8)} ${'MRR'.padStart(7)}`);
    for (const cat of Object.keys(summary.by_category).sort()) {
      const c = summary.by_category[cat]!;
      log(`${name(cat).padEnd(16)} ${String(c.n).padStart(4)} ${(100 * c.r1 / c.n).toFixed(1).padStart(7)}% ${(c.mrr / c.n).toFixed(3).padStart(7)}`);
    }
    log(`${'TOTAL'.padEnd(16)} ${String(summary.n).padStart(4)} ${(100 * summary.r1 / summary.n).toFixed(1).padStart(7)}% ${(summary.mrr / summary.n).toFixed(3).padStart(7)}`);
  }
  log(`\ndeja-vu published anchor: LoCoMo R@1=69.6% (official)`);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), dataset: 'locomo10', current: cur, ladder: lad, deja_anchor: { r_at_1: 0.696 } }, null, 2));
  }
  return { current: cur, ladder: lad };
}

// Skipped by default (no BENCH_DATA): `vitest run` must not require the
// dataset. Set BENCH_DATA to enable.
const suite = process.env.BENCH_DATA ? describe : describe.skip;

suite('LoCoMo-10 benchmark (public dataset)', () => {
  it('runs each sample through the production path and the ladder', () => {
    const dataPath = process.env.BENCH_DATA;
    expect(dataPath, 'set BENCH_DATA=/path/to/locomo10.json').toBeTruthy();
    const samples = JSON.parse(readFileSync(dataPath!, 'utf8')) as LoCoMoSample[];
    const res = runLoCoMo(samples, console.log, process.env.BENCH_OUT);
    expect(res.current.n).toBeGreaterThan(0);
    expect(res.ladder.n).toBe(res.current.n);
  }, 600000);
});
