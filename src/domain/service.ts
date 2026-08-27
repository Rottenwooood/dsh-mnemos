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
import { Memory, MemoryInput, Caller, Rule, RuleState } from './types.js';
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

export interface RuleWriteResult {
  outcome: 'proposed' | 'denied';
  approvalId?: number;
  reason?: string;
  auditId: number;
}

/** Approval payload for a memory replacement: a conflicting claim on an
 *  existing topic that must be adjudicated by a human. */
export interface ReplacementPayload {
  __replace: true;
  memory: MemoryInput;
  replaceMemoryId: string;
}

export function isReplacementPayload(v: unknown): v is ReplacementPayload {
  return !!v && typeof v === 'object' && (v as { __replace?: unknown }).__replace === true;
}

export interface RuleStateResult {
  ok: boolean;
  reason?: string;
  rule?: Rule;
}

export interface MemoryService {
  readonly config: GateConfig;
  add(input: MemoryInput, caller: Caller, forcePropose?: boolean): WriteResult;
  approve(id: number, decision: 'approve' | 'reject', edited?: MemoryInput): ApproveResult;
  proposeRule(rule: Rule, caller: Caller): RuleWriteResult;
  proposeReplacement(input: MemoryInput, replaceMemoryId: string, caller: Caller): RuleWriteResult;
  listRules(state?: RuleState): Rule[];
  getRule(id: string): Rule | undefined;
  setRuleState(id: string, state: RuleState): RuleStateResult;
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

  function programChecks(
    input: MemoryInput,
    caller: Caller,
    opts: { skipDedup?: boolean } = {},
  ): { ok: true } | { ok: false; reason: string; reasons?: string[] } {
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
    if (!opts.skipDedup && store.exactTopicExists(input)) {
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

  const RULE_TRANSITIONS: Record<RuleState, RuleState[]> = {
    proposed: ['approved', 'rejected'],
    approved: ['deprecated', 'rolled_back', 'promoted'],
    rejected: [],
    edited: ['approved', 'rejected'],
    promoted: ['deprecated', 'rolled_back'],
    deprecated: ['rolled_back'],
    rolled_back: ['approved'],
  };

  function ruleProgramChecks(rule: Rule, caller: Caller): { ok: true } | { ok: false; reason: string } {
    const reasons = detector.detect(`${rule.text} ${rule.kind}`);
    if (reasons.length > 0) {
      return { ok: false, reason: 'sensitive' };
    }
    if (config.blacklist.includes(rule.proposedBy)) {
      return { ok: false, reason: 'blacklisted' };
    }
    const dup = store.listRules('proposed').find((r) => r.kind === rule.kind && r.text === rule.text);
    if (dup) {
      return { ok: false, reason: 'duplicate' };
    }
    return { ok: true };
  }

  return {
    config,

    add(input, caller, forcePropose = false) {
      const check = programChecks(input, caller);
      if (!check.ok) {
        const auditId = audit('denied', 'memory', exactDedupKey(input), input, true, caller === 'model', check.reason);
        return { outcome: 'denied', reason: check.reason, reasons: check.reasons, auditId };
      }
      const byAgent = caller === 'model';
      if (autoApprovable(input, caller) && !forcePropose) {
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
        if (candidate.kind === 'rule') {
          const r = candidate.payload as Rule;
          store.updateRuleState(r.id, 'rejected');
        }
        audit('reject', 'approval', String(id), candidate.payload, false, false);
        return { ok: true };
      }
      if (candidate.kind === 'memory') {
        const raw = (edited ?? candidate.payload) as unknown;
        if (isReplacementPayload(raw)) {
          const existing = store.getMemory(raw.replaceMemoryId);
          if (!existing) {
            return { ok: false, reason: 'target-not-found' };
          }
          store.updateMemory(raw.replaceMemoryId, raw.memory);
          store.updateApprovalState(id, 'approved');
          audit('replace', 'memory', raw.replaceMemoryId, { approvalId: id, from: existing, to: raw.memory }, false, false);
          return { ok: true, memory: store.getMemory(raw.replaceMemoryId) };
        }
        const input = raw as MemoryInput;
        const memory = buildMemory(input);
        store.addMemory(memory);
        store.updateApprovalState(id, 'approved');
        audit('approve', 'approval', String(id), { approvalId: id, memoryId: memory.id }, false, false);
        return { ok: true, memory };
      }
      const rule = (edited ?? candidate.payload) as Rule;
      const existing = store.listRules().find((r) => r.id === rule.id);
      const committed: Rule = existing
        ? { ...existing, state: 'approved' as const }
        : { ...rule, id: rule.id || `rule-${randomUUID()}`, state: 'approved' as const };
      store.updateRuleState(committed.id, 'approved', {
        approvedBy: 'human',
        approvedAt: now(),
      });
      store.updateApprovalState(id, 'approved');
      audit('approve', 'rule', committed.id, { approvalId: id, ruleId: committed.id }, false, false);
      return { ok: true, rule: store.listRules().find((r) => r.id === committed.id) };
    },

    proposeRule(rule, caller) {
      const check = ruleProgramChecks(rule, caller);
      if (!check.ok) {
        const auditId = audit('denied', 'rule', rule.id, rule, true, caller === 'model', check.reason);
        return { outcome: 'denied', reason: check.reason, auditId };
      }
      store.insertRule({ ...rule, state: 'proposed' });
      store.insertApproval({
        id: 0,
        kind: 'rule',
        payload: rule,
        state: 'proposed',
        proposedBy: rule.proposedBy,
        evidence: rule.evidence,
        createdAt: now(),
      });
      const approvalId = store.listApprovals('proposed').at(-1)?.id ?? 0;
      const auditId = audit('propose', 'approval', String(approvalId), rule, false, caller === 'model');
      return { outcome: 'proposed', approvalId, auditId };
    },

    proposeReplacement(input, replaceMemoryId, caller) {
      const check = programChecks(input, caller, { skipDedup: true });
      if (!check.ok) {
        const auditId = audit('denied', 'memory', exactDedupKey(input), { __replace: true, input, replaceMemoryId }, true, caller === 'model', check.reason);
        return { outcome: 'denied', reason: check.reason, auditId };
      }
      store.insertApproval({
        id: 0,
        kind: 'memory',
        payload: { __replace: true, memory: input, replaceMemoryId },
        state: 'proposed',
        proposedBy: input.writer,
        evidence: input.evidence,
        createdAt: now(),
      });
      const approvalId = store.listApprovals('proposed').at(-1)?.id ?? 0;
      const auditId = audit('propose', 'approval', String(approvalId), { __replace: true, memory: input, replaceMemoryId }, false, caller === 'model');
      return { outcome: 'proposed', approvalId, auditId };
    },

    listRules(state) {
      return store.listRules(state);
    },

    getRule(id) {
      return store.listRules().find((r) => r.id === id);
    },

    setRuleState(id, state) {
      const rule = store.listRules().find((r) => r.id === id);
      if (!rule) {
        return { ok: false, reason: 'not-found' };
      }
      const allowed = RULE_TRANSITIONS[rule.state] ?? [];
      if (!allowed.includes(state)) {
        return { ok: false, reason: `invalid transition ${rule.state} -> ${state}` };
      }
      store.updateRuleState(id, state, {
        approvedBy: state === 'approved' ? 'human' : undefined,
        approvedAt: state === 'approved' ? now() : undefined,
      });
      audit('rule-state', 'rule', id, { from: rule.state, to: state }, false, false);
      return { ok: true, rule: store.listRules().find((r) => r.id === id) };
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
