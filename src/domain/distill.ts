/**
 * Distillation pipeline (M2): turn a conversation window into strict, validated
 * memory and rule candidates.
 *
 * The distiller runs an isolated specialist role (its own system prompt, never
 * inheriting the main conversation history), asks for strict JSON, parses and
 * schema-validates the output (invalid output is dropped, never half-applied),
 * then routes every candidate through the same approval gate. Deterministic
 * conflict detection flags near-duplicate-but-different claims for manual
 * adjudication (never auto-approved).
 */
import { Llm, LlmMessage } from './llm.js';
import { MemoryInput, MemoryScope, MemoryType, Evidence, MemorySource, Rule, RuleKind } from './types.js';
import { ImportedMessage } from './imports/types.js';
import { MemoryService } from './service.js';
import { similarity, normalizeTopic } from './dedup.js';
import { createHash } from 'node:crypto';

export const DISTILL_SYSTEM_PROMPT = `You are a memory curator for a coding-assistant harness.
Read the conversation and extract durable, reusable facts the user would want remembered across sessions.
Follow the JSON schema exactly. Output ONLY a JSON array, no prose, no markdown fences.
Each item:
{"type":"project_fact"|"procedure"|"preference"|"error_fix"|"decision"|"protocol",
 "topic":"short normalized title",
 "summary":"one-sentence fact",
 "detail":"optional longer context",
 "confidence":0.0-1.0,
 "keywords":["...","..."]}
Rules:
- Extract only high-signal facts: explicit user instructions/preferences, workflows, errors that were fixed, decisions with reasons.
- Do NOT extract one-off trivia, code snippets, or credentials.
- A "procedure" is a repeatable workflow; a "preference" is a stated user preference; an "error_fix" is a problem that was solved a specific way.
- A "protocol" is an ENVIRONMENT or TOOL-CALLING convention the agent must always operate under (e.g. "every bash call runs in a fresh bwrap sandbox; /tmp is tmpfs and is wiped"). Protocol memories are injected every session, so keep them few and general — not per-task details.
- Set confidence low (<=0.6) when unsure.
- "keywords" must contain 2-5 SHORT, DISCRIMINATIVE terms or phrases the user would type verbatim later (e.g. "pnpm", "deploy to us-east-1", "git hooks"). Keywords drive automatic injection later, so pick terms that uniquely surface THIS memory and are unlikely to appear in unrelated talk. One word or a short noun phrase each; lowercase; no punctuation; never the whole sentence.`;

export interface DistillEntry {
  type: MemoryType;
  topic: string;
  summary: string;
  detail?: string;
  confidence: number;
  keywords?: string[];
}

export interface DistillOutput {
  memories: DistillEntry[];
  rules: Array<{ kind: RuleKind; text: string; confidence: number }>;
}

export interface DistillOptions {
  scope: MemoryScope;
  workspace?: string;
  sessionId?: string;
}

export interface DistillStats {
  requested: number;
  returned: number;
  dropped: number;
  memories: number;
  rules: number;
  conflicts: number;
}

/**
 * Incremental distillation cursor: per session, the last processed message
 * index plus its content hash, so an updated session reprocesses only its tail
 * (or from the cursor when the message at the cursor changed) instead of the
 * whole history.
 */
export interface DistillCursor {
  [sessionId: string]: { index: number; hash: string };
}

export function messageHash(msg: ImportedMessage): string {
  return createHash('sha1').update(`${msg.sessionId}:${msg.index}:${msg.text}`).digest('hex');
}

export function filterNewMessages(
  messages: ImportedMessage[],
  cursor: DistillCursor,
): { newMessages: ImportedMessage[]; updated: DistillCursor } {
  const updated: DistillCursor = { ...cursor };
  if (messages.length === 0) {
    return { newMessages: [], updated };
  }
  const sessionId = messages[0]!.sessionId;
  const last = messages[messages.length - 1]!;
  const prev = cursor[sessionId];
  let start = 0;
  if (prev) {
    start = prev.index + 1;
    const at = messages.find((m) => m.index === prev.index);
    if (at && messageHash(at) !== prev.hash) {
      start = prev.index;
    }
  }
  const newMessages = messages.slice(start);
  updated[sessionId] = { index: last.index, hash: messageHash(last) };
  return { newMessages, updated };
}

function transcriptMessages(messages: ImportedMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user';
    const prefix = m.role === 'tool' ? (m.name ? `[tool ${m.name}] ` : '[tool] ') : '';
    out.push({ role, content: `${prefix}${m.text}` });
  }
  return out;
}

/** Extract the first JSON array from a model response, tolerating code fences. */
export function parseDistillResponse(text: string): DistillEntry[] {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isValidEntry).map((e) => e as DistillEntry)
      : [];
  } catch {
    return [];
  }
}

const TYPES = new Set<MemoryType>(['project_fact', 'procedure', 'preference', 'error_fix', 'decision', 'protocol']);

function isValidEntry(v: unknown): v is DistillEntry {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const o = v as Record<string, unknown>;
  const keywords = o.keywords === undefined ? [] : o.keywords;
  const keywordsValid =
    Array.isArray(keywords) &&
    keywords.every((k) => typeof k === 'string' && k.trim().length > 0);
  return (
    typeof o.type === 'string' &&
    TYPES.has(o.type as MemoryType) &&
    typeof o.topic === 'string' &&
    o.topic.trim().length > 0 &&
    typeof o.summary === 'string' &&
    o.summary.trim().length > 0 &&
    keywordsValid &&
    (o.confidence === undefined || (typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1))
  );
}

