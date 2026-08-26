/**
 * SQLite storage for dsh-mnemos using node:sqlite (zero native deps).
 * Tables: memories, rules, audit, approval, usage_ledger + an FTS5 external-content index.
 */
import { DatabaseSync } from 'node:sqlite';
import { normalizeTopic } from './dedup.js';
import {
  Memory,
  MemoryInput,
  MemoryScope,
  MemoryStatus,
  Rule,
  RuleState,
  AuditEntry,
  ApprovalCandidate,
} from './types.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS memories (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  workspace TEXT,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  writer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cross_session_hits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, workspace);
CREATE INDEX IF NOT EXISTS idx_mem_topic ON memories(scope, workspace, type, topic);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(summary, content='memories', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
  INSERT INTO memory_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL,
  state TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  blacklist_reason TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  denied INTEGER NOT NULL DEFAULT 0,
  by_agent INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS approval (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('memory','rule')),
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','edited')),
  proposed_by TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  session_id TEXT,
  injected INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  task_ok INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_approval_state ON approval(state);
CREATE INDEX IF NOT EXISTS idx_usage_mem ON usage_ledger(memory_id);
`;

export interface SummaryRow {
  id: string;
  summary: string;
  type: string;
  scope: MemoryScope;
  workspace: string | null;
  topic: string;
  crossSessionHits: number;
  updatedAt: string;
  status: MemoryStatus;
}

export interface MemoryStore {
  close(): void;
  addMemory(m: Memory): void;
  getMemory(id: string): Memory | undefined;
  listSummaries(scope?: MemoryScope, workspace?: string, status?: MemoryStatus): SummaryRow[];
  searchMemories(query: string, limit: number): SummaryRow[];
  updateMemory(id: string, patch: Partial<MemoryInput>): void;
  setMemoryStatus(id: string, status: MemoryStatus): void;
  recordHit(id: string, sessionId?: string): void;
  exactTopicExists(m: MemoryInput): boolean;
  countActive(): number;
  insertRule(r: Rule): void;
  listRules(state?: RuleState): Rule[];
  updateRuleState(id: string, state: RuleState, patch?: Partial<Rule>): void;
  insertApproval(c: ApprovalCandidate): void;
  listApprovals(state?: ApprovalCandidate['state']): ApprovalCandidate[];
  getApproval(id: number): ApprovalCandidate | undefined;
  updateApprovalState(id: number, state: ApprovalCandidate['state'], editedPayload?: unknown): void;
  insertAudit(e: Omit<AuditEntry, 'id'>): number;
  listAudit(limit: number): AuditEntry[];
}

function toMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    type: row.type as Memory['type'],
    scope: row.scope as MemoryScope,
    workspace: (row.workspace as string | null) ?? undefined,
    topic: String(row.topic),
    summary: String(row.summary),
    detail: (row.detail as string | null) ?? undefined,
    evidence: JSON.parse(String(row.evidence)),
    confidence: Number(row.confidence),
    source: row.source as Memory['source'],
    writer: String(row.writer),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    crossSessionHits: Number(row.cross_session_hits),
    status: row.status as MemoryStatus,
  };
}

function toSummary(row: Record<string, unknown>): SummaryRow {
  return {
    id: String(row.id),
    summary: String(row.summary),
    type: String(row.type),
    scope: row.scope as MemoryScope,
    workspace: (row.workspace as string | null) ?? null,
    topic: String(row.topic),
    crossSessionHits: Number(row.cross_session_hits),
    updatedAt: String(row.updated_at),
    status: row.status as MemoryStatus,
  };
}

/** Escape an FTS5 query string; falls back to a plain LIKE search on failure. */
function ftsQuery(query: string): string | null {
  const q = query.trim().replace(/"/g, ' ');
  if (!q) {
    return null;
  }
  const tokens = q.split(/\s+/).map((t) => `"${t}"`).join(' ');
  return tokens;
}

export function openMemoryStore(path: string): MemoryStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const userVersion = Number(db.prepare('PRAGMA user_version;').get()?.user_version ?? 0);
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(
      `dsh-mnemos schema version mismatch: store=${userVersion} code=${SCHEMA_VERSION}`,
    );
  }

  const insMemory = db.prepare(
    `INSERT INTO memories
       (id, type, scope, workspace, topic, summary, detail, evidence, confidence, source, writer, created_at, updated_at, cross_session_hits, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
  );
  const getMemoryStmt = db.prepare('SELECT * FROM memories WHERE id = ?');
  const listStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, updated_at, cross_session_hits, status
       FROM memories
      WHERE (? IS NULL OR status IS ?) AND (? IS NULL OR scope IS ?) AND (? IS NULL OR workspace IS ?)
      ORDER BY updated_at DESC`,
  );
  const searchFtsStmt = db.prepare(
    `SELECT m.id, m.summary, m.type, m.scope, m.workspace, m.topic, m.updated_at, m.cross_session_hits, m.status
       FROM memory_fts f JOIN memories m ON m.rowid = f.rowid
      WHERE memory_fts MATCH ? AND m.status = 'active'
      ORDER BY rank LIMIT ?`,
  );
  const searchLikeStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, updated_at, cross_session_hits, status
       FROM memories WHERE status='active' AND (summary LIKE ? OR topic LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
  );
  const updateMem = db.prepare(
    `UPDATE memories SET summary=?, detail=?, topic=?, updated_at=?, type=?, scope=?, workspace=?, confidence=?, evidence=?
      WHERE id=?`,
  );
  const setStatus = db.prepare('UPDATE memories SET status=?, updated_at=? WHERE id=?');
  const hitStmt = db.prepare(
    'UPDATE memories SET cross_session_hits = cross_session_hits + 1, updated_at=? WHERE id=?',
  );
  const ledgerStmt = db.prepare(
    'INSERT INTO usage_ledger (ts, memory_id, session_id, injected, used, task_ok) VALUES (?, ?, ?, 0, 0, NULL)',
  );
  const listTopicsStmt = db.prepare(
    `SELECT topic FROM memories WHERE status='active' AND scope=? AND workspace=? AND type=?`,
  );
  const countActiveStmt = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE status='active'`);

  const insRule = db.prepare(
    `INSERT INTO rules (id, kind, text, evidence, state, proposed_by, approved_by, approved_at, version, blacklist_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listRulesStmt = db.prepare('SELECT * FROM rules WHERE state = COALESCE(?, state) ORDER BY id');
  const updRule = db.prepare('UPDATE rules SET state=?, approved_by=COALESCE(?, approved_by), approved_at=COALESCE(?, approved_at) WHERE id=?');

  const insAudit = db.prepare(
    `INSERT INTO audit (ts, action, target_type, target_id, payload, denied, by_agent, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listAuditStmt = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?');

  const insApproval = db.prepare(
    `INSERT INTO approval (kind, payload, state, proposed_by, evidence, created_at) VALUES (?, ?, 'proposed', ?, ?, ?)`,
  );
  const listApprovalsStmt = db.prepare('SELECT * FROM approval WHERE state = COALESCE(?, state) ORDER BY id');
  const getApprovalStmt = db.prepare('SELECT * FROM approval WHERE id = ?');
  const updApproval = db.prepare('UPDATE approval SET state=?, payload=COALESCE(?, payload) WHERE id=?');

  const now = () => new Date().toISOString();

  const store: MemoryStore = {
    close() {
      db.close();
    },
    addMemory(m: Memory) {
      insMemory.run(
        m.id,
        m.type,
        m.scope,
        m.workspace ?? null,
        m.topic,
        m.summary,
        m.detail ?? null,
        JSON.stringify(m.evidence),
        m.confidence,
        m.source,
        m.writer,
        m.createdAt,
        m.updatedAt,
      );
    },
    getMemory(id) {
      const row = getMemoryStmt.get(id) as Record<string, unknown> | undefined;
      return row ? toMemory(row) : undefined;
    },
    listSummaries(scope, workspace, status) {
      const s = status ?? 'active';
      const rows = listStmt.all(
        s,
        s,
        scope ?? null,
        scope ?? null,
        workspace ?? null,
        workspace ?? null,
      ) as Record<string, unknown>[];
      return rows.map(toSummary);
    },
    searchMemories(query, limit) {
      const fq = ftsQuery(query);
      if (fq) {
        try {
          const rows = searchFtsStmt.all(fq, limit) as Record<string, unknown>[];
          if (rows.length > 0) {
            return rows.map(toSummary);
          }
        } catch {
          // fall through to LIKE
        }
      }
      const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const rows = searchLikeStmt.all(like, like, limit) as Record<string, unknown>[];
      return rows.map(toSummary);
    },
    updateMemory(id, patch) {
      const existing = store.getMemory(id);
      if (!existing) {
        return;
      }
      updateMem.run(
        patch.summary ?? existing.summary,
        patch.detail ?? existing.detail ?? null,
        patch.topic ?? existing.topic,
        now(),
        patch.type ?? existing.type,
        patch.scope ?? existing.scope,
        patch.workspace ?? existing.workspace ?? null,
        patch.confidence ?? existing.confidence,
        JSON.stringify(patch.evidence ?? existing.evidence),
        id,
      );
    },
    setMemoryStatus(id, status) {
      setStatus.run(status, now(), id);
    },
    recordHit(id, sessionId) {
      hitStmt.run(now(), id);
      ledgerStmt.run(now(), id, sessionId ?? null);
    },
    exactTopicExists(m) {
      const rows = listTopicsStmt.all(m.scope, m.workspace ?? null, m.type) as Array<{
        topic: unknown;
      }>;
      const key = normalizeTopic(m.topic);
      return rows.some((r) => normalizeTopic(String(r.topic)) === key);
    },
    countActive() {
      return Number(countActiveStmt.get()?.c ?? 0);
    },
    insertRule(r) {
      insRule.run(
        r.id,
        r.kind,
        r.text,
        JSON.stringify(r.evidence),
        r.state,
        r.proposedBy,
        r.approvedBy ?? null,
        r.approvedAt ?? null,
        r.version,
        r.blacklistReason ?? null,
      );
    },
    listRules(state) {
      const rows = listRulesStmt.all(state ?? null) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        kind: row.kind as Rule['kind'],
        text: String(row.text),
        evidence: JSON.parse(String(row.evidence)),
        state: row.state as RuleState,
        proposedBy: String(row.proposed_by),
        approvedBy: (row.approved_by as string | null) ?? undefined,
        approvedAt: (row.approved_at as string | null) ?? undefined,
        version: Number(row.version),
        blacklistReason: (row.blacklist_reason as string | null) ?? undefined,
      }));
    },
    updateRuleState(id, state, patch) {
      updRule.run(state, patch?.approvedBy ?? null, patch?.approvedAt ?? null, id);
    },
    insertApproval(c) {
      insApproval.run(c.kind, JSON.stringify(c.payload), c.proposedBy, JSON.stringify(c.evidence), c.createdAt);
    },
    listApprovals(state) {
      const rows = listApprovalsStmt.all(state ?? null) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: Number(row.id),
        kind: row.kind as ApprovalCandidate['kind'],
        payload: JSON.parse(String(row.payload)),
        state: row.state as ApprovalCandidate['state'],
        proposedBy: String(row.proposed_by),
        evidence: JSON.parse(String(row.evidence)),
        createdAt: String(row.created_at),
      }));
    },
    getApproval(id) {
      const row = getApprovalStmt.get(id) as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      return {
        id: Number(row.id),
        kind: row.kind as ApprovalCandidate['kind'],
        payload: JSON.parse(String(row.payload)),
        state: row.state as ApprovalCandidate['state'],
        proposedBy: String(row.proposed_by),
        evidence: JSON.parse(String(row.evidence)),
        createdAt: String(row.created_at),
      };
    },
    updateApprovalState(id, state, editedPayload) {
      updApproval.run(state, editedPayload !== undefined ? JSON.stringify(editedPayload) : null, id);
    },
    insertAudit(e) {
      const result = insAudit.run(
        e.ts,
        e.action,
        e.targetType,
        e.targetId,
        JSON.stringify(e.payload),
        e.denied,
        e.byAgent,
        e.reason ?? null,
      );
      return Number(result.lastInsertRowid);
    },
    listAudit(limit) {
      const rows = listAuditStmt.all(limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: Number(row.id),
        ts: String(row.ts),
        action: String(row.action),
        targetType: row.target_type as AuditEntry['targetType'],
        targetId: String(row.target_id),
        payload: JSON.parse(String(row.payload)),
        denied: Number(row.denied),
        byAgent: Number(row.by_agent),
        reason: (row.reason as string | null) ?? undefined,
      }));
    },
  };
  return store;
}
