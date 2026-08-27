/**
 * Session-log backfill / import (M1): incremental, resumable, no heuristics.
 *
 * A backfill run walks session-log files, parses each with the matching
 * adapter, and INGESTS the messages into the distill buffer — memory
 * generation is the LLM distillation pipeline's job (manual tool call or
 * every-N-user-inputs auto run), never a regex. A per-file byte checkpoint
 * makes runs resumable: a file is re-parsed only from its last recorded
 * offset.
 */
import { ImportedMessage, ImportSource } from './imports/types.js';
import { MemoryScope } from './types.js';
import { parseAny } from './imports/detect.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Anything that can accept transcript messages into the distill buffer. */
export interface MessageSink {
  ingest(messages: ImportedMessage[]): void;
}

export interface Checkpoint {
  [file: string]: { bytes: number };
}

export interface CheckpointStore {
  read(): Checkpoint;
  write(checkpoint: Checkpoint): void;
}

/** Generic JSON-file key/value store; empty object when missing or invalid. */
export function createJsonFileStore<T extends object>(path: string): { read(): T; write(value: T): void } {
  return {
    read(): T {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch {
        return {} as T;
      }
    },
    write(value: T) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value, null, 2));
    },
  };
}

/** Checkpoint persisted to a JSON file beside the database. */
export function createFileCheckpoint(path: string): CheckpointStore {
  const store = createJsonFileStore<Checkpoint>(path);
  return {
    read: () => store.read(),
    write: (c) => store.write(c),
  };
}

export interface ImportStats {
  parsedMessages: number;
}

export interface ImportOptions {
  caller: 'human' | 'model';
  scope: MemoryScope;
  workspace?: string;
}

/**
 * Ingest a normalized message stream into the distill buffer (no extraction).
 * Shared by the /memory import command and the background backfill job; the
 * buffered messages are distilled by the LLM pipeline later.
 */
export function processImported(
  sink: MessageSink,
  messages: ImportedMessage[],
  _opts: ImportOptions,
): ImportStats {
  sink.ingest(messages);
  return { parsedMessages: messages.length };
}

export interface BackfillStats {
  scannedFiles: number;
  parsedMessages: number;
  errors: string[];
}

export interface BackfillService {
  stats: BackfillStats;
  /** Process files; returns cumulative stats for this run. */
  run(files: Array<{ path: string; text: string }>): BackfillStats;
  saveCheckpoint(): void;
}

export function createBackfillService(
  sink: MessageSink,
  opts: {
    checkpoint: CheckpointStore;
    /** Parse+extract only the tail beyond the checkpoint for each file. */
    incremental?: boolean;
  },
): BackfillService {
  const stats: BackfillStats = {
    scannedFiles: 0,
    parsedMessages: 0,
    errors: [],
  };
  const checkpoint = opts.checkpoint.read();

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
          sink.ingest(messages);
          stats.parsedMessages += messages.length;
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
