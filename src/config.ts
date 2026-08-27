/**
 * dsh-mnemos plugin configuration.
 *
 * Deployment-varying choices are Config fields so users can change them from
 * cordis.patch.yml (and later from the settings page). A structured settings
 * schema (schemastery) lands with the settings milestone; for now defaults are
 * applied in `defaultConfig()`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Master switch: false silences every active behaviour (injection, collection, distill, backfill, sync). */
  enabled: boolean;
  /** SQLite database file location. */
  dbPath: string;
  /** Hard cap on active memory entries. */
  maxEntries: number;
  /** Hard cap on bytes per entry (topic + summary + detail). */
  maxBytesPerEntry: number;
  /** Auto-approve high-confidence, low-risk project facts on write. */
  autoApprove: boolean;
  /** Confidence at or above which a project fact is auto-approvable. */
  autoApproveConfidence: number;
  /** Allow the model to write global-scope memories directly. */
  allowModelGlobalWrite: boolean;
  /** Writers (plugin ids / callers) that are always denied. */
  blacklist: string[];
  /** False disables the sensitive-content gate entirely. */
  sensitivityCheckEnabled: boolean;
  /** Default scope applied by extraction / import / distillation when the source has none. */
  defaultScope: 'workspace' | 'global';
  /** Master switch for cross-session memory injection (agent/pre-step). */
  injectionEnabled: boolean;
  /** Max memories injected into one model request. */
  injectLimit: number;
  /** Minimum cross-session hits before a memory is injected automatically. */
  injectMinHits: number;
  /** Hard byte budget for the hot-layer projection injected per turn. */
  injectMaxBytes: number;
  /** Directories scanned by the background backfill job (DSH session logs). */
  sessionLogDirs: string[];
  /** Whether backfill runs on startup; false keeps it manual-only. */
  backfillEnabled: boolean;
  /** How backfill/imported candidates write: 'human' commits, 'model' queues. */
  importCaller: 'human' | 'model';
  /** Directory where approved rules are promoted into Markdown skill files. */
  skillsDir: string;
  /** Inject approved rules into agent/request prompts. */
  rulesInjectEnabled: boolean;
  /** Inject active protocol (environment/tool-convention) memories every session. */
  protocolInjectEnabled: boolean;
  /** Automatic distillation (default off = purely manual trigger). */
  distillAuto: boolean;
  /** Auto-distill every N live user messages when distillAuto is on (count-based, not a timer). */
  distillEveryNTurns: number;
  /** Max session messages buffered for distillation at once. */
  distillWindow: number;
  /** Directory holding the git-tracked Markdown mirror (memory repo). */
  memoryRepoDir: string;
  /** Version the memory mirror with git on every change. */
  gitVersioning: boolean;
  /** Git remote name used for sync. */
  gitRemoteName: string;
  /** Git remote URL for sync (empty = not configured; set live to re-point origin). */
  gitRemoteUrl: string;
  /** Auto pull+push on an interval (default off). */
  syncEnabled: boolean;
  /** How often the sync job runs, in minutes. */
  syncIntervalMinutes: number;
  /** Git backend: 'isomorphic' (pure JS, default) or 'system' (system git CLI). */
  gitBackend: 'isomorphic' | 'system';
  /** LLM provider for distillation; empty falls back to DSH's agent-default-model. */
  llmProvider: string;
  /** LLM model id for distillation; empty falls back to DSH's agent-default-model. */
  llmModel: string;
}

export function defaultConfig(): Config {
  const home = homedir();
  return {
    enabled: true,
    dbPath: join(home, '.dsh', 'mnemos', 'mnemos.db'),
    maxEntries: 5000,
    maxBytesPerEntry: 8192,
    autoApprove: true,
    autoApproveConfidence: 0.9,
    allowModelGlobalWrite: false,
    blacklist: [],
    sensitivityCheckEnabled: true,
    defaultScope: 'workspace',
    injectionEnabled: true,
    injectLimit: 8,
    injectMinHits: 0,
    injectMaxBytes: 2048,
    sessionLogDirs: [],
    backfillEnabled: true,
    importCaller: 'human',
    skillsDir: join(home, '.dsh', 'mnemos', 'skills'),
    rulesInjectEnabled: true,
    protocolInjectEnabled: true,
    distillAuto: false,
    distillEveryNTurns: 5,
    distillWindow: 200,
    memoryRepoDir: join(home, '.dsh', 'mnemos', 'repo'),
    gitVersioning: true,
    gitRemoteName: 'origin',
    gitRemoteUrl: '',
    syncEnabled: false,
    syncIntervalMinutes: 1440,
    gitBackend: 'isomorphic',
    llmProvider: '',
    llmModel: '',
  };
}
