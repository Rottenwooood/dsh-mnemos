/**
 * LongMemEval-S DISTILL-MODE benchmark: run dsh-mnemos's REAL distillation
 * pipeline over the haystack (LLM -> structured memories), then the REAL
 * retrieval path over those memories. This is the complete product shape
 * (distill ingest + recall), as opposed to longmemeval.bench.test.ts which
 * skips ingest and loads sessions as-is.
 *
 * Design:
 *  - ONE LLM call per question: the whole haystack (all sessions) is joined
 *    into a single transcript with explicit session-boundary markers and fed
 *    through the production prompt (DISTILL_SYSTEM_PROMPT). deepseek-v4-flash
 *    has a 1M-token context, so the entire ~0.5M-char haystack fits in one
 *    shot; distilling per-session would burn ~48 calls per question for no
 *    gain.
 *  - Because memories are produced from the whole haystack at once, the
 *    answer-session attribution used by the pure-retrieval bench is not
 *    available. Judgement is content-level: a hit is credited when a returned
 *    memory's text carries the answer's content words (this matches the
 *    product meaning - what matters is whether the model can retrieve a memory
 *    that actually holds the answer).
 *  - Retrieval is the production path (service.search = FTS5 ladder + bigram).
 *  - Metrics: hit@1/5/10/20 (top-k contains >=1 answer word), MRR.
 *
 * LLM wiring (independent of the DSH host):
 *  - Keys are read from ~/.dsh/.credentials.yaml (DEEPSEEK_API_KEY /
 *    ARK_API_KEY), never hardcoded.
 *  - Provider selected by BENCH_LLM: 'ark' (Volcengine ARK, model
 *    deepseek-v4-flash-ga-260731) or 'deepseek' (DeepSeek official API,
 *    deepseek-v4-flash). Default 'deepseek'.
 *
 * Run:
 *   BENCH_LLM=deepseek BENCH_DATA=/path/to/longmemeval_s_cleaned.json \
 *     BENCH_SKIP_ABS=1 BENCH_LIMIT=5 \
 *     npx vitest run scripts/bench/longmemeval.distill.bench.test.ts
 *
 * Cost note: one LLM call per question (long input, ~0.5M chars). Start with
 * BENCH_LIMIT=2-3 to validate, then scale with BENCH_CONCURRENCY.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, readFileSync as read } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from '../../src/domain/store.js';
import { createMemoryService, DEFAULT_GATE } from '../../src/domain/service.js';
import { createSensitiveDetector } from '../../src/domain/sensitive.js';
import { DISTILL_SYSTEM_PROMPT, parseDistillResponse, isValidEntry } from '../../src/domain/distill.js';
import type { Llm, LlmMessage } from '../../src/domain/llm.js';
import type { Memory, MemoryType, MemoryScope } from '../../src/domain/types.js';

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

// ---- LLM wiring -----------------------------------------------------------

function readCredential(name: string): string | undefined {
  try {
    const p = join(homedir(), '.dsh', '.credentials.yaml');
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*refs:\s*$/.exec(line);
      void m;
      const kv = /^\s*([A-Z0-9_]+):\s*(.+)\s*$/.exec(line);
      if (kv && kv[1] === name) return kv[2]!.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class OpenAICompatLlm implements Llm {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}
  async complete(messages: LlmMessage[]): Promise<string> {
    // Rate limits are per-account and aggressive (observed 429s on ARK); retry
    // with exponential backoff so a long run survives a throttle window.
    let delay = 2000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? '';
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`llm ${res.status}: ${body.slice(0, 300)}`);
    }
    throw new Error(`llm: giving up after retries (rate limited)`);
  }
}

function resolveLlm(): { llm: Llm; label: string } {
  const mode = process.env.BENCH_LLM ?? 'deepseek';
  if (mode === 'ark') {
    const key = readCredential('ARK_API_KEY');
    if (!key) throw new Error('ARK_API_KEY not found in ~/.dsh/.credentials.yaml');
    return { llm: new OpenAICompatLlm('https://ark.cn-beijing.volces.com/api/coding/v3', key, process.env.BENCH_MODEL ?? 'deepseek-v4-flash-ga-260731'), label: `ark(${process.env.BENCH_MODEL ?? 'deepseek-v4-flash-ga-260731'})` };
  }
  const key = readCredential('DEEPSEEK_API_KEY');
  if (!key) throw new Error('DEEPSEEK_API_KEY not found in ~/.dsh/.credentials.yaml');
  return { llm: new OpenAICompatLlm('https://api.deepseek.com', key, process.env.BENCH_MODEL ?? 'deepseek-v4-flash'), label: `deepseek(${process.env.BENCH_MODEL ?? 'deepseek-v4-flash'})` };
}

// ---- distillation to memories ---------------------------------------------

function distillQuestion(llm: Llm, q: LmeQuestion): Promise<Memory[]> {
  return (async () => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const sid = q.haystack_session_ids[si]!;
      if (seen.has(sid)) continue;
      seen.add(sid);
      const turns = q.haystack_sessions[si]!;
      parts.push(`=== SESSION ${sid} ===`);
      for (const t of turns) parts.push(`${t.role}: ${t.content}`);
    }
    const request: LlmMessage[] = [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n') },
    ];
    const text = await llm.complete(request);
    const entries = parseDistillResponse(text).filter(isValidEntry);
    const base = new Date().toISOString();
    return entries.map((e, i): Memory => ({
      id: `mm://distill/${createHash('sha1').update(`${q.question_id}\u0000${i}`).digest('hex').slice(0, 24)}`,
      type: (e.type ?? 'project_fact') as MemoryType,
      scope: (e.scope ?? 'workspace') as MemoryScope,
      workspace: 'work-lme',
      topic: e.topic,
      summary: e.summary,
      detail: e.detail,
      keywords: e.keywords,
      evidence: [{ sessionId: q.haystack_session_ids[0] ?? 'question', eventRange: [0, 0], quote: '' }],
      confidence: e.confidence,
      source: 'evolve',
      writer: 'bench-distill',
      createdAt: base,
      updatedAt: base,
      crossSessionHits: 0,
      status: 'active',
    }));
  })();
}

/** Collect every string value in the answer into one lowercase blob. */
function answerText(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'number' || typeof answer === 'boolean') return String(answer);
  if (Array.isArray(answer)) return answer.map(answerText).join(' ');
  if (answer && typeof answer === 'object') {
    return Object.values(answer)
      .map(answerText)
      .join(' ');
  }
  return '';
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'as', 'with', 'by', 'that', 'this', 'it', 'its', 'from']);

