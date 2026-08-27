/**
 * Cold/hot layered recall (M1).
 *
 * Hot layer = the tiny projection injected into every model request under a
 * hard byte budget (never a second API call). Warm/cold layers are on-demand:
 * searched via FTS5 + bigram fallback when the model needs evidence. All
 * ranking here is deterministic and zero-LLM.
 */
import { SummaryRow } from './store.js';
import { MemoryScope } from './types.js';
import { MemoryService } from './service.js';

export interface RankedMemory {
  id: string;
  topic: string;
  summary: string;
  type: string;
  scope: MemoryScope;
  workspace: string | null;
  crossSessionHits: number;
  updatedAt: string;
  score: number;
}

export interface Injection {
  text: string;
  injectedCount: number;
  droppedCount: number;
  /** Ids of the memories that made it into the projection (for hit tracking). */
  injectedIds: string[];
}

function toRanked(row: SummaryRow, score: number): RankedMemory {
  return {
    id: row.id,
    topic: row.topic,
    summary: row.summary,
    type: row.type,
    scope: row.scope,
    workspace: row.workspace,
    crossSessionHits: row.crossSessionHits,
    updatedAt: row.updatedAt,
    score,
  };
}

/**
 * Compact one-line projection per memory, e.g.
 * `- [preference] use pnpm: The project builds with pnpm.`
 */
function projection(m: RankedMemory): string {
  const scopeTag = m.scope === 'global' ? 'global' : 'ws';
  return `- [${m.type}/${scopeTag}] ${m.topic}: ${m.summary}`;
}

/**
 * Fit as many top-ranked memories as possible into `maxBytes` (UTF-8). Dropped
 * entries are returned as a count, never silently merged or truncated.
 */
export function buildInjection(ranked: RankedMemory[], maxBytes: number): Injection {
  const header = '# dsh-mnemos\n';
  let text = header;
  let injected = 0;
  const injectedIds: string[] = [];
  for (const m of ranked) {
    const line = `${projection(m)}\n`;
    if (Buffer.byteLength(text + line, 'utf8') > maxBytes) {
      break;
    }
    text += line;
    injected++;
    injectedIds.push(m.id);
  }
  return { text, injectedCount: injected, droppedCount: ranked.length - injected, injectedIds };
}

/**
 * Hot layer: top memories by cross-session use, no query. Usually injected
 * every turn, so it stays small and cheap.
 */
export function recallHot(
  service: MemoryService,
  opts: { maxBytes?: number; limit?: number; scope?: MemoryScope; minHits?: number } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 2048;
  const limit = opts.limit ?? 20;
  const minHits = opts.minHits ?? 0;
  const rows = service
    .listActive(opts.scope)
    .filter((r) => r.crossSessionHits >= minHits)
    .sort((a, b) => {
      const hits = b.crossSessionHits - a.crossSessionHits;
      return hits !== 0 ? hits : b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit);
  return buildInjection(rows.map((r) => toRanked(r, r.crossSessionHits)), maxBytes);
}

/**
 * Keyword-triggered recall (the injection path): scan session text for each
 * active memory's keywords and inject the ones that hit. Memories without
 * keywords fall back to their topic. Matching is a case-insensitive substring
 * on terms of length >= 2, so it stays low-frequency and deterministic.
 */
export function recallByKeywords(
  service: MemoryService,
  text: string,
  opts: { maxBytes?: number; limit?: number; scope?: MemoryScope } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 2048;
  const limit = opts.limit ?? 8;
  const lower = text.toLowerCase();
  const matched: RankedMemory[] = [];
  for (const row of service.listActive(opts.scope)) {
    const terms = row.keywords.length > 0 ? row.keywords : [row.topic];
    const hit = terms.some((k) => k.trim().length >= 2 && lower.includes(k.trim().toLowerCase()));
    if (hit) {
      matched.push(toRanked(row, matched.length));
    }
  }
  matched.sort((a, b) => b.crossSessionHits - a.crossSessionHits);
  return buildInjection(matched.slice(0, limit), maxBytes);
}

/**
 * Warm/cold layer: search then rank, fit the budget. Ranking is the shared
 * hybrid search in MemoryService — reciprocal rank fusion of the store's FTS5
 * BM25 (or LIKE) ranking with a bigram-Jaccard ranking (dsh-evolve's zero-token
 * deterministic recall, no LLM, no embeddings).
 */
export function recallQuery(
  service: MemoryService,
  query: string,
  opts: { maxBytes?: number; limit?: number; scope?: MemoryScope } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 4096;
  const limit = opts.limit ?? 10;
  const rows = service.search(query, limit);
  const ranked = rows.map((r) => toRanked(r, rows.length - rows.indexOf(r)));
  ranked.sort((a, b) => b.score - a.score);
  return buildInjection(ranked, maxBytes);
}
