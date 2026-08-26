/**
 * MemoryService: the single write path for dsh-mnemos.
 *
 * The gate has two steps, matching the product spec:
 * 1. Program checks (deterministic): budget, sensitive content, exact dedup,
 *    writer blacklist, model-global-scope policy. Any hit is DENIED immediately
 *    and recorded in the audit log with `denied=1` (the "model tried to write
 *    and was rejected" record).
 * 2. Risk triage: human writes commit directly; model/plugin writes that are
 *    auto-approvable (high-confidence, low-risk workspace facts) commit with
 *    `autoApprove` enabled; everything else goes to the approval queue.
 */
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.js';
import { Memory, MemoryInput, Caller, Rule } from './types.js';
import { SensitiveDetector } from './sensitive.js';
import { exactDedupKey } from './dedup.js';

export interface GateConfig {
  maxEntries: number;
  maxBytesPerEntry: number;
  autoApprove: boolean;
  autoApproveConfidence: number;
  allowModelGlobalWrite: boolean;
  blacklist: string[];
}

export const DEFAULT_GATE: GateConfig = {
  maxEntries: 5000,
  maxBytesPerEntry: 8192,
  autoApprove: true,
  autoApproveConfidence: 0.9,
  allowModelGlobalWrite: false,
  blacklist: [],
};

export type WriteOutcome = 'denied' | 'committed' | 'proposed';

export interface WriteResult {
  outcome: WriteOutcome;
  reason?: string;
  reasons?: string[];
  memory?: Memory;
  approvalId?: number;
  auditId: number;
}

export interface ApproveResult {
  ok: boolean;
  reason?: string;
  memory?: Memory;
  rule?: Rule;
}

export interface MemoryService {
  readonly config: GateConfig;
  add(input: MemoryInput, caller: Caller): WriteResult;
  approve(id: number, decision: 'approve' | 'reject', edited?: MemoryInput): ApproveResult;
  recordHit(id: string, sessionId?: string): void;
  search(query: string, limit?: number): ReturnType<MemoryStore['searchMemories']>;
  listActive(scope?: 'global' | 'workspace', workspace?: string): ReturnType<MemoryStore['listSummaries']>;
}

export function createMemoryService(
  store: MemoryStore,
  detector: SensitiveDetector,
  config: GateConfig = DEFAULT_GATE,
): MemoryService {
  const now = () => new Date().toISOString();

  function audit(
    action: string,
    targetType: 'memory' | 'rule' | 'approval',
    targetId: string,
    payload: unknown,
    denied: boolean,
    byAgent: boolean,
    reason?: string,
  ): number {
    return store.insertAudit({
      ts: now(),
      action,
      targetType,
      targetId,
      payload,
      denied: denied ? 1 : 0,
      byAgent: byAgent ? 1 : 0,
      reason,
    });
  }

  function buildMemory(input: MemoryInput): Memory {
    return {
      ...input,
      id: `mm://mnemos/${randomUUID()}`,
      createdAt: now(),
      updatedAt: now(),
      crossSessionHits: 0,
      status: 'active',
    };
  }

  function programChecks(input: MemoryInput, caller: Caller): { ok: true } | { ok: false; reason: string; reasons?: string[] } {
    const bytes = Buffer.byteLength(`${input.topic}\n${input.summary}\n${input.detail ?? ''}`, 'utf8');
    if (bytes > config.maxBytesPerEntry) {
      return { ok: false, reason: 'budget' };
    }
    if (store.countActive() >= config.maxEntries) {
      return { ok: false, reason: 'budget-full' };
    }
    const reasons = detector.detect(`${input.topic} ${input.summary} ${input.detail ?? ''}`);
    if (reasons.length > 0) {
      return { ok: false, reason: 'sensitive', reasons };
    }
    if (config.blacklist.includes(input.writer)) {
      return { ok: false, reason: 'blacklisted' };
    }
    if (caller === 'model' && input.scope === 'global' && !config.allowModelGlobalWrite) {
      return { ok: false, reason: 'scope' };
    }
    if (store.exactTopicExists(input)) {
      return { ok: false, reason: 'duplicate' };
    }
    return { ok: true };
  }

  function autoApprovable(input: MemoryInput, caller: Caller): boolean {
    if (caller === 'human') {
      return true;
    }
    return (
      config.autoApprove &&
      input.type === 'project_fact' &&
      input.scope === 'workspace' &&
      input.confidence >= config.autoApproveConfidence
    );
  }

  return {
    config,

    add(input, caller) {
      const check = programChecks(input, caller);
      if (!check.ok) {
        const auditId = audit('denied', 'memory', exactDedupKey(input), input, true, caller === 'model', check.reason);
        return { outcome: 'denied', reason: check.reason, reasons: check.reasons, auditId };
      }
      const byAgent = caller === 'model';
      if (autoApprovable(input, caller)) {
        const memory = buildMemory(input);
        store.addMemory(memory);
        const auditId = audit('add', 'memory', memory.id, input, false, byAgent);
        return { outcome: 'committed', memory, auditId };
      }
      store.insertApproval({
        id: 0,
        kind: 'memory',
        payload: input,
        state: 'proposed',
        proposedBy: input.writer,
        evidence: input.evidence,
        createdAt: now(),
      });
      const approvalId = store.listApprovals('proposed').at(-1)?.id ?? 0;
      const auditId = audit('propose', 'approval', String(approvalId), input, false, byAgent);
      return { outcome: 'proposed', approvalId, auditId };
    },

    approve(id, decision, edited) {
      const candidate = store.getApproval(id);
      if (!candidate || candidate.state !== 'proposed') {
        return { ok: false, reason: 'not-pending' };
      }
      if (decision === 'reject') {
        store.updateApprovalState(id, 'rejected');
        audit('reject', 'approval', String(id), candidate.payload, false, false);
        return { ok: true };
      }
      if (candidate.kind === 'memory') {
        const input = (edited ?? candidate.payload) as MemoryInput;
        const memory = buildMemory(input);
        store.addMemory(memory);
        store.updateApprovalState(id, 'approved');
        audit('approve', 'approval', String(id), { approvalId: id, memoryId: memory.id }, false, false);
        return { ok: true, memory };
      }
      const rule = (edited ?? candidate.payload) as Rule;
      const committed: Rule = { ...rule, id: rule.id || `rule-${randomUUID()}`, state: 'approved' };
      store.insertRule(committed);
      store.updateApprovalState(id, 'approved');
      audit('approve', 'rule', committed.id, { approvalId: id, ruleId: committed.id }, false, false);
      return { ok: true, rule: committed };
    },

    recordHit(id, sessionId) {
      store.recordHit(id, sessionId);
    },

    search(query, limit = 10) {
      return store.searchMemories(query, limit);
    },

    listActive(scope, workspace) {
      return store.listSummaries(scope, workspace, 'active');
    },
  };
}
