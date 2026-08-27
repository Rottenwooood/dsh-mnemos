/**
 * Deterministic dedup and conflict detection over character bigrams.
 * Zero-LLM: cheap, reproducible, and identical on every machine.
 */
import { MemoryInput } from './types.js';

export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function exactDedupKey(m: MemoryInput): string {
  return [m.scope, m.workspace ?? '', m.type, normalizeTopic(m.topic)].join('\u0000');
}

function bigrams(text: string): Set<string> {
  const t = normalizeTopic(text);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    out.add(t.slice(i, i + 2));
  }
  return out;
}

/** Jaccard similarity over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const g of A) {
    if (B.has(g)) {
      inter++;
    }
  }
  return inter / (A.size + B.size - inter);
}

export interface DuplicateCandidate {
  id: string;
  similarity: number;
}

/** Returns active memories whose summary is close enough to be a duplicate. */
export function findSimilar(
  summaries: Array<{ id: string; summary: string }>,
  target: string,
  threshold: number,
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  for (const { id, summary } of summaries) {
    const sim = similarity(summary, target);
    if (sim >= threshold) {
      out.push({ id, similarity: sim });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}
