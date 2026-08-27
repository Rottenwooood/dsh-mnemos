/**
 * Git backend interface (M4).
 *
 * dsh-mnemos versions its Markdown mirror with git. All git interaction goes
 * through this interface so the backend is swappable: the default is the
 * system `git` CLI (`system-git.ts`); a pure-JS `isomorphic-git` backend can be
 * dropped in without touching the GitStore.
 */
export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
}

export interface GitBackend {
  hasRepo(dir: string): Promise<boolean>;
  ensureRepo(dir: string): Promise<void>;
  /** Files with uncommitted changes (includes conflicted files). */
  status(dir: string): Promise<{ changed: string[] }>;
  /** Commit the given files (or everything when omitted); returns sha or undefined when nothing to commit. */
  commit(dir: string, message: string, files?: string[]): Promise<string | undefined>;
  log(dir: string, file?: string): Promise<CommitInfo[]>;
  /** File content at a commit; undefined when the file did not exist there. */
  show(dir: string, sha: string, file: string): Promise<string | undefined>;
  restoreFile(dir: string, sha: string, file: string): Promise<void>;
  addRemote(dir: string, name: string, url: string): Promise<void>;
  push(dir: string, remote: string, branch: string): Promise<void>;
  fetch(dir: string, remote: string): Promise<void>;
  /** Merge the fetched remote branch into the current branch; reports conflicted files. */
  merge(dir: string, branch: string): Promise<MergeResult>;
  currentBranch(dir: string): Promise<string>;
  /** Write a git bundle (backup) to outPath. */
  exportBundle(dir: string, outPath: string): Promise<void>;
}
