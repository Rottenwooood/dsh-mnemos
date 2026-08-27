import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { createGitStore } from '../domain/gitstore.js';
import { createSystemGitBackend } from '../domain/git/system-git.js';
import { createIsomorphicGitBackend } from '../domain/git/isomorphic-git.js';
import { GitBackend } from '../domain/git/backend.js';

function makeStore() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

function makeGitStore(repoDir: string, backend: () => GitBackend) {
  const { store, service } = makeStore();
  const git = createGitStore({ backend: backend(), store, service, repoDir });
  return { store, service, git };
}

async function addMemory(store: ReturnType<typeof openMemoryStore>, id: string, summary: string) {
  store.addMemory({
    id,
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'ws',
    topic: id.slice(-4),
    summary,
    evidence: [],
    confidence: 1,
    source: 'manual',
    writer: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    crossSessionHits: 0,
    status: 'active',
  });
}

function runVersioningSuite(backendName: string, backend: () => GitBackend) {
  describe(`git versioning (${backendName})`, () => {
    it('records commits and per-file history, and rolls back', async () => {
      const dir = mkdtempSync(join(tmpdir(), `mnemos-git-${backendName}-`));
      const { store, git } = makeGitStore(dir, backend);
      await git.ensure();
      await addMemory(store, 'mm://mnemos/aaaa', 'v1');
      const sha1 = (await git.recordCommit('add v1'))!;
      expect(sha1).toBeTruthy();
      await addMemory(store, 'mm://mnemos/bbbb', 'v2');
      await git.recordCommit('add v2');

      const all = await git.history();
      expect(all.length).toBe(3);
      expect(await git.history('mm://mnemos/aaaa')).toHaveLength(1);

      store.updateMemory('mm://mnemos/aaaa', { summary: 'v3' });
      await git.recordCommit('update to v3');
      const rollback = await git.rollback('mm://mnemos/aaaa', sha1);
      expect(rollback.ok).toBe(true);
      expect(store.getMemory('mm://mnemos/aaaa')?.summary).toBe('v1');
      rmSync(dir, { recursive: true, force: true });
    });

    it('restores a deleted memory', async () => {
      const dir = mkdtempSync(join(tmpdir(), `mnemos-git-restore-${backendName}-`));
      const { store, git } = makeGitStore(dir, backend);
      await git.ensure();
      await addMemory(store, 'mm://mnemos/cccc', 'keep me');
      await git.recordCommit('add cccc');
      store.setMemoryStatus('mm://mnemos/cccc', 'deleted');
      await git.recordCommit('delete cccc');
      const restored = await git.restoreDeleted('mm://mnemos/cccc');
      expect(restored.ok).toBe(true);
      expect(store.getMemory('mm://mnemos/cccc')?.status).toBe('active');
      rmSync(dir, { recursive: true, force: true });
    });

    it('exports a git bundle backup', async () => {
      const dir = mkdtempSync(join(tmpdir(), `mnemos-git-bundle-${backendName}-`));
      const { store, git } = makeGitStore(dir, backend);
      await git.ensure();
      await addMemory(store, 'mm://mnemos/dddd', 'bundle me');
      await git.recordCommit('add dddd');
      const out = join(tmpdir(), `mnemos-backup-${backendName}.bundle`);
      await git.exportBundle(out);
      expect(existsSync(out)).toBe(true);
      expect(() => execFileSync('git', ['bundle', 'verify', out], { encoding: 'utf8' })).not.toThrow();
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { force: true });
    });

    it('ensure seeds an initial commit so backup works on a fresh repo', async () => {
      const dir = mkdtempSync(join(tmpdir(), `mnemos-git-init-${backendName}-`));
      const { git } = makeGitStore(dir, backend);
      await git.ensure();
      const all = await git.history();
      expect(all.length).toBeGreaterThanOrEqual(1);
      const out = join(tmpdir(), `mnemos-init-${backendName}.bundle`);
      await git.exportBundle(out);
      expect(existsSync(out)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { force: true });
    });
  });
}

/**
 * Cross-machine sync is exercised against system git with local bare remotes.
 * isomorphic-git v1 dropped local-path remotes (http/https/ssh only), so the
 * isomorphic backend's push/fetch/pull target a real remote in deployment.
 */
function runSyncSuite(backendName: string, backend: () => GitBackend) {
  describe(`cross-machine sync via bare remote (${backendName})`, () => {
    it('merges independent entries cleanly on pull', async () => {
      const bare = mkdtempSync(join(tmpdir(), `mnemos-bare-${backendName}-`));
      execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

      const dirA = mkdtempSync(join(tmpdir(), `mnemos-a-${backendName}-`));
      const a = makeGitStore(dirA, backend);
      await a.git.ensure();
      await a.git.setRemote(bare);
      await addMemory(a.store, 'mm://mnemos/ee01', 'from A');
      await a.git.recordCommit('A adds ee01');
      const pushed = await a.git.push();
      expect(pushed.ok).toBe(true);

      const dirB = mkdtempSync(join(tmpdir(), `mnemos-b-${backendName}-`));
      execFileSync('git', ['clone', bare, dirB], { encoding: 'utf8' });
      const b = makeGitStore(dirB, backend);
      await b.git.ensure();
      await addMemory(b.store, 'mm://mnemos/ff02', 'from B');
      await b.git.recordCommit('B adds ff02');
      const pushedB = await b.git.push();
      expect(pushedB.ok).toBe(true);

      const pull = await a.git.pull();
      expect(pull.ok).toBe(true);
      expect(pull.conflicts).toEqual([]);
      expect(a.store.getMemory('mm://mnemos/ee01')?.summary).toBe('from A');
      expect(a.store.getMemory('mm://mnemos/ff02')?.summary).toBe('from B');

      rmSync(bare, { recursive: true, force: true });
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    });

    it('flags a conflict when the same entry changed on both sides', async () => {
      const bare = mkdtempSync(join(tmpdir(), `mnemos-bare2-${backendName}-`));
      execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

      const dirA = mkdtempSync(join(tmpdir(), `mnemos-a2-${backendName}-`));
      const a = makeGitStore(dirA, backend);
      await a.git.ensure();
      await a.git.setRemote(bare);
      await addMemory(a.store, 'mm://mnemos/gg03', 'original');
      await a.git.recordCommit('add gg03');
      await a.git.push();

      const dirB = mkdtempSync(join(tmpdir(), `mnemos-b2-${backendName}-`));
      execFileSync('git', ['clone', bare, dirB], { encoding: 'utf8' });
      const b = makeGitStore(dirB, backend);
      await b.git.ensure();
      const bBase = await b.git.pull();
      expect(bBase.ok).toBe(true);
      expect(b.store.getMemory('mm://mnemos/gg03')?.summary).toBe('original');

      a.store.updateMemory('mm://mnemos/gg03', { summary: 'A side change' });
      await a.git.recordCommit('A changes gg03');
      await a.git.push();

      b.store.updateMemory('mm://mnemos/gg03', { summary: 'B side change' });
      await b.git.recordCommit('B changes gg03');
      const pushedB = await b.git.push();
      expect(pushedB.ok).toBe(false);

      const bPull = await b.git.pull();
      expect(bPull.ok).toBe(false);
      expect(bPull.conflicts.length).toBeGreaterThan(0);

      rmSync(bare, { recursive: true, force: true });
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    });
  });
}

runVersioningSuite('system-git', () => createSystemGitBackend());
runVersioningSuite('isomorphic-git', () => createIsomorphicGitBackend());
runSyncSuite('system-git', () => createSystemGitBackend());
