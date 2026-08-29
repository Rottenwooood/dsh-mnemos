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
  keywords TEXT,
  cross_session_hits INTEGER NOT NULL DEFAULT 0,
  observation_count INTEGER NOT NULL DEFAULT 0,
  accessed_at TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  trust TEXT NOT NULL DEFAULT 'trusted',
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
  injected_tokens INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  task_ok INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_approval_state ON approval(state);
CREATE INDEX IF NOT EXISTS idx_usage_mem ON usage_ledger(memory_id);
CREATE TABLE IF NOT EXISTS bus_blacklist (
  name TEXT PRIMARY KEY,
  reason TEXT,
  blocked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_writer ON memories(writer, status);
`;

/** One memory's aggregated cross-session usage, derived from usage_ledger. */
export interface UsageStat {
  memoryId: string;
  /** Times the model actually referenced the injected memory (used=1). */
  hits: number;
  /** Times the memory was injected (all ledger rows for it). */
  injections: number;
  sessions: number;
  lastUsed: string | null;
}

/** Ledger-derived usage summary: the single source for cross-session stats. */
export interface UsageStats {
  /** Total real hits (model referenced injected memory). */
  totalHits: number;
  /** Total injections (all ledger rows). */
  totalInjections: number;
  distinctSessions: number;
  perMemory: UsageStat[];
}

/** Effect telemetry: does injected memory actually get used, at what cost. */
export interface TelemetryStats {
  injections: number;
  used: number;
  usedRate: number;
  avgInjectedTokens: number;
  verifiedMemories: number;
  totalActive: number;
  daily: Array<{ day: string; injections: number; used: number }>;
}

export interface SummaryRow {
  id: string;
  summary: string;
  type: string;
  scope: MemoryScope;
  workspace: string | null;
  topic: string;
  keywords: string[];
  crossSessionHits: number;
  observationCount: number;
  accessedAt: string;
  updatedAt: string;
  status: MemoryStatus;
  pinned: boolean;
  supersededById?: string;
  trust: 'trusted' | 'untrusted';
  writer: string;
}

export interface MemoryStore {
  close(): void;
  addMemory(m: Memory): void;
  getMemory(id: string): Memory | undefined;
  listSummaries(scope?: MemoryScope, workspace?: string, status?: MemoryStatus, type?: string): SummaryRow[];
  listDeleted(): SummaryRow[];
  listStale(days: number): string[];
  searchMemories(query: string, limit: number): SummaryRow[];
  updateMemory(id: string, patch: Partial<MemoryInput>): void;
  setMemoryStatus(id: string, status: MemoryStatus): void;
  setPinned(id: string, pinned: boolean): void;
  setSuperseded(id: string, supersededById: string): void;
  /** Record an INJECTION of a memory (usage_ledger row, used=0 until markLedgerUsed). */
  recordInjection(id: string, sessionId?: string, injectedTokens?: number): number;
  /** Record a TOOL HIT: the model retrieved this memory via memory_get/memory_search (used=1 row). */
  recordToolUse(id: string, sessionId?: string): number;
  markLedgerUsed(ledgerId: number): void;
  markMemoryVerified(id: string): void;
  telemetry(): TelemetryStats;
  usageStats(days?: number): UsageStats;
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
  listByWriter(writer: string): SummaryRow[];
  isBlacklisted(name: string): boolean;
  upsertBlacklist(name: string, reason?: string): void;
  removeBlacklist(name: string): void;
  listBlacklist(): Array<{ name: string; reason?: string; blockedAt: string }>;
}

function parseKeywords(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
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
    keywords: parseKeywords(row.keywords),
    evidence: JSON.parse(String(row.evidence)),
    confidence: Number(row.confidence),
    source: row.source as Memory['source'],
    writer: String(row.writer),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    crossSessionHits: Number(row.cross_session_hits),
    observationCount: Number(row.observation_count ?? 0),
    accessedAt: String(row.accessed_at || row.created_at),
    status: row.status as MemoryStatus,
    pinned: Number(row.pinned ?? 0) === 1,
    supersedesId: (row.supersedes_id as string | null) ?? undefined,
    supersededById: (row.superseded_by_id as string | null) ?? undefined,
    trust: row.trust === 'untrusted' ? 'untrusted' : 'trusted',
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
    keywords: parseKeywords(row.keywords),
    crossSessionHits: Number(row.cross_session_hits),
    observationCount: Number(row.observation_count ?? 0),
    accessedAt: String(row.accessed_at || row.created_at),
    updatedAt: String(row.updated_at),
    status: row.status as MemoryStatus,
    pinned: Number(row.pinned ?? 0) === 1,
    supersededById: (row.superseded_by_id as string | null) ?? undefined,
    trust: row.trust === 'untrusted' ? 'untrusted' : 'trusted',
    writer: String(row.writer ?? ''),
  };
}

/**
 * Escape an FTS5 query string to a phrase list. Returns null for an empty query.
 * The returned string is either AND-joined ("t1" "t2" — every token must match)
 * or OR-joined ("t1" OR "t2" — any token matches). The retrieval ladder runs
 * AND first (most precise) and degrades to OR only when AND finds nothing.
 */
function ftsQuery(query: string, join: ' AND ' | ' OR ' = ' AND '): string | null {
  const q = query.trim().replace(/"/g, ' ');
  if (!q) {
    return null;
  }
  const tokens = q.split(/\s+/).map((t) => `"${t}"`).join(join);
  return tokens;
}

export function openMemoryStore(path: string): MemoryStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Migration: older stores lack keywords/verified/ledger-token columns; add idempotently.
  const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'keywords')) {
    db.exec('ALTER TABLE memories ADD COLUMN keywords TEXT');
  }
  if (!cols.some((c) => c.name === 'verified')) {
    db.exec('ALTER TABLE memories ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'observation_count')) {
    db.exec('ALTER TABLE memories ADD COLUMN observation_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'accessed_at')) {
    db.exec("ALTER TABLE memories ADD COLUMN accessed_at TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'supersedes_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN supersedes_id TEXT');
  }
  if (!cols.some((c) => c.name === 'superseded_by_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN superseded_by_id TEXT');
  }
  if (!cols.some((c) => c.name === 'trust')) {
    db.exec("ALTER TABLE memories ADD COLUMN trust TEXT NOT NULL DEFAULT 'trusted'");
  }
  const ledgerCols = db.prepare('PRAGMA table_info(usage_ledger)').all() as Array<{ name: string }>;
  if (!ledgerCols.some((c) => c.name === 'injected_tokens')) {
    db.exec('ALTER TABLE usage_ledger ADD COLUMN injected_tokens INTEGER NOT NULL DEFAULT 0');
  }
  const userVersion = Number(db.prepare('PRAGMA user_version;').get()?.user_version ?? 0);
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(
      `dsh-mnemos schema version mismatch: store=${userVersion} code=${SCHEMA_VERSION}`,
    );
  }

  const insMemory = db.prepare(
    `INSERT INTO memories
       (id, type, scope, workspace, topic, summary, detail, evidence, confidence, source, writer, created_at, updated_at, keywords, cross_session_hits, observation_count, accessed_at, verified, pinned, supersedes_id, trust, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active')`,
  );
  const getMemoryStmt = db.prepare('SELECT * FROM memories WHERE id = ?');
  const listStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, keywords, writer, updated_at, cross_session_hits, observation_count, accessed_at, created_at, pinned, superseded_by_id, trust, status
       FROM memories
      WHERE (? IS NULL OR status IS ?) AND (? IS NULL OR scope IS ?) AND (? IS NULL OR workspace IS ?) AND (? IS NULL OR type IS ?)
      ORDER BY updated_at DESC`,
  );
  const listDeletedStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, keywords, updated_at, cross_session_hits, observation_count, accessed_at, created_at, pinned, superseded_by_id, trust, status
       FROM memories WHERE status='deleted'
      ORDER BY updated_at DESC, rowid DESC LIMIT 5`,
  );
  // Hard-delete deleted rows beyond the 5 most recent (deleted history is capped).
  const pruneDeletedStmt = db.prepare(
    `DELETE FROM memories WHERE status='deleted' AND id NOT IN (
       SELECT id FROM memories WHERE status='deleted' ORDER BY updated_at DESC, rowid DESC LIMIT 5
     )`,
  );
  const listStaleStmt = db.prepare(
    `SELECT m.id FROM memories m
      WHERE m.status='active' AND m.pinned=0 AND m.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM usage_ledger u WHERE u.memory_id = m.id AND u.ts >= ?)
      ORDER BY m.accessed_at ASC, m.created_at ASC, m.observation_count ASC`,
  );
  const searchFtsStmt = db.prepare(
    `SELECT m.id, m.summary, m.type, m.scope, m.workspace, m.topic, m.keywords, m.updated_at, m.cross_session_hits, m.accessed_at, m.created_at, m.pinned, m.trust, m.status
       FROM memory_fts f JOIN memories m ON m.rowid = f.rowid
      WHERE memory_fts MATCH ? AND m.status = 'active'
      ORDER BY rank LIMIT ?`,
  );
  const searchLikeStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, keywords, updated_at, cross_session_hits, observation_count, accessed_at, created_at, pinned, superseded_by_id, trust, status
       FROM memories WHERE status='active' AND (summary LIKE ? OR topic LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
  );
  const searchSupersededFtsStmt = db.prepare(
    `SELECT m.id, m.summary, m.type, m.scope, m.workspace, m.topic, m.keywords, m.updated_at, m.cross_session_hits, m.accessed_at, m.created_at, m.pinned, m.trust, m.status, m.superseded_by_id
       FROM memory_fts f JOIN memories m ON m.rowid = f.rowid
      WHERE memory_fts MATCH ? AND m.status = 'superseded'
      ORDER BY rank LIMIT ?`,
  );
  const searchSupersededLikeStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, keywords, updated_at, cross_session_hits, observation_count, accessed_at, created_at, pinned, superseded_by_id, trust, status
       FROM memories WHERE status='superseded' AND (summary LIKE ? OR topic LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
  );
  const updateMem = db.prepare(
    `UPDATE memories SET summary=?, detail=?, topic=?, updated_at=?, type=?, scope=?, workspace=?, confidence=?, evidence=?, keywords=?
      WHERE id=?`,
  );
  const setStatus = db.prepare('UPDATE memories SET status=?, updated_at=? WHERE id=?');
  const hitStmt = db.prepare(
    'UPDATE memories SET cross_session_hits = cross_session_hits + 1, observation_count = observation_count + 1, accessed_at=?, updated_at=? WHERE id=?',
  );
  const ledgerStmt = db.prepare(
    'INSERT INTO usage_ledger (ts, memory_id, session_id, injected, injected_tokens, used, task_ok) VALUES (?, ?, ?, 1, ?, 0, NULL) RETURNING id',
  );
  const ledgerToolHitStmt = db.prepare(
    'INSERT INTO usage_ledger (ts, memory_id, session_id, injected, injected_tokens, used, task_ok) VALUES (?, ?, ?, 0, 0, 1, NULL) RETURNING id',
  );
  const ledgerUsedStmt = db.prepare('UPDATE usage_ledger SET used=1 WHERE id=? AND used=0');
  const verifiedStmt = db.prepare('UPDATE memories SET verified=1, updated_at=? WHERE id=?');
  const teleInjectionsStmt = db.prepare('SELECT COUNT(*) AS c FROM usage_ledger WHERE injected=1');
  const teleUsedStmt = db.prepare('SELECT COUNT(*) AS c FROM usage_ledger WHERE used=1');
  const teleAvgTokensStmt = db.prepare('SELECT AVG(injected_tokens) AS avg FROM usage_ledger');
  const teleVerifiedStmt = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE verified=1 AND status='active'");
  const teleDailyStmt = db.prepare(
    `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS c, SUM(used) AS u FROM usage_ledger WHERE ts >= ? GROUP BY day ORDER BY day`,
  );
  const usageTotalInjStmt = db.prepare('SELECT COUNT(*) AS c FROM usage_ledger WHERE injected=1');
  const usageTotalHitStmt = db.prepare('SELECT COUNT(*) AS c FROM usage_ledger WHERE used=1');
  const usageSessionsStmt = db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM usage_ledger WHERE session_id IS NOT NULL');
  const usagePerMemoryStmt = db.prepare(
    `SELECT memory_id, COUNT(CASE WHEN injected=1 THEN 1 END) AS injections, SUM(used) AS hits, COUNT(DISTINCT session_id) AS sessions, MAX(ts) AS last_used
       FROM usage_ledger GROUP BY memory_id ORDER BY hits DESC`,
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

  const listByWriterStmt = db.prepare(
    `SELECT id, summary, type, scope, workspace, topic, keywords, updated_at, cross_session_hits, observation_count, accessed_at, created_at, pinned, superseded_by_id, trust, status
       FROM memories WHERE writer LIKE ? AND status='active' ORDER BY updated_at DESC`,
  );
  const blacklistGet = db.prepare('SELECT 1 FROM bus_blacklist WHERE name = ? LIMIT 1');
  const blacklistUpsert = db.prepare(
    `INSERT INTO bus_blacklist (name, reason, blocked_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET reason = COALESCE(excluded.reason, bus_blacklist.reason), blocked_at = excluded.blocked_at`,
  );
  const blacklistRemove = db.prepare('DELETE FROM bus_blacklist WHERE name = ?');
  const blacklistList = db.prepare('SELECT * FROM bus_blacklist ORDER BY blocked_at');

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
        m.keywords && m.keywords.length > 0 ? JSON.stringify(m.keywords) : null,
        m.crossSessionHits ?? 0,
        m.observationCount ?? 0,
        m.accessedAt ?? m.createdAt,
        m.pinned ? 1 : 0,
        m.supersedesId ?? null,
        m.trust ?? 'trusted',
      );
    },
    getMemory(id) {
      const row = getMemoryStmt.get(id) as Record<string, unknown> | undefined;
      return row ? toMemory(row) : undefined;
    },
    listSummaries(scope, workspace, status, type) {
      const s = status ?? 'active';
      const rows = listStmt.all(
        s,
        s,
        scope ?? null,
        scope ?? null,
        workspace ?? null,
        workspace ?? null,
        type ?? null,
        type ?? null,
      ) as Record<string, unknown>[];
      return rows.map(toSummary);
    },
    listDeleted() {
      const rows = listDeletedStmt.all() as Record<string, unknown>[];
      return rows.map(toSummary);
    },
    listStale(days) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = listStaleStmt.all(cutoff, cutoff) as Array<{ id: unknown }>;
      return rows.map((r) => String(r.id));
    },
    searchMemories(query, limit) {
      // Retrieval ladder: FTS5 AND (all tokens, precise) -> FTS5 OR (any token)
      // -> LIKE substring. AND first keeps the precise behaviour; OR only fills
      // the cases AND over-rejects (natural-language queries where the answer
      // text paraphrases the question). Falls through to LIKE when FTS yields
      // nothing (e.g. only stopwords).
      const fq = ftsQuery(query);
      const oq = ftsQuery(query, ' OR ');
      let active: Array<Record<string, unknown>> = [];
      let superseded: Array<Record<string, unknown>> = [];
      for (const q of [fq, oq]) {
        if (!q || (active.length > 0 && superseded.length > 0)) continue;
        try {
          active = searchFtsStmt.all(q, limit) as Array<Record<string, unknown>>;
          superseded = searchSupersededFtsStmt.all(q, limit) as Array<Record<string, unknown>>;
        } catch {
          // fall through to the next tier
        }
      }
      if (active.length === 0 && superseded.length === 0) {
        const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
        active = searchLikeStmt.all(like, like, limit) as Array<Record<string, unknown>>;
        superseded = searchSupersededLikeStmt.all(like, like, limit) as Array<Record<string, unknown>>;
      }
      // Active hits first; superseded (replaced) hits appended so recall ranks
      // the current value ahead of the one it replaced.
      return [...active, ...superseded].map(toSummary);
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
        patch.keywords !== undefined
          ? JSON.stringify(patch.keywords)
          : existing.keywords && existing.keywords.length > 0
            ? JSON.stringify(existing.keywords)
            : null,
        id,
      );
    },
    setMemoryStatus(id, status) {
      setStatus.run(status, now(), id);
      if (status === 'deleted') {
        pruneDeletedStmt.run();
      }
    },
    setPinned(id, pinned) {
      db.prepare('UPDATE memories SET pinned=?, updated_at=? WHERE id=?').run(pinned ? 1 : 0, now(), id);
    },
    setSuperseded(id, supersededById) {
      db.prepare(
        `UPDATE memories SET status='superseded', superseded_by_id=?, updated_at=? WHERE id=? AND status != 'deleted'`,
      ).run(supersededById, now(), id);
    },
    recordInjection(id, sessionId, injectedTokens) {
      hitStmt.run(now(), now(), id);
      const result = ledgerStmt.run(now(), id, sessionId ?? null, injectedTokens ?? 0);
      return Number(result.lastInsertRowid);
    },
    recordToolUse(id, sessionId) {
      hitStmt.run(now(), now(), id);
      verifiedStmt.run(now(), id);
      const result = ledgerToolHitStmt.run(now(), id, sessionId ?? null);
      return Number(result.lastInsertRowid);
    },
    markLedgerUsed(ledgerId) {
      if (Number.isInteger(ledgerId) && ledgerId > 0) {
        ledgerUsedStmt.run(ledgerId);
      }
    },
    markMemoryVerified(id) {
      verifiedStmt.run(now(), id);
    },
    telemetry() {
      const injections = Number(teleInjectionsStmt.get()?.c ?? 0);
      const used = Number(teleUsedStmt.get()?.c ?? 0);
      const avgTokens = Number(teleAvgTokensStmt.get()?.avg ?? 0);
      const verifiedMemories = Number(teleVerifiedStmt.get()?.c ?? 0);
      const totalActive = Number(countActiveStmt.get()?.c ?? 0);
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const counted = new Map<string, { injections: number; used: number }>();
      for (const row of teleDailyStmt.all(since) as Array<{ day: string; c: number; u: number }>) {
        counted.set(String(row.day), { injections: Number(row.c), used: Number(row.u) });
      }
      const daily: Array<{ day: string; injections: number; used: number }> = [];
      for (let i = 29; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        const v = counted.get(day) ?? { injections: 0, used: 0 };
        daily.push({ day, injections: v.injections, used: v.used });
      }
      return {
        injections,
        used,
        usedRate: injections > 0 ? used / injections : 0,
        avgInjectedTokens: Math.round(avgTokens),
        verifiedMemories,
        totalActive,
        daily,
      };
    },
    usageStats(days = 30) {
      const totalInjections = Number(usageTotalInjStmt.get()?.c ?? 0);
      const totalHits = Number(usageTotalHitStmt.get()?.c ?? 0);
      const distinctSessions = Number(usageSessionsStmt.get()?.c ?? 0);
      const perMemory = (usagePerMemoryStmt.all() as Array<Record<string, unknown>>).map((row) => ({
        memoryId: String(row.memory_id),
        hits: Number(row.hits),
        injections: Number(row.injections),
        sessions: Number(row.sessions),
        lastUsed: (row.last_used as string | null) ?? null,
      }));
      return { totalHits, totalInjections, distinctSessions, perMemory };
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
    listByWriter(writer) {
      const rows = listByWriterStmt.all(writer) as Record<string, unknown>[];
      return rows.map(toSummary);
    },    isBlacklisted(name) {
      return blacklistGet.get(name) !== undefined;
    },
    upsertBlacklist(name, reason) {
      blacklistUpsert.run(name, reason ?? null, now());
    },
    removeBlacklist(name) {
      blacklistRemove.run(name);
    },
    listBlacklist() {
      const rows = blacklistList.all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        name: String(row.name),
        reason: (row.reason as string | null) ?? undefined,
        blockedAt: String(row.blocked_at),
      }));
    },
  };
  return store;
}
