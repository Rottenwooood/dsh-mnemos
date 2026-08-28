/**
 * Consolidation / dream (P2): groups scattered memories into scenes and
 * evidence-weighted persona claims (pyramid L2/L3, self-improved; meow's dream
 * rounds; mneme's sleep). Deterministic and LLM-free so it runs anywhere; every
 * output is a PROPOSAL — nothing becomes visible to recall/injection until a
 * human approves it (propose-only, same gate as model-written memories).
 *
 * Scene: memories in the same workspace that share at least one keyword are one
 * task/effort; a cluster of >=2 becomes a scene candidate.
 * Persona: active preference/decision/protocol memories are stable traits;
 * grouped by normalized topic, each cluster becomes one claim whose weight is
 * evidence + observation counts.
 */
import { MemoryInput, Scene, PersonaClaim } from './types.js';
import { normalizeTopic } from './dedup.js';

/** The subset of the store consolidation needs; the service can satisfy it too. */
export interface ConsolidationStore {
  listSummaries(scope?: 'global' | 'workspace', workspace?: string, status?: 'active' | 'archived' | 'deleted', type?: string): Array<{
    id: string;
    type: string;
    scope: 'global' | 'workspace';
    workspace: string | null;
    topic: string;
    summary: string;
    keywords: string[];
    observationCount: number;
  }>;
  getMemory(id: string): { evidence: MemoryInput['evidence'] } | undefined;
  listScenes(state?: 'proposed' | 'approved' | 'rejected'): Scene[];
  addScene(s: Scene): void;
  listPersona(state?: 'proposed' | 'approved' | 'rejected'): PersonaClaim[];
  addPersona(p: PersonaClaim): void;
}

const PERSONA_TYPES = new Set(['preference', 'decision', 'protocol']);

function sharedKeyword(a: string[], b: string[]): boolean {
  const set = new Set(a.map((k) => k.toLowerCase()));
  return b.some((k) => set.has(k.toLowerCase()));
}

/** Cluster ids by workspace+shared-keyword connectedness (union-find, deterministic). */
function clusterByKeyword(rows: Array<{ id: string; workspace: string | null; keywords: string[] }>): string[][] {
  const clusters: Array<Array<{ id: string; workspace: string | null; keywords: string[] }>> = [];
  for (const row of rows) {
    const idx = clusters.findIndex((c) => c.some((m) => m.workspace === row.workspace && sharedKeyword(m.keywords, row.keywords)));
    if (idx >= 0) {
      clusters[idx]!.push(row);
    } else {
      clusters.push([row]);
    }
  }
  return clusters.filter((c) => c.length >= 2).map((c) => c.map((m) => m.id));
}

export interface ConsolidationResult {
  scenesProposed: number;
  scenesSkipped: number;
  personaProposed: number;
  personaSkipped: number;
}

export function runConsolidation(store: ConsolidationStore, proposedBy = 'model'): ConsolidationResult {
  const now = new Date().toISOString();
  let scenesProposed = 0;
  let scenesSkipped = 0;
  let personaProposed = 0;
  let personaSkipped = 0;

  const active = store.listSummaries(undefined, undefined, 'active');
  const existingScenes = store.listScenes();
  const existingPersona = store.listPersona();
  const existingSceneKeys = new Set(
    existingScenes.map((s) => `${s.workspace ?? ''}|${s.title}|${[...s.memoryIds].sort().join(',')}`),
  );
  const existingPersonaKeys = new Set(existingPersona.map((p) => `${p.workspace ?? ''}|${p.claim}`));

  // Scenes: keyword-connected clusters per workspace.
  const mems = active.map((r) => ({ id: r.id, workspace: r.workspace, keywords: r.keywords.length > 0 ? r.keywords : [r.topic] }));
  const clusters = clusterByKeyword(mems);
  for (const ids of clusters) {
    const members = active.filter((r) => ids.includes(r.id));
    const workspace = members[0]?.workspace ?? null;
    const title = members[0]?.topic ?? 'scene';
    const summary = members
      .map((r) => `[${r.type}] ${r.topic}: ${r.summary}`)
      .join('\n');
    const key = `${workspace ?? ''}|${title}|${[...ids].sort().join(',')}`;
    if (existingSceneKeys.has(key)) {
      scenesSkipped += 1;
      continue;
    }
    store.addScene({
      id: `scene://mnemos/${crypto.randomUUID()}`,
      workspace,
      title,
      summary,
      memoryIds: ids,
      state: 'proposed',
      proposedBy,
      createdAt: now,
      updatedAt: now,
    });
    scenesProposed += 1;
  }

  // Persona: stable-trait memories grouped by normalized topic.
  const traits = active.filter((r) => PERSONA_TYPES.has(r.type as string));
  const byTopic = new Map<string, typeof traits>();
  for (const r of traits) {
    const key = `${r.workspace ?? ''}|${normalizeTopic(r.topic)}`;
    const list = byTopic.get(key) ?? [];
    list.push(r);
    byTopic.set(key, list);
  }
  for (const [, group] of byTopic) {
    const claim = group.map((r) => r.summary).join('；');
    const workspace = group[0]?.workspace ?? null;
    const key = `${workspace ?? ''}|${claim}`;
    if (existingPersonaKeys.has(key)) {
      personaSkipped += 1;
      continue;
    }
    const weight =
      group.length +
      group.reduce((acc, r) => acc + r.observationCount, 0) +
      group.reduce((acc, r) => acc + (store.getMemory(r.id)?.evidence.length ?? 0), 0);
    store.addPersona({
      id: `persona://mnemos/${crypto.randomUUID()}`,
      workspace,
      claim,
      memoryIds: group.map((r) => r.id),
      weight,
      state: 'proposed',
      proposedBy,
      createdAt: now,
      updatedAt: now,
    });
    personaProposed += 1;
  }

  return { scenesProposed, scenesSkipped, personaProposed, personaSkipped };
}
