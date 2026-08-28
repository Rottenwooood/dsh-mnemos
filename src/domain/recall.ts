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
  opts: { maxBytes?: number; limit?: number; workspace?: string; personaText?: string; personaMax?: number; untrustedMax?: number } = {},
): Injection {
  const maxBytes = opts.maxBytes ?? 2048;
  const limit = opts.limit ?? 50;
  const personaMax = opts.personaMax ?? 2;
  // Bounded occupancy (P3): untrusted (model/import) entries are capped in
  // count and placed after trusted ones — no additive provenance weights, which
  // poison-resistance work (2608.21230) shows has no usable setting.
  const untrustedMax = opts.untrustedMax ?? 3;
  const now = Date.now();
  const rows = [
    ...service.listActive('global'),
    ...service.listActive('workspace', opts.workspace),
  ].sort((a, b) => heatOf(b, now) - heatOf(a, now) || b.crossSessionHits - a.crossSessionHits);
  const trusted = rows.filter((r) => r.trust !== 'untrusted').slice(0, limit);
  const untrusted = rows.filter((r) => r.trust === 'untrusted').slice(0, untrustedMax);
  const ranked = [...trusted, ...untrusted];
  const lines = ranked.map((r) => {
    const kws = r.keywords.length > 0 ? `（${r.keywords.slice(0, 4).join(' ')}）` : '';
    const tag = r.scope === 'global' ? 'g' : 'w';
    const src = r.trust === 'untrusted' ? '/未验证' : '';
    return `- [${r.type}/${tag}${src}] ${memoryShortId(r.id)} ${r.topic}${kws}`;
  });
  let text = '# dsh-mnemos 记忆索引\n（来源标记：/未验证 = 模型/导入内容，非人工确认；要细节用 memory_get <短id>）\n';
  const injectedIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = `${lines[i]}\n`;
    if (Buffer.byteLength(text + line, 'utf8') > maxBytes) {
      break;
    }
    text += line;
    injectedIds.push(ranked[i]!.id);
  }
  // Persona projection (pyramid L3): approved persona claims relevant to the
  // current task text (keyword-overlap), else workspace claims by weight, up to
  // personaMax, within the byte budget. These are index text only — not ledger
  // tracked, not memory_get addresses.
  const approved = service.listPersona('approved').sort((a, b) => b.weight - a.weight);
  if (approved.length > 0 && Buffer.byteLength(text, 'utf8') < maxBytes) {
    const words = new Set(
      (opts.personaText ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    );
    const scored = approved
      .map((p) => {
        const claimWords = new Set(
          p.claim.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2),
        );
        const relevance = words.size > 0
          ? [...claimWords].filter((w) => words.has(w)).length
          : p.workspace === opts.workspace ? 1 : 0;
        return { p, relevance };
      })
      .sort((a, b) => b.relevance - a.relevance || b.p.weight - a.p.weight)
      .slice(0, personaMax)
      .filter((x) => x.relevance > 0);
    for (const { p } of scored) {
      const line = `- [persona] ${p.claim}\n`;
      if (Buffer.byteLength(text + line, 'utf8') > maxBytes) {
        break;
      }
      text += line;
    }
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

/** Power-law coldness H = 1/(1+λ·Δt)^α on days since accessedAt||createdAt. */
export function heatOf(row: { accessedAt: string; updatedAt: string }, now = Date.now()): number {
  const at = Date.parse(row.accessedAt || row.updatedAt);
  const dtDays = Number.isFinite(at) ? Math.max(0, (now - at) / 86_400_000) : 0;
  return 1 / Math.pow(1 + 0.2 * dtDays, 1.0);
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
