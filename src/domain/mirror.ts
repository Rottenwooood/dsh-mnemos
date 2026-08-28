/**
 * Markdown mirror (M4): the human-readable, git-tracked representation of the
 * memory store. One Markdown file per memory entry keeps git history per-entry:
 * independent entries never conflict on merge, and a changed entry surfaces as
 * a clean per-file diff. Deleted entries are removed from the mirror (their
 * history stays in git).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Memory, Evidence } from './types.js';
import { MemoryStore } from './store.js';

export function memoryShortId(id: string): string {
  const last = id.split('/').at(-1) ?? id;
  return last.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
}

export function memoryFileName(memory: Pick<Memory, 'id' | 'topic'>): string {
  const slug = memory.topic
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${memoryShortId(memory.id)}-${slug || 'memory'}.md`;
}

export function renderMemoryFile(memory: Memory): string {
  const evidence = memory.evidence
    .map((e) => `- ${e.sessionId} [${e.eventRange[0]}-${e.eventRange[1]}] ${e.quote}`)
    .join('\n');
  return [
    '---',
    `id: ${memory.id}`,
    `type: ${memory.type}`,
    `scope: ${memory.scope}`,
    `workspace: ${memory.workspace ?? ''}`,
    `topic: ${memory.topic}`,
    `summary: ${memory.summary}`,
    `status: ${memory.status}`,
    `confidence: ${memory.confidence}`,
    `keywords: ${(memory.keywords ?? []).join(', ')}`,
    `source: ${memory.source}`,
    `writer: ${memory.writer}`,
    `created_at: ${memory.createdAt}`,
    `updated_at: ${memory.updatedAt}`,
    '---',
    '',
    memory.detail ? `## 详情\n\n${memory.detail}\n` : '',
    evidence ? `## 溯源\n\n${evidence}\n` : '',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

interface Frontmatter {
  [key: string]: string;
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  if (!text.startsWith('---\n')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    return { meta: {}, body: text };
  }
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  const meta: Frontmatter = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) {
      continue;
    }
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body };
}

/** Read a mirror file back into the fields needed for rollback/restore. */
export function parseMemoryFile(text: string): Partial<Memory> | undefined {
  const { meta, body } = parseFrontmatter(text);
  const id = meta.id;
  if (!id) {
    return undefined;
  }
  const lines = body.split('\n');
  // summary moved into frontmatter (format B); fall back to the old convention
  // (first non-empty body line) so pre-B files and old git history still parse.
  const summary = meta.summary?.trim() || (lines.find((l) => l.trim().length > 0)?.trim() ?? '');
  const detailIdx = lines.findIndex((l) => l.startsWith('## 详情'));
  const detail =
    detailIdx !== -1
      ? lines
          .slice(detailIdx + 1)
          .filter((l) => !l.startsWith('## 溯源'))
          .join('\n')
          .trim()
      : undefined;
  const evidenceIdx = lines.findIndex((l) => l.startsWith('## 溯源'));
  const evidence: Evidence[] = evidenceIdx !== -1
    ? lines
        .slice(evidenceIdx + 1)
        .filter((l) => !l.startsWith('## '))
        .map((l) => l.replace(/^-\s*/, '').trim())
        .filter(Boolean)
        .map((l) => {
          const m = l.match(/^(\S+)\s+\[(\d+)-(\d+)\]\s*(.*)$/);
          return m
            ? { sessionId: m[1]!, eventRange: [Number(m[2]), Number(m[3])] as [number, number], quote: m[4]! }
            : null;
        })
        .filter((e): e is Evidence => e !== null)
    : [];
  return {
    id,
    type: (meta.type ?? 'project_fact') as Memory['type'],
    scope: (meta.scope ?? 'workspace') as Memory['scope'],
    workspace: meta.workspace || undefined,
    topic: meta.topic ?? '',
    summary,
    detail: detail || undefined,
    keywords: (meta.keywords ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    confidence: Number(meta.confidence ?? 1),
    source: (meta.source ?? 'manual') as Memory['source'],
    writer: meta.writer ?? 'unknown',
    status: (meta.status ?? 'active') as Memory['status'],
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    crossSessionHits: 0,
    evidence,
  };
}

export interface MirrorSyncResult {
  written: string[];
  removed: string[];
}

/** Mirror active+archived entries to files; remove files for deleted entries. */
export function syncMirror(store: MemoryStore, mirrorDir: string): MirrorSyncResult {
  mkdirSync(mirrorDir, { recursive: true });
  const result: MirrorSyncResult = { written: [], removed: [] };
  const all = store.listSummaries(undefined, undefined, 'active');
  const archived = store.listSummaries(undefined, undefined, 'archived');
  const seen = new Set<string>();
  for (const row of [...all, ...archived]) {
    const memory = store.getMemory(row.id);
    if (!memory) {
      continue;
    }
    const file = memoryFileName(memory);
    seen.add(file);
    const text = renderMemoryFile(memory);
    const path = join(mirrorDir, file);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      writeFileSync(path, text, 'utf8');
      result.written.push(file);
    }
  }
  for (const file of readdirSync(mirrorDir)) {
    if (file.endsWith('.md') && !seen.has(file)) {
      unlinkSync(join(mirrorDir, file));
      result.removed.push(file);
    }
  }
  return result;
}

