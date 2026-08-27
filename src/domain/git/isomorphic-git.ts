/**
 * Pure-JS isomorphic-git backend.
 *
 * No system git binary required — every operation runs through the
 * isomorphic-git library with node's fs. Satisfies the same GitBackend
 * interface as the system-git backend, so GitStore is backend-agnostic.
 *
 * Sync remotes here are local paths (git remote dirs / bare repos), which
 * isomorphic-git handles without an HTTP client; the stub `http` only throws
 * if some future http remote is configured. Bundles are written in the
 * standard `# v2 git bundle` format (refs + PACK) built from packObjects.
 */
import git from 'isomorphic-git';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitBackend, CommitInfo, MergeResult } from './backend.js';
import type { HttpClient } from 'isomorphic-git';

const AUTHOR = { name: 'dsh-mnemos', email: 'dsh-mnemos@localhost' };

/** Throws if an http remote is ever used; local sync never calls it. */
const http: HttpClient = {
  async request() {
    throw new Error('http remotes are not configured for dsh-mnemos');
  },
};

const opts = { fs, http } as const;

function toCommitInfo(c: Awaited<ReturnType<typeof git.log>>[number]): CommitInfo {
  return {
    sha: c.oid,
    message: c.commit.message,
    date: new Date(c.commit.committer.timestamp * 1000).toISOString(),
  };
}

async function blobAt(dir: string, oid: string, file: string): Promise<string | undefined> {
  try {
    const { blob } = await git.readBlob({ ...opts, dir, oid, filepath: file });
    return Buffer.from(blob).toString('utf8');
  } catch {
    return undefined;
  }
}

export function createIsomorphicGitBackend(): GitBackend {
  return {
    async hasRepo(dir) {
      return existsSync(join(dir, '.git'));
    },

    async ensureRepo(dir) {
      if (!(await this.hasRepo(dir))) {
        await git.init({ ...opts, dir, defaultBranch: 'main' });
      }
      await git.setConfig({ ...opts, dir, path: 'user.name', value: AUTHOR.name });
      await git.setConfig({ ...opts, dir, path: 'user.email', value: AUTHOR.email });
    },

    async status(dir) {
      const matrix = await git.statusMatrix({ ...opts, dir });
      // statusMatrix entries are [filepath, head, workdir, stage]; each of the
      // three is 0 (absent) / 1 (present) / 2 (modified) / 3 (type change). A
      // file changed only when workdir or the index differ from HEAD — a clean
      // file has stage=1, which is NOT a change.
      const changed = matrix
        .filter(([, head, workdir, stage]) => head !== workdir || stage !== head)
        .map(([file]) => file as string);
      return { changed };
    },

    async commit(dir, message, files) {
      if (files && files.length > 0) {
        for (const file of files) {
          await git.add({ ...opts, dir, filepath: file });
        }
      } else {
        await git.add({ ...opts, dir, filepath: '.' });
      }
      // isomorphic-git's add() does not stage deletions; stage them explicitly
      // so a removed mirror file lands in the commit (a deleted memory stays
      // recoverable from history).
      const matrix = await git.statusMatrix({ ...opts, dir });
      for (const [file, head, workdir] of matrix) {
        if (head !== 0 && workdir === 0) {
          await git.remove({ ...opts, dir, filepath: file as string });
        }
      }
      const staged = matrix.some(([, head, workdir, stage]) => head !== workdir || stage !== head);
      if (!staged) {
        return undefined;
      }
      return git.commit({
        ...opts,
        dir,
        message,
        author: AUTHOR,
        committer: AUTHOR,
      });
    },

    async log(dir, file) {
      const commits = await git.log({ ...opts, dir, depth: 100 });
      if (!file) {
        return commits.map(toCommitInfo);
      }
      // Replicate `git log -- <file>` (commits where the file changed): compare
      // the file's blob in each commit against its parent. isomorphic-git's own
      // filepath filter throws when the file is absent from HEAD (e.g. a
      // deleted memory), so this walk keeps deleted-memory history too.
      const changed = new Set<string>();
      for (const c of commits) {
        const mine = await blobAt(dir, c.oid, file);
        const parent = c.commit.parent[0];
        const theirs = parent !== undefined ? await blobAt(dir, parent, file) : undefined;
        if (mine !== theirs) {
          changed.add(c.oid);
        }
      }
      return commits.filter((c) => changed.has(c.oid)).map(toCommitInfo);
    },

    async show(dir, sha, file) {
      try {
        const { blob } = await git.readBlob({ ...opts, dir, oid: sha, filepath: file });
        return Buffer.from(blob).toString('utf8');
      } catch {
        return undefined;
      }
    },

    async restoreFile(dir, sha, file) {
      const { blob } = await git.readBlob({ ...opts, dir, oid: sha, filepath: file });
      const parent = file.split('/').slice(0, -1).join('/');
      if (parent) {
        fs.mkdirSync(join(dir, parent), { recursive: true });
      }
      fs.writeFileSync(join(dir, file), blob);
    },

    async addRemote(dir, name, url) {
      try {
        await git.deleteRemote({ ...opts, dir, remote: name });
      } catch {
        // no existing remote
      }
      await git.addRemote({ ...opts, dir, remote: name, url });
    },

    async push(dir, remote, branch) {
      await git.push({ ...opts, dir, remote, ref: branch });
    },

    async fetch(dir, remote) {
      await git.fetch({ ...opts, dir, remote });
    },

    async merge(dir, branch): Promise<MergeResult> {
      const ours = (await this.currentBranch(dir)) ?? 'main';
      try {
        await git.merge({ ...opts, dir, ours, theirs: branch });
        return { ok: true, conflicts: [] };
      } catch (err) {
        const e = err as { code?: string; data?: { filepaths?: string[] } };
        if (e?.code === 'MergeConflictError') {
          return { ok: false, conflicts: e.data?.filepaths ?? [] };
        }
        throw err;
      }
    },

    async currentBranch(dir) {
      return (await git.currentBranch({ ...opts, dir })) ?? 'main';
    },

    async exportBundle(dir, outPath) {
      const head = await git.resolveRef({ ...opts, dir, ref: 'HEAD' });
      const refs = await git.listRefs({ ...opts, dir });
      const lines: string[] = ['# v2 git bundle'];
      for (const ref of refs) {
        if (ref.startsWith('refs/heads/') || ref === 'HEAD') {
          const oid = await git.resolveRef({ ...opts, dir, ref });
          lines.push(`${oid} ${ref}`);
        }
      }
      const { packfile } = await git.packObjects({ ...opts, dir, oids: [head], write: false });
      const body = Buffer.from(`${lines.join('\n')}\n\n`, 'utf8');
      const packed = Buffer.from(packfile ?? new Uint8Array());
      const parent = outPath.includes('/') ? outPath.slice(0, outPath.lastIndexOf('/')) : '.';
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(outPath, Buffer.concat([body, packed]));
    },
  };
}
