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
 * Per-session frozen index (P1 progressive disclosure, engram-style): one line
 * per applicable memory (global + this workspace), sorted deterministically by
 * usage, byte-bounded. Injected ONCE per session — byte-stable, so it hits the
 * KV cache — and full details are fetched on demand via memory_get. This
 * replaces per-turn full-text injection: "retrieved ≠ injected".
 */
export function recallIndex(
  service: MemoryService,
  opts: { maxBytes?: number; limit?: number; workspace?: string } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 2048;
  const limit = opts.limit ?? 50;
  const rows = [
    ...service.listActive('global'),
    ...service.listActive('workspace', opts.workspace),
  ]
    .sort((a, b) => b.crossSessionHits - a.crossSessionHits || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  const lines = rows.map((r) => {
    const kws = r.keywords.length > 0 ? `（${r.keywords.slice(0, 4).join(' ')}）` : '';
    const tag = r.scope === 'global' ? 'g' : 'w';
    return `- [${r.type}/${tag}] ${memoryShortId(r.id)} ${r.topic}${kws}`;
  });
  let text = '# dsh-mnemos 记忆索引\n（要细节用 memory_get <短id>）\n';
  const injectedIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = `${lines[i]}\n`;
    if (Buffer.byteLength(text + line, 'utf8') > maxBytes) {
      break;
    }
    text += line;
    injectedIds.push(rows[i]!.id);
  }
  return {
    text,
    injectedCount: injectedIds.length,
    droppedCount: rows.length - injectedIds.length,
    injectedIds,
  };
}

/** Short 8-char id prefix for memory_get lookups. */
export function memoryShortId(id: string): string {
  const last = id.split('/').at(-1) ?? id;
  return last.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
}

/**
 * Keyword-scored recall (kept for search/drill-down paths): rank the memories
 * applicable to a session by whether the given text hits their keywords.
 */
export function recallByKeywords(
  service: MemoryService,
  text: string,
  opts: { maxBytes?: number; limit?: number; workspace?: string } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 2048;
  const limit = opts.limit ?? 8;
  const candidates = [
    ...service.listActive('global'),
    ...service.listActive('workspace', opts.workspace),
  ];
  const lower = text.toLowerCase();
  const matched: RankedMemory[] = [];
  for (const row of candidates) {
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
