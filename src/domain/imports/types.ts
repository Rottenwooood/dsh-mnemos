/**
 * Shared types for the M1 import adapters and session-log backfill.
 *
 * Every adapter normalizes a foreign transcript into a flat stream of
 * ImportedMessage; downstream extraction and backfill only ever see this shape.
 */
import type { MemorySource } from '../types.js';

export type ImportedRole = 'user' | 'assistant' | 'tool';

export interface ImportedMessage {
  role: ImportedRole;
  text: string;
  /** Epoch seconds, when the source provides one. */
  timestamp?: number;
  /** Stable id of the source conversation/session. */
  sessionId: string;
  /** Position within that session. */
  index: number;
  /** Tool name for tool messages; model id for assistant messages. */
  name?: string;
  /** True when a tool result reported an error. */
  error?: boolean;
}

export type ImportSource = 'claude-code' | 'codex' | 'chatgpt' | 'dsh';

/** Memory source value that a foreign-history import maps to. */
export const IMPORT_MEMORY_SOURCE: MemorySource = 'import';
