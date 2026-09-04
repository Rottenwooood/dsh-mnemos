export type MemoryType = 'project_fact' | 'procedure' | 'preference' | 'error_fix' | 'decision' | 'protocol';
export type MemoryScope = 'global' | 'workspace';
export type MemoryStatus = 'active' | 'archived' | 'deleted' | 'superseded';
export type MemorySource = 'manual' | 'import' | 'evolve' | 'third_party';
/** Provenance trust for poisoning defense (P3): untrusted = model/import/3rd-party content, human-approved = trusted. */
export type MemoryTrust = 'trusted' | 'untrusted';

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
  /** How many times this memory has been observed/reinforced. */
  observationCount?: number;
  /** Last time the memory was actually used (accessed), distinct from updatedAt. */
  accessedAt?: string;
  /** Protected from cleanup/archive candidates. */
  pinned?: boolean;
  /** The memory this one replaces (supersession chain, MELD/StateMemBench). */
  supersedesId?: string;
  /** Set on the old memory when a replacement is approved. */
  supersededById?: string;
  /** Provenance trust; recall applies bounded occupancy to untrusted entries. */
  trust?: MemoryTrust;
  status: MemoryStatus;
}

export interface AuditEntry {
  id: number;
  ts: string;
  action: string;
  targetType: 'memory' | 'approval';
  targetId: string;
  payload: unknown;
  denied: number;
  byAgent: number;
  reason?: string;
}

export type Caller = 'human' | 'model' | 'plugin';

export interface ApprovalCandidate {
  id: number;
  kind: 'memory';
  payload: unknown;
  state: 'proposed' | 'approved' | 'rejected' | 'edited';
  proposedBy: string;
  evidence: Evidence[];
  createdAt: string;
}
