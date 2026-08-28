/**
 * Negative memory (P2): records disproven paths — a command/path that failed —
 * with evidence, and self-invalidates on TTL expiry or a later success. Unlike
 * positive memories it is NOT injected; it is intercepted at tool-execution
 * time (dsh-negative-ledger / deja-vu style): a repeated attempt with unchanged
 * preconditions is denied up front with the stored evidence.
 */
import { DatabaseSync } from 'node:sqlite';

export interface NegativeRecord {
  fingerprint: string;
  kind: string;
  claim: string;
  evidence: string;
  sessionId?: string;
  ttlMs: number;
  status: 'active' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

export interface NegativeMemoryStore {
  record(r: NegativeRecord): void;
  findActive(fingerprint: string): NegativeRecord | undefined;
  resolve(fingerprint: string): void;
  expire(now: number): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS negative_memory (
  fingerprint TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence TEXT NOT NULL,
  session_id TEXT,
  ttl_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Fingerprint: tool + cwd + normalized command. cwd change = precondition change = no match. */
export function negativeFingerprint(tool: string, cwd: string | undefined, command: string): string {
  return `cmd:${tool}:${cwd ?? ''}:${command.trim().replace(/\s+/g, ' ')}`;
}

export function openNegativeMemoryStore(path: string): NegativeMemoryStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO negative_memory (fingerprint, kind, claim, evidence, session_id, ttl_ms, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET evidence=excluded.evidence, status='active', updated_at=excluded.updated_at`,
  );
  const find = db.prepare(`SELECT * FROM negative_memory WHERE fingerprint=? AND status='active'`);
  const resolveStmt = db.prepare(`UPDATE negative_memory SET status='resolved', updated_at=? WHERE fingerprint=?`);
  const allActiveStmt = db.prepare(`SELECT * FROM negative_memory WHERE status='active'`);

  const toRecord = (row: Record<string, unknown>): NegativeRecord => ({
    fingerprint: String(row.fingerprint),
    kind: String(row.kind),
    claim: String(row.claim),
    evidence: String(row.evidence),
    sessionId: (row.session_id as string | null) ?? undefined,
    ttlMs: Number(row.ttl_ms),
    status: row.status as NegativeRecord['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  return {
    record(r) {
      const now = new Date().toISOString();
      ins.run(r.fingerprint, r.kind, r.claim, r.evidence, r.sessionId ?? null, r.ttlMs, r.createdAt, now);
    },
    findActive(fingerprint) {
      const row = find.get(fingerprint) as Record<string, unknown> | undefined;
      return row ? toRecord(row) : undefined;
    },
    resolve(fingerprint) {
      resolveStmt.run(new Date().toISOString(), fingerprint);
    },
    expire(now) {
      const stamp = new Date(now).toISOString();
      for (const row of allActiveStmt.all() as Array<Record<string, unknown>>) {
        const rec = toRecord(row);
        if (Date.parse(rec.createdAt) + rec.ttlMs < now) {
          resolveStmt.run(stamp, rec.fingerprint);
        }
      }
    },
    close() {
      db.close();
    },
  };
}
