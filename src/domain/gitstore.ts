/**
 * Git versioning + cross-machine sync (M4).
 *
 * The GitStore versions the Markdown mirror with git: every recordCommit syncs
 * the mirror (one file per memory) and commits with an audit-linked message,
 * giving per-entry history, diffs, rollback and deleted-memory recovery. Sync
 * is per-entry: independent entries merge cleanly; a changed entry on both
 * sides surfaces as a conflict (flagged, never silently overwritten).
 *
 * The SQLite store stays the source of truth for queries; the mirror+git is the
 * durable readable log and the sync transport. Pull reconciles the store from
 * the merged mirror; on conflict it applies nothing and reports the files.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitBackend, CommitInfo } from './git/backend.js';
import { MemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { syncMirror, applyMirrorToStore, mirrorFileFor, memoryFileName, parseMemoryFile } from './mirror.js';

export interface GitStoreOptions {
  backend: GitBackend;
  store: MemoryStore;
  service: MemoryService;
  repoDir: string;
  remote?: string;
}

export interface GitStore {
  ensure(): Promise<void>;
  /** Sync the mirror and commit; message should reference the audit entry. */
  recordCommit(message: string): Promise<string | undefined>;
  history(memoryId?: string): Promise<CommitInfo[]>;
  showAt(sha: string, memoryId: string): Promise<string | undefined>;
  rollback(memoryId: string, sha: string): Promise<{ ok: boolean; reason?: string }>;
  restoreDeleted(memoryId: string): Promise<{ ok: boolean; reason?: string }>;
  pull(): Promise<{ ok: boolean; conflicts: string[]; applied?: number }>;
  push(): Promise<{ ok: boolean; reason?: string }>;
  setRemote(url: string): Promise<void>;
  exportBundle(outPath: string): Promise<void>;
  status(): Promise<{ changed: string[] }>;
}

export function createGitStore(opts: GitStoreOptions): GitStore {
  const { backend, store, service, repoDir } = opts;
  const remote = opts.remote ?? 'origin';

  async function fileFor(memoryId: string): Promise<string | undefined> {
    const found = mirrorFileFor(repoDir, memoryId);
    if (found) {
      return found;
    }
    // Deleted memories no longer have a mirror file on disk, but their history
    // stays in git. The mirror file name is deterministic from id+topic, so
    // derive it from the store row to keep log/show/rollback working.
    const memory = store.getMemory(memoryId);
    return memory ? memoryFileName(memory) : undefined;
  }

  return {
    async ensure() {
      await backend.ensureRepo(repoDir);
      let history: CommitInfo[] = [];
      try {
        history = await backend.log(repoDir);
      } catch {
        // A fresh repo has no refs; some backends (isomorphic-git) throw on
        // log, which is exactly the no-commits case.
      }
      if (history.length > 0) {
        return;
      }
      // A fresh mirror repo has no commits, so exportBundle/history have no ref
      // to read. Seed a marker file (not `.md`, so syncMirror never removes it)
      // and commit it, giving the initial snapshot real content.
      const marker = join(repoDir, '.gitkeep');
      if (!existsSync(marker)) {
        writeFileSync(marker, 'dsh-mnemos memory mirror\n', 'utf8');
      }
      await backend.commit(repoDir, 'mnemos: initialize mirror');
    },

    async recordCommit(message) {
      syncMirror(store, repoDir);
      return backend.commit(repoDir, message);
    },

    async history(memoryId) {
      if (!memoryId) {
        return backend.log(repoDir);
      }
      const file = await fileFor(memoryId);
      return file ? backend.log(repoDir, file) : [];
    },

    async showAt(sha, memoryId) {
      const file = await fileFor(memoryId);
      return file ? backend.show(repoDir, sha, file) : undefined;
    },

    async rollback(memoryId, sha) {
      const file = await fileFor(memoryId);
      if (!file) {
        return { ok: false, reason: 'not-found' };
      }
      const text = await backend.show(repoDir, sha, file);
      if (text === undefined) {
        return { ok: false, reason: 'missing-at-sha' };
      }
      const parsed = parseMemoryFile(text);
      if (!parsed?.id) {
        return { ok: false, reason: 'parse-error' };
      }
      const existing = store.getMemory(parsed.id);
      if (!existing) {
        return { ok: false, reason: 'not-in-store' };
      }
      await backend.restoreFile(repoDir, sha, file);
      store.updateMemory(parsed.id, {
        type: parsed.type ?? existing.type,
        scope: parsed.scope ?? existing.scope,
        workspace: parsed.workspace ?? existing.workspace,
        topic: parsed.topic ?? existing.topic,
        summary: parsed.summary || existing.summary,
        detail: parsed.detail ?? existing.detail,
        keywords: parsed.keywords,
        confidence: parsed.confidence ?? existing.confidence,
      });
      store.insertAudit({
        ts: new Date().toISOString(),
        action: 'rollback',
        targetType: 'memory',
        targetId: parsed.id,
        payload: { sha, file },
        denied: 0,
        byAgent: 0,
        reason: 'git-rollback',
      });
      await backend.commit(repoDir, `rollback ${memoryId} to ${sha.slice(0, 8)}`);
      return { ok: true };
    },

    async restoreDeleted(memoryId) {
      const memory = store.getMemory(memoryId);
      if (!memory) {
        return { ok: false, reason: 'not-found' };
      }
      if (memory.status !== 'deleted') {
        return { ok: false, reason: 'not-deleted' };
      }
      store.setMemoryStatus(memoryId, 'active');
      store.insertAudit({
        ts: new Date().toISOString(),
        action: 'restore',
        targetType: 'memory',
        targetId: memoryId,
        payload: {},
        denied: 0,
        byAgent: 0,
        reason: 'git-restore',
      });
      syncMirror(store, repoDir);
      await backend.commit(repoDir, `restore deleted memory ${memoryId}`);
      return { ok: true };
    },

    async pull() {
      await backend.fetch(repoDir, remote);
      const branch = await backend.currentBranch(repoDir);
      const result = await backend.merge(repoDir, `${remote}/${branch}`);
      if (!result.ok) {
        return { ok: false, conflicts: result.conflicts };
      }
      const { applied } = applyMirrorToStore(store, repoDir);
      store.insertAudit({
        ts: new Date().toISOString(),
        action: 'sync-pull',
        targetType: 'memory',
        targetId: 'mirror',
        payload: { applied },
        denied: 0,
        byAgent: 0,
      });
      return { ok: true, conflicts: [], applied };
    },

    async push() {
      const branch = await backend.currentBranch(repoDir);
      try {
        await backend.push(repoDir, remote, branch);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async setRemote(url) {
      await backend.addRemote(repoDir, remote, url);
    },

    async exportBundle(outPath) {
      mkdirSync(repoDir, { recursive: true });
      await backend.exportBundle(repoDir, outPath);
    },

    async status() {
      return backend.status(repoDir);
    },
  };
}