/** Map a distilled procedure/preference/error_fix into a reusable rule. */
export function toRule(d: DistillEntry): { kind: RuleKind; text: string } | undefined {
  switch (d.type) {
    case 'procedure':
      return { kind: 'skill', text: d.summary };
    case 'preference':
      return { kind: 'preference', text: d.summary };
    case 'error_fix':
      return { kind: 'system_prompt', text: d.summary };
    default:
      return undefined;
  }
}

export interface ConflictCandidate {
  entry: DistillEntry;
  existing: { id: string; topic: string; summary: string; similarity: number };
}

/**
 * Deterministic conflict detection: an entry whose topic is very close to an
 * existing active memory but whose summary differs. Conflicts are always routed
 * for manual adjudication, never auto-approved.
 */
export function detectConflicts(
  service: MemoryService,
  entries: DistillEntry[],
  threshold = 0.55,
): ConflictCandidate[] {
  const active = service.listActive();
  const out: ConflictCandidate[] = [];
  for (const entry of entries) {
    const target = `${entry.topic} ${entry.summary}`;
    let best: { id: string; topic: string; summary: string; similarity: number } | undefined;
    for (const row of active) {
      const sim = similarity(`${row.topic} ${row.summary}`, target);
      if (sim >= threshold && (!best || sim > best.similarity)) {
        best = { id: row.id, topic: row.topic, summary: row.summary, similarity: sim };
      }
    }
    if (best) {
      out.push({ entry, existing: best });
    }
  }
  return out;
}

function toMemoryInput(
  d: DistillEntry,
  opts: DistillOptions,
  conflict: boolean,
): MemoryInput {
  const scope = d.type === 'preference' ? 'global' : opts.scope;
  return {
    type: d.type,
    scope,
    workspace: scope === 'workspace' ? opts.workspace : undefined,
    topic: normalizeTopic(d.topic),
    summary: d.summary,
    detail: d.detail,
    keywords: (d.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
    evidence:
      opts.sessionId && d.confidence >= 0
        ? [{ sessionId: opts.sessionId, eventRange: [0, 0], quote: d.summary }]
        : [],
    confidence: conflict ? Math.min(d.confidence, 0.5) : d.confidence,
    source: 'evolve',
    writer: 'distill',
  };
}

function ruleToProposal(d: DistillEntry, opts: DistillOptions): Rule {
  const rule = toRule(d)!;
  const id = `rule-${createHash('sha1').update(`${rule.kind}:${rule.text}`).digest('hex').slice(0, 12)}`;
  return {
    id,
    kind: rule.kind,
    text: rule.text,
    evidence: opts.sessionId ? [{ sessionId: opts.sessionId, eventRange: [0, 0], quote: d.summary }] : [],
    state: 'proposed',
    proposedBy: 'distill',
    version: 1,
  };
}

export interface DistillRunner {
  run(messages: ImportedMessage[]): Promise<DistillStats>;
}

/**
 * Run one distillation pass over the incremental window: apply the cursor,
 * distill only the new messages, and return the updated cursor.
 */
export async function runDistillIncremental(
  llm: Llm,
  service: MemoryService,
  messages: ImportedMessage[],
  cursor: DistillCursor,
  opts: DistillOptions,
): Promise<{ stats: DistillStats; cursor: DistillCursor }> {
  const { newMessages, updated } = filterNewMessages(messages, cursor);
  const runner = createDistillRunner(llm, service, opts);
  const stats = await runner.run(newMessages);
  return { stats, cursor: updated };
}

/**
 * Run one distillation pass: build the specialist prompt, call the LLM, parse +
 * validate, route memories through the gate (conflicts forced to the queue) and
 * propose rules. Invalid LLM output is counted and dropped.
 */
export function createDistillRunner(
  llm: Llm,
  service: MemoryService,
  opts: DistillOptions,
): DistillRunner {
  return {
    async run(messages) {
      const stats: DistillStats = { requested: 0, returned: 0, dropped: 0, memories: 0, rules: 0, conflicts: 0 };
      if (messages.length === 0) {
        return stats;
      }
      const request: LlmMessage[] = [
        { role: 'system', content: DISTILL_SYSTEM_PROMPT },
        { role: 'user', content: transcriptMessages(messages).map((m) => `${m.role}: ${m.content}`).join('\n') },
      ];
      stats.requested = messages.length;
      const text = await llm.complete(request);
      const entries = parseDistillResponse(text);
      stats.returned = entries.length;
      const valid = entries.filter(isValidEntry);
      stats.dropped = entries.length - valid.length;

      const conflicts = detectConflicts(service, valid);
      stats.conflicts = conflicts.length;
      const conflictMap = new Map(conflicts.map((c) => [c.entry, c]));

      for (const entry of valid) {
        const conflict = conflictMap.get(entry);
        const rule = toRule(entry);
        if (conflict) {
          const result = service.proposeReplacement(
            toMemoryInput(entry, opts, true),
            conflict.existing.id,
            'model',
          );
          if (result.outcome === 'proposed') {
            stats.memories++;
          }
        } else if (rule) {
          const proposed = service.proposeRule(ruleToProposal(entry, opts), 'model');
          if (proposed.outcome === 'proposed') {
            stats.rules++;
          }
        } else {
          const result = service.add(toMemoryInput(entry, opts, false), 'model');
          if (result.outcome === 'committed' || result.outcome === 'proposed') {
            stats.memories++;
          }
        }
      }
      return stats;
    },
  };
}