/** Content words of the answer, lowercase, len>=4 (len>=1 if it's the whole answer). */
function answerWords(answer: unknown): Set<string> {
  const text = answerText(answer);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  const words = tokens.filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const set = new Set(words.length > 0 ? words : tokens);
  return set;
}

/** Does a memory's text carry any of the answer's content words? */
function memoryCarriesAnswer(mem: Memory, words: Set<string>): boolean {
  const blob = `${mem.topic} ${mem.summary} ${mem.detail} ${mem.keywords.join(' ')}`.toLowerCase();
  for (const w of words) {
    if (w.length >= 4 && blob.includes(w)) return true;
    if (w.length < 4 && new RegExp(`\\b${w}\\b`).test(blob)) return true;
  }
  return false;
}

// ---- benchmark core --------------------------------------------------------

interface Result {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  r20: number;
  miss: number;
  mrr: number;
  calls: number;
  memoriesProduced: number;
  questionsWithZeroMemories: number;
}
const newResult = (): Result => ({ n: 0, r1: 0, r5: 0, r10: 0, r20: 0, miss: 0, mrr: 0, calls: 0, memoriesProduced: 0, questionsWithZeroMemories: 0 });

export async function runDistillBench(
  llm: Llm,
  questions: LmeQuestion[],
  log: (line: string) => void = console.log,
  outPath?: string,
): Promise<Result> {
  const res = newResult();
  const t0 = Date.now();
  for (const q of questions) {
    const store = openMemoryStore(':memory:');
    try {
      const service = createMemoryService(store, createSensitiveDetector(), DEFAULT_GATE);
      const memories = await distillQuestion(llm, q);
      res.calls++;
      res.memoriesProduced += memories.length;
      if (memories.length === 0) res.questionsWithZeroMemories++;
      for (const m of memories) store.addMemory(m);
      const words = answerWords(q.answer);
      const ranked = service.search(q.question, TOP).map((r) => r.id);
      const memById = new Map(memories.map((m) => [m.id, m]));
      let rank = 0;
      for (let i = 0; i < ranked.length; i++) {
        const mem = memById.get(ranked[i]!);
        if (mem && memoryCarriesAnswer(mem, words)) { rank = i + 1; break; }
      }
      res.n++;
      if (rank >= 1) res.mrr += 1 / rank;
      if (rank === 0) res.miss++;
      else {
        if (rank <= 1) res.r1++;
        if (rank <= 5) res.r5++;
        if (rank <= 10) res.r10++;
        if (rank <= 20) res.r20++;
      }
      log(`  ${q.question_id} ${q.question_type.padEnd(22)} rank=${rank} ans=[${answerText(q.answer).slice(0, 40)}] memories=${memories.length} hit=${rank > 0 && rank <= 20 ? 'Y' : 'N'}`);
    } finally {
      store.close();
    }
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\nLongMemEval-S DISTILL MODE (n=${res.n}, wall=${wall}s, one LLM call per question)`);
  log(`LLM calls: ${res.calls}, memories produced: ${res.memoriesProduced}, questions with 0 memories: ${res.questionsWithZeroMemories}`);
  log(`hit@1=${(100 * res.r1 / res.n).toFixed(1)}% hit@5=${(100 * res.r5 / res.n).toFixed(1)}% hit@10=${(100 * res.r10 / res.n).toFixed(1)}% hit@20=${(100 * res.r20 / res.n).toFixed(1)}% MRR=${(res.mrr / res.n).toFixed(3)}`);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: 'distill', llm: (process.env.BENCH_LLM ?? 'deepseek'), n: res.n, llm_calls: res.calls, memories_produced: res.memoriesProduced, questions_with_zero_memories: res.questionsWithZeroMemories, hit_at_1: +(res.r1 / res.n).toFixed(3), hit_at_5: +(res.r5 / res.n).toFixed(3), hit_at_10: +(res.r10 / res.n).toFixed(3), hit_at_20: +(res.r20 / res.n).toFixed(3), mrr: +(res.mrr / res.n).toFixed(3) }, null, 2));
  }
  return res;
}

// Skipped by default (needs BENCH_DATA + a real LLM key). Enable explicitly.
const suite = process.env.BENCH_DATA ? describe : describe.skip;

suite('LongMemEval-S distill-mode benchmark (real LLM)', () => {
  it('distills the haystack through the production pipeline then retrieves', async () => {
    const dataPath = process.env.BENCH_DATA!;
    let questions = JSON.parse(readFileSync(dataPath, 'utf8')) as LmeQuestion[];
    if (process.env.BENCH_SKIP_ABS) {
      questions = questions.filter((q) => !q.question_id.includes('_abs'));
    }
    const limit = Number(process.env.BENCH_LIMIT);
    if (Number.isFinite(limit) && limit > 0 && limit < questions.length) {
      questions = questions.slice(0, limit);
    }
    const { llm, label } = resolveLlm();
    const res = await runDistillBench(llm, questions, console.log, process.env.BENCH_OUT);
    expect(res.n).toBeGreaterThan(0);
    void label;
  }, 7200000);
});
