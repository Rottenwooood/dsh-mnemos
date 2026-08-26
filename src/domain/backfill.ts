/**
 * Session-log backfill (M1): incremental, resumable, content-hash dedup.
 *
 * A backfill run walks session-log files, parses each with the matching
 * adapter, extracts candidate memories, and routes them through the same
 * approval gate as every other write. A per-file byte checkpoint makes runs
 * resumable: a file is re-parsed only from its last recorded offset, so old
 * sessions are processed once and updated sessions only process their tail.
 * Cross-run dedup is the gate's own exact-topic check plus a per-run content
 * hash guard.
 */
import { MemoryService } from './service.js';
import { MemoryInput, MemoryScope } from './types.js';
import { ImportedMessage, ImportSource } from './imports/types.js';
import { parseAny } from './imports/detect.js';
import { extractCandidates } from './extract.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Checkpoint {
  [file: string]: { bytes: number };
}

export interface CheckpointStore {
  read(): Checkpoint;
  write(checkpoint: Checkpoint): void;
}

/** Checkpoint persisted to a JSON file beside the database. */
export function createFileCheckpoint(path: string): CheckpointStore {
  return {
    read(): Checkpoint {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
      } catch {
        return {};
      }
    },
    write(checkpoint: Checkpoint) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(checkpoint, null, 2));
    },
  };
}

export interface ImportStats {
  parsedMessages: number;
  candidates: number;
  committed: number;
  proposed: number;
  denied: number;
  duplicateSkipped: number;
}

export interface ImportOptions {
  caller: 'human' | 'model';
  scope: MemoryScope;
  workspace?: string;
}

/**
 * Extract + gate a normalized message stream. Shared by the /memory import
 * command and the background backfill job so both route through the same
 * approval path.
 */
export function processImported(
  service: MemoryService,
  messages: ImportedMessage[],
  opts: ImportOptions,
  seenHashes = new Set<string>(),
): ImportStats {
  const stats: ImportStats = {
    parsedMessages: messages.length,
    candidates: 0,
    committed: 0,
    proposed: 0,
    denied: 0,
    duplicateSkipped: 0,
  };
  const candidates = extractCandidates(messages, {
    scope: opts.scope,
    workspace: opts.workspace,
  });
  stats.candidates = candidates.length;
  for (const { input } of candidates) {
    const key = contentHashOfInput(input);
    if (seenHashes.has(key)) {
      stats.duplicateSkipped++;
      continue;
    }
    seenHashes.add(key);
    const result = service.add(input, opts.caller);
    if (result.outcome === 'committed') {
      stats.committed++;
    } else if (result.outcome === 'proposed') {
      stats.proposed++;
    } else {
      stats.denied++;
    }
  }
  return stats;
}

export interface BackfillStats extends ImportStats {
  scannedFiles: number;
  errors: string[];
}

export interface BackfillService {
  stats: BackfillStats;
  /** Process files; returns cumulative stats for this run. */
  run(files: Array<{ path: string; text: string }>): BackfillStats;
  saveCheckpoint(): void;
}

export function createBackfillService(
  service: MemoryService,
  opts: {
    checkpoint: CheckpointStore;
    /** How extracted candidates write: 'human' commits directly, 'model' queues. */
    caller: 'human' | 'model';
    scope: MemoryScope;
    workspace?: string;
    /** Parse+extract only the tail beyond the checkpoint for each file. */
    incremental?: boolean;
  },
): BackfillService {
  const stats: BackfillStats = {
    scannedFiles: 0,
    parsedMessages: 0,
    candidates: 0,
    committed: 0,
    proposed: 0,
    denied: 0,
    duplicateSkipped: 0,
    errors: [],
  };
  const checkpoint = opts.checkpoint.read();
  const seenHashes = new Set<string>();

  return {
    stats,
    run(files) {
      for (const file of files) {
        stats.scannedFiles++;
        try {
          const prior = opts.incremental ? checkpoint[file.path]?.bytes ?? 0 : 0;
          const text = file.text.length > prior ? file.text.slice(prior) : '';
          if (!text) {
            continue;
          }
          const source = detectSourceFor(file.path);
          const messages = parseFor(source, text, file.path);
          const s = processImported(
            service,
            messages,
            { caller: opts.caller, scope: opts.scope, workspace: opts.workspace },
            seenHashes,
          );
          stats.parsedMessages += s.parsedMessages;
          stats.candidates += s.candidates;
          stats.committed += s.committed;
          stats.proposed += s.proposed;
          stats.denied += s.denied;
          stats.duplicateSkipped += s.duplicateSkipped;
          checkpoint[file.path] = { bytes: file.text.length };
        } catch (err) {
          stats.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return stats;
    },
    saveCheckpoint() {
      opts.checkpoint.write(checkpoint);
    },
  };
}

function contentHashOfInput(input: MemoryInput): string {
  return createHash('sha1')
    .update(`${input.scope}:${input.workspace ?? ''}:${input.type}:${input.topic}`)
    .digest('hex');
}

/** Pick an adapter by file name; fall back to heuristic detection on content. */
function detectSourceFor(path: string): ImportSource {
  const base = path.toLowerCase();
  if (base.includes('.claude') || base.endsWith('.jsonl') && base.includes('projects')) {
    return 'claude-code';
  }
  if (base.includes('.codex')) {
    return 'codex';
  }
  if (base.includes('conversations.json')) {
    return 'chatgpt';
  }
  return 'dsh';
}

function parseFor(source: ImportSource, text: string, sessionId: string): ImportedMessage[] {
  return parseAny(text, source, sessionId);
}
