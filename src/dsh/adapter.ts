/**
 * Open measurement ABI (P3.2): `recall / get / state / probe` as a documented,
 * versioned surface every client can call through `ctx.mnemos`. Conformance
 * (scripts/conformance.mts) proves these are the real implementation, not a
 * stub. The ABI mirrors what the eval harness measures (memlab-style).
 *
 *   recall({query, workspace, limit}) -> ranked hits (+ optional frozen index)
 *   get(idOrShortId)                  -> full memory
 *   state()                           -> counts/version/trust/ledger summary
 *   probe()                           -> liveness + version fingerprint
 */
import { MemoryService } from '../domain/service.js';
import { MemoryStore } from '../domain/store.js';
import { recallIndex, memoryShortId } from '../domain/recall.js';

export interface MnemosAbiRecallInput {
  query: string;
  workspace?: string;
  limit?: number;
  /** Also return the frozen byte-budget index text built for the workspace. */
  includeIndex?: boolean;
}

export interface MnemosAbi {
  recall(input: MnemosAbiRecallInput): {
    query: string;
    hits: Array<{
      id: string;
      topic: string;
      summary: string;
      type: string;
      scope: 'global' | 'workspace';
      keywords: string[];
      trust: 'trusted' | 'untrusted';
    }>;
    index?: { text: string; injectedCount: number };
  };
  get(idOrShortId: string): ReturnType<MemoryStore['getMemory']>;
  state(): {
    version: string;
    schemaVersion: number;
    active: number;
    pending: number;
    untrusted: number;
    verified: number;
    injections: number;
    used: number;
    usedRate: number;
  };
  probe(): { ok: true; name: 'dsh-mnemos'; version: string; dbPath: string; active: number };
}

export const MNEMOS_ABI_VERSION = '1.0.0';

export function createMnemosAbi(
  store: MemoryStore,
  service: MemoryService,
  version: string,
  dbPath: string,
): MnemosAbi {
  return {
    recall({ query, workspace, limit = 8, includeIndex = false }) {
      const rows = service.search(query, limit);
      const hits = rows
        .filter((r) => r.status === 'active')
        .map((r) => ({
          id: r.id,
          topic: r.topic,
          summary: r.summary,
          type: r.type,
          scope: r.scope,
          keywords: r.keywords,
          trust: r.trust,
        }));
      if (!includeIndex) {
        return { query, hits };
      }
      const index = recallIndex(service, { workspace, limit, maxBytes: 2048 });
      return { query, hits, index: { text: index.text, injectedCount: index.injectedCount } };
    },
    get(idOrShortId) {
      const byId = store.getMemory(idOrShortId);
      if (byId) {
        return byId;
      }
      const candidates = store.listSummaries(undefined, undefined, 'active').filter(
        (r) => memoryShortId(r.id) === idOrShortId,
      );
      return candidates[0] ? store.getMemory(candidates[0].id) : undefined;
    },
    state() {
      const telemetry = store.telemetry();
      const pending = store.listApprovals('proposed').length;
      const untrusted = store.listSummaries(undefined, undefined, 'active').filter(
        (r) => r.trust === 'untrusted',
      ).length;
      return {
        version: MNEMOS_ABI_VERSION,
        schemaVersion: 1,
        active: telemetry.totalActive,
        pending,
        untrusted,
        verified: telemetry.verifiedMemories,
        injections: telemetry.injections,
        used: telemetry.used,
        usedRate: telemetry.usedRate,
      };
    },
    probe() {
      return {
        ok: true,
        name: 'dsh-mnemos',
        version: MNEMOS_ABI_VERSION,
        dbPath,
        active: store.countActive(),
      };
    },
  };
}
