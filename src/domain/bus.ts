/**
 * Open memory bus (M3): the third-party-facing API for dsh-mnemos.
 *
 * Three primitives aligned with the ecosystem's minimal set:
 *   recall(query|scope)    — read: query memories (never writes)
 *   record(input, identity) — write: REQUIRES a declared plugin identity and
 *                              ALWAYS goes to the approval queue (never direct,
 *                              never auto-approved), then is audited
 *   subscribe(listener)    — watch memory changes (new committed memory,
 *                              proposal, replacement, revocation)
 *
 * Governance:
 *   - identity is mandatory; the writer is stamped as `plugin:<name>@<version>`
 *   - a plugin can be blacklisted at runtime; its writes are denied with an
 *     audit entry from then on
 *   - any third-party write can be revoked; only the owning plugin or a human
 *     may revoke it
 */
import { MemoryService } from './service.js';
import { MemoryStore, SummaryRow } from './store.js';
import { Memory, MemoryInput, MemoryScope } from './types.js';
import { exactDedupKey } from './dedup.js';
import { memoryShortId } from './recall.js';

export interface BusIdentity {
  name: string;
  version: string;
}

export interface BusRecallOptions {
  query?: string;
  scope?: MemoryScope;
  workspace?: string;
  limit?: number;
}

export type BusEvent =
  | { type: 'memory-committed'; memory: Memory }
  | { type: 'memory-proposed'; approvalId: number; input: MemoryInput; identity: BusIdentity }
  | { type: 'memory-replaced'; memoryId: string }
  | { type: 'memory-revoked'; memoryId: string }

export interface BusRecordResult {
  outcome: 'committed' | 'proposed' | 'denied';
  approvalId?: number;
  reason?: string;
  memory?: Memory;
}

export interface MemoryBus {
  recall(opts: BusRecallOptions): SummaryRow[];
  /** Full memory by id (or short id). */
  get(idOrShortId: string): Memory | undefined;
  /** Bus-visible state: active count, pending, per-writer memory counts. */
  state(): { active: number; pending: number; writers: Array<{ name: string; count: number }> };
  record(input: MemoryInput, identity: BusIdentity): BusRecordResult;
  subscribe(listener: (event: BusEvent) => void): () => void;
  revoke(memoryId: string, identity: BusIdentity): { ok: boolean; reason?: string };
  blacklistPlugin(name: string, reason?: string): void;
  unblacklistPlugin(name: string): void;
  isBlacklisted(name: string): boolean;
  listBlacklist(): Array<{ name: string; reason?: string; blockedAt: string }>;
  /** Memories written by a plugin (all versions), for per-writer grouping. */
  listByWriter(name: string): SummaryRow[];
}

export function createMemoryBus(
  service: MemoryService,
  store: MemoryStore,
  emitExternal?: (event: BusEvent) => void,
): MemoryBus {
  const now = () => new Date().toISOString();
  const listeners = new Set<(event: BusEvent) => void>();
  const emit = (event: BusEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // subscriber errors never break the bus
      }
    }
    try {
      emitExternal?.(event);
    } catch {
      // external emission is best-effort
    }
  };
  const writerOf = (id: BusIdentity): string => `plugin:${id.name}@${id.version}`;

  return {
    recall(opts) {
      if (opts.query) {
        return service.search(opts.query, opts.limit ?? 10);
      }
      return service.listActive(opts.scope, opts.workspace);
    },

    get(idOrShortId) {
      const byId = store.getMemory(idOrShortId);
      if (byId) {
        return byId;
      }
      const match = service.listActive().find((r) => memoryShortId(r.id) === idOrShortId);
      return match ? store.getMemory(match.id) : undefined;
    },

    state() {
      const active = store.listSummaries(undefined, undefined, 'active');
      const writers = new Map<string, number>();
      for (const r of active) {
        writers.set(r.writer, (writers.get(r.writer) ?? 0) + 1);
      }
      return {
        active: active.length,
        pending: store.listApprovals('proposed').length,
        writers: [...writers.entries()].map(([name, count]) => ({ name, count })),
      };
    },

    record(input, identity) {
      const stamped: MemoryInput = { ...input, writer: writerOf(identity), source: 'third_party' };
      if (store.isBlacklisted(identity.name)) {
        store.insertAudit({
          ts: now(),
          action: 'denied',
          targetType: 'memory',
          targetId: exactDedupKey(stamped),
          payload: { ...stamped, identity },
          denied: 1,
          byAgent: 1,
          reason: 'plugin-blacklisted',
        });
        return { outcome: 'denied', reason: 'plugin-blacklisted' };
      }
      const result = service.add(stamped, 'plugin', true);
      if (result.outcome === 'proposed') {
        emit({ type: 'memory-proposed', approvalId: result.approvalId!, input: stamped, identity });
      } else if (result.outcome === 'committed' && result.memory) {
        emit({ type: 'memory-committed', memory: result.memory });
      }
      return {
        outcome: result.outcome,
        approvalId: result.approvalId,
        reason: result.reason,
        memory: result.memory,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    revoke(memoryId, identity) {
      const memory = store.getMemory(memoryId);
      if (!memory) {
        return { ok: false, reason: 'not-found' };
      }
      const isOwner = memory.writer === writerOf(identity);
      if (!isOwner && identity.name !== 'human') {
        return { ok: false, reason: 'not-owner' };
      }
      store.setMemoryStatus(memoryId, 'deleted');
      store.insertAudit({
        ts: now(),
        action: 'remove',
        targetType: 'memory',
        targetId: memoryId,
        payload: { by: identity },
        denied: 0,
        byAgent: 0,
        reason: 'revoked',
      });
      emit({ type: 'memory-revoked', memoryId });
      return { ok: true };
    },

    blacklistPlugin(name, reason) {
      store.upsertBlacklist(name, reason);
    },
    unblacklistPlugin(name) {
      store.removeBlacklist(name);
    },
    isBlacklisted(name) {
      return store.isBlacklisted(name);
    },
    listBlacklist() {
      return store.listBlacklist();
    },
    listByWriter(name) {
      return store.listByWriter(`plugin:${name}@%`);
    },
  };
}