/** The mirror file name for a memory id, or undefined when it does not exist. */
export function mirrorFileFor(mirrorDir: string, id: string): string | undefined {
  const shortId = memoryShortId(id);
  return readdirSync(mirrorDir).find((f) => f.startsWith(`${shortId}-`) && f.endsWith('.md'));
}

export function updateMemoryFile(mirrorDir: string, memory: Memory): void {
  writeFileSync(join(mirrorDir, memoryFileName(memory)), renderMemoryFile(memory), 'utf8');
}

export function removeMemoryFile(mirrorDir: string, id: string): void {
  const file = mirrorFileFor(mirrorDir, id);
  if (file) {
    unlinkSync(join(mirrorDir, file));
  }
}

function fullMemoryFromParsed(parsed: Partial<Memory>): Memory {
  const now = new Date().toISOString();
  return {
    id: parsed.id!,
    type: parsed.type ?? 'project_fact',
    scope: parsed.scope ?? 'workspace',
    workspace: parsed.workspace,
    topic: parsed.topic ?? 'imported',
    summary: parsed.summary ?? '',
    detail: parsed.detail,
    evidence: parsed.evidence ?? [],
    confidence: parsed.confidence ?? 1,
    source: parsed.source ?? 'import',
    writer: parsed.writer ?? 'sync',
    createdAt: parsed.createdAt ?? now,
    updatedAt: parsed.updatedAt ?? now,
    crossSessionHits: parsed.crossSessionHits ?? 0,
    status: parsed.status ?? 'active',
  };
}

/**
 * Reconcile the store from the merged mirror (used after a pull). Memories that
 * exist on disk are upserted; memories whose mirror file disappeared are
 * soft-deleted. The store stays the source of truth for queries.
 */
export function applyMirrorToStore(store: MemoryStore, mirrorDir: string): { applied: number } {
  let applied = 0;
  const seen = new Set<string>();
  for (const file of readdirSync(mirrorDir).filter((f) => f.endsWith('.md'))) {
    const parsed = parseMemoryFile(readFileSync(join(mirrorDir, file), 'utf8'));
    if (!parsed?.id) {
      continue;
    }
    seen.add(parsed.id);
    const existing = store.getMemory(parsed.id);
    if (existing) {
      store.updateMemory(parsed.id, {
        type: parsed.type ?? existing.type,
        scope: parsed.scope ?? existing.scope,
        workspace: parsed.workspace ?? existing.workspace,
        topic: parsed.topic ?? existing.topic,
        summary: parsed.summary || existing.summary,
        detail: parsed.detail ?? existing.detail,
        keywords: parsed.keywords,
        confidence: parsed.confidence ?? existing.confidence,
      });
    } else {
      store.addMemory(fullMemoryFromParsed(parsed));
    }
    applied++;
  }
  for (const row of store.listSummaries(undefined, undefined, 'active')) {
    if (!seen.has(row.id)) {
      store.setMemoryStatus(row.id, 'deleted');
    }
  }
  return { applied };
}
