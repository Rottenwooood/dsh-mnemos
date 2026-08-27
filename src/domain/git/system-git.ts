/**
 * System `git` CLI backend.
 *
 * Uses the installed git binary via a bare `git` API (no shell). A local repo
 * identity (dsh-mnemos) is configured so commits work regardless of the user's
 * global git config. Swap for the pure-JS isomorphic-git backend by satisfying
 * the same GitBackend interface.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitBackend, CommitInfo, MergeResult } from './backend.js';

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, encoding: 'utf8' });
    return { stdout: stdout.replace(/\n$/, ''), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number; message?: string };
    return { stdout: e.stdout ?? '', code: e.code ?? 1 };
  }
}

export function createSystemGitBackend(): GitBackend {
  return {
    async hasRepo(dir) {
      return existsSync(join(dir, '.git'));
    },

    async ensureRepo(dir) {
      if (!(await this.hasRepo(dir))) {
        await git(dir, ['init', '-b', 'main']);
      }
      await git(dir, ['config', 'user.name', 'dsh-mnemos']);
      await git(dir, ['config', 'user.email', 'dsh-mnemos@localhost']);
      await git(dir, ['config', 'commit.gpgsign', 'false']);
    },

    async status(dir) {
      const { stdout } = await git(dir, ['status', '--porcelain']);
      const changed = stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
      return { changed };
    },

    async commit(dir, message, files) {
      const { stdout: before } = await git(dir, ['rev-parse', '--verify', 'HEAD']);
      if (files && files.length > 0) {
        await git(dir, ['add', '--', ...files]);
      } else {
        await git(dir, ['add', '-A']);
      }
      const { stdout: staged } = await git(dir, ['diff', '--cached', '--name-only']);
      if (!staged.trim()) {
        return undefined;
      }
      const { code } = await git(dir, ['commit', '-m', message]);
      if (code !== 0) {
        return undefined;
      }
      const { stdout: after } = await git(dir, ['rev-parse', 'HEAD']);
      return before === after ? undefined : after;
    },

    async log(dir, file) {
      const args = ['log', '--format=%H%x00%s%x00%aI'];
      if (file) {
        args.push('--', file);
      }
      const { stdout } = await git(dir, args);
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, message, date] = line.split('\u0000');
          return { sha: sha ?? '', message: message ?? '', date: date ?? '' } satisfies CommitInfo;
        });
    },

    async show(dir, sha, file) {
      const { stdout, code } = await git(dir, ['show', `${sha}:${file}`]);
      return code === 0 ? stdout : undefined;
    },

    async restoreFile(dir, sha, file) {
      await git(dir, ['checkout', sha, '--', file]);
    },

    async addRemote(dir, name, url) {
      await git(dir, ['remote', 'remove', name]);
      await git(dir, ['remote', 'add', name, url]);
    },

    async push(dir, remote, branch) {
      const { code, stdout } = await git(dir, ['push', '-u', remote, branch]);
      if (code !== 0) {
        throw new Error(stdout || 'git push failed');
      }
    },

    async fetch(dir, remote) {
      await git(dir, ['fetch', remote]);
    },

    async merge(dir, branch): Promise<MergeResult> {
      const { code } = await git(dir, ['merge', branch, '--no-edit']);
      if (code === 0) {
        return { ok: true, conflicts: [] };
      }
      const { stdout } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
      const conflicts = stdout.split('\n').filter(Boolean);
      return { ok: false, conflicts };
    },

    async currentBranch(dir) {
      const { stdout } = await git(dir, ['branch', '--show-current']);
      return stdout || 'main';
    },

    async exportBundle(dir, outPath) {
      await git(dir, ['bundle', 'create', outPath, '--all']);
    },
  };
}
