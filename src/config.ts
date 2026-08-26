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
}

export function defaultConfig(): Config {
  const home = homedir();
  return {
    dbPath: join(home, '.dsh', 'mnemos', 'mnemos.db'),
    maxEntries: 5000,
    maxBytesPerEntry: 8192,
    autoApprove: true,
    autoApproveConfidence: 0.9,
    allowModelGlobalWrite: false,
    blacklist: [],
    injectLimit: 8,
    injectMinHits: 1,
    injectMaxBytes: 2048,
    sessionLogDirs: [],
    backfillEnabled: true,
    importCaller: 'human',
  };
}
