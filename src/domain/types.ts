export type MemoryType = 'project_fact' | 'procedure' | 'preference' | 'error_fix' | 'decision';
export type MemoryScope = 'global' | 'workspace';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type MemorySource = 'manual' | 'import' | 'evolve' | 'third_party';

export interface Evidence {
  sessionId: string;
  eventRange: [number, number];
  quote: string;
}

export interface MemoryInput {
  type: MemoryType;
  scope: MemoryScope;
  workspace?: string;
  topic: string;
  summary: string;
  detail?: string;
  /** Short discriminative terms the user would type later; drive keyword-triggered injection. */
  keywords?: string[];
  evidence: Evidence[];
  confidence: number;
  source: MemorySource;
  writer: string;
}

export interface Memory extends MemoryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  crossSessionHits: number;
  status: MemoryStatus;
}

export type RuleKind = 'system_prompt' | 'skill' | 'tool_filter' | 'preference';
export type RuleState =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'promoted'
  | 'deprecated'
  | 'rolled_back';

export interface Rule {
  id: string;
  kind: RuleKind;
  text: string;
  evidence: Evidence[];
  state: RuleState;
  proposedBy: string;
  approvedBy?: string;
  approvedAt?: string;
  version: number;
  blacklistReason?: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  action: string;
  targetType: 'memory' | 'rule' | 'approval';
  targetId: string;
  payload: unknown;
  denied: number;
  byAgent: number;
  reason?: string;
}

export type Caller = 'human' | 'model' | 'plugin';

export interface ApprovalCandidate {
  id: number;
  kind: 'memory' | 'rule';
  payload: unknown;
  state: 'proposed' | 'approved' | 'rejected' | 'edited';
  proposedBy: string;
  evidence: Evidence[];
  createdAt: string;
}
