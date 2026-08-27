/**
 * Format detection and dispatch for foreign-history imports.
 *
 * Detection is heuristic and cheap: Claude Code lines start with a `type`
 * field, Codex uses `type: "response_item"`/`"session_meta"`/`"agent"`, and a
 * ChatGPT export is a JSON array (possibly pretty-printed) of conversations.
 */
import { parseClaudeCodeLog } from './claude-code.js';
import { parseCodexLog } from './codex.js';
import { parseChatGptExport } from './chatgpt.js';
import { parseDshSessionLog } from './dsh.js';
import { ImportSource, ImportedMessage } from './types.js';
import { createHash } from 'node:crypto';

export function detectSource(text: string): ImportSource | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const first = trimmed.split('\n')[0]?.trim() ?? '';
  if (first.startsWith('[') || first.startsWith('{') && trimmed.includes('"mapping"')) {
    return 'chatgpt';
  }
  const types = new Set<string>();
  let hasMessage = false;
  let hasPayload = false;
  for (const line of trimmed.split('\n').slice(0, 200)) {
    const t = line.trim();
    if (!t.startsWith('{')) {
      continue;
    }
    try {
      const obj = JSON.parse(t) as { type?: unknown; message?: unknown; payload?: unknown };
      if (typeof obj.type === 'string') {
        types.add(obj.type);
      }
      if (obj.message !== undefined) {
        hasMessage = true;
      }
      if (obj.payload !== undefined) {
        hasPayload = true;
      }
    } catch {
      // ignore malformed lines during detection
    }
  }
  if (types.has('session')) {
    return 'dsh';
  }
  if (types.has('session_meta') || types.has('response_item') || types.has('agent')) {
    return 'codex';
  }
  if (hasMessage || types.has('tool_use') || types.has('summary') || types.has('result')) {
    return 'claude-code';
  }
  if (hasPayload || types.size > 0) {
    return 'codex';
  }
  return undefined;
}

/** Stable session id derived from content, so imported histories dedupe on re-import. */
export function sessionIdFromText(text: string, source: ImportSource): string {
  const sample = text.trim().slice(0, 2000);
  return `${source}-${createHash('sha1').update(sample).digest('hex').slice(0, 16)}`;
}

export function parseAny(text: string, source: ImportSource, sessionId?: string): ImportedMessage[] {
  const id = sessionId ?? sessionIdFromText(text, source);
  switch (source) {
    case 'claude-code':
      return parseClaudeCodeLog(text, id);
    case 'codex':
      return parseCodexLog(text, id);
    case 'chatgpt':
      return parseChatGptExport(text, id);
    case 'dsh':
      return parseDshSessionLog(text, id);
  }
}
