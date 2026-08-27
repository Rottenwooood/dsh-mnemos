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

function makeStore() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

function makeGitStore(repoDir: string) {
  const { store, service } = makeStore();
  const git = createGitStore({
    backend: createSystemGitBackend(),
    store,
    service,
    repoDir,
  });
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

describe('git versioning (system git backend)', () => {
  it('records commits and per-file history, and rolls back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-git-'));
    const { store, git } = makeGitStore(dir);
    await git.ensure();
    await addMemory(store, 'mm://mnemos/aaaa', 'v1');
    const sha1 = (await git.recordCommit('add v1'))!;
    expect(sha1).toBeTruthy();
    await addMemory(store, 'mm://mnemos/bbbb', 'v2');
    await git.recordCommit('add v2');

    const all = await git.history();
    expect(all.length).toBe(2);
    expect(await git.history('mm://mnemos/aaaa')).toHaveLength(1);

    // update aaaa to v3, then roll back to sha1
    store.updateMemory('mm://mnemos/aaaa', { summary: 'v3' });
    await git.recordCommit('update to v3');
    const rollback = await git.rollback('mm://mnemos/aaaa', sha1);
    expect(rollback.ok).toBe(true);
    expect(store.getMemory('mm://mnemos/aaaa')?.summary).toBe('v1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores a deleted memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-git-restore-'));
    const { store, git } = makeGitStore(dir);
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
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-git-bundle-'));
    const { store, git } = makeGitStore(dir);
    await git.ensure();
    await addMemory(store, 'mm://mnemos/dddd', 'bundle me');
    await git.recordCommit('add dddd');
    const out = join(tmpdir(), 'mnemos-backup.bundle');
    await git.exportBundle(out);
    expect(existsSync(out)).toBe(true);
    expect(() => execFileSync('git', ['bundle', 'verify', out], { encoding: 'utf8' })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  });
});

describe('cross-machine sync via bare remote', () => {
  it('merges independent entries cleanly on pull', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'mnemos-bare-'));
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

    const dirA = mkdtempSync(join(tmpdir(), 'mnemos-a-'));
    const a = makeGitStore(dirA);
    await a.git.ensure();
    await a.git.setRemote(bare);
    await addMemory(a.store, 'mm://mnemos/ee01', 'from A');
    await a.git.recordCommit('A adds ee01');
    const pushed = await a.git.push();
    expect(pushed.ok).toBe(true);

    const dirB = mkdtempSync(join(tmpdir(), 'mnemos-b-'));
    execFileSync('git', ['clone', bare, dirB], { encoding: 'utf8' });
    const b = makeGitStore(dirB);
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
    const bare = mkdtempSync(join(tmpdir(), 'mnemos-bare2-'));
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

    const dirA = mkdtempSync(join(tmpdir(), 'mnemos-a2-'));
    const a = makeGitStore(dirA);
    await a.git.ensure();
    await a.git.setRemote(bare);
    await addMemory(a.store, 'mm://mnemos/gg03', 'original');
    await a.git.recordCommit('add gg03');
    await a.git.push();

    const dirB = mkdtempSync(join(tmpdir(), 'mnemos-b2-'));
    execFileSync('git', ['clone', bare, dirB], { encoding: 'utf8' });
    const b = makeGitStore(dirB);
    await b.git.ensure();
    // B pulls the shared base so its store actually holds gg03
    const bBase = await b.git.pull();
    expect(bBase.ok).toBe(true);
    expect(b.store.getMemory('mm://mnemos/gg03')?.summary).toBe('original');

    // A changes the shared entry and pushes
    a.store.updateMemory('mm://mnemos/gg03', { summary: 'A side change' });
    await a.git.recordCommit('A changes gg03');
    await a.git.push();

    // B changes the same entry (based on 'original') -> push is rejected, and
    // the subsequent pull surfaces a per-entry merge conflict
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
