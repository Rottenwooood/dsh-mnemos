/**
 * Claude Code transcript adapter.
 *
 * Input: one JSON object per line (`~/.claude/projects/**\/*.jsonl`). We keep
 * user/assistant text and surface tool results (including error results) so the
 * error-fix extractor can see them. The parser is tolerant of both string and
 * block-array message content.
 */
import { ImportedMessage } from './types.js';

function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          return b.text;
        }
        if (typeof b.content === 'string') {
          return b.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function parseClaudeCodeLog(text: string, sessionId: string): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  let index = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    const message = (entry.message ?? {}) as Record<string, unknown>;
    const timestamp =
      typeof entry.timestamp === 'string'
        ? Date.parse(entry.timestamp) / 1000
        : undefined;

    if (type === 'user' || type === 'assistant') {
      const text = contentText(message.content).trim();
      if (text) {
        out.push({
          role: type === 'user' ? 'user' : 'assistant',
          text,
          timestamp,
          sessionId,
          index: index++,
          name: typeof message.model === 'string' ? message.model : undefined,
        });
      }
    } else if (type === 'tool_use') {
      const name = typeof message.name === 'string' ? message.name : undefined;
      const input = message.input;
      const text =
        input && typeof input === 'object'
          ? JSON.stringify(input)
          : typeof input === 'string'
            ? input
            : '';
      if (text.trim()) {
        out.push({ role: 'tool', text, timestamp, sessionId, index: index++, name });
      }
    } else if (type === 'result') {
      const text = contentText(message.content).trim();
      const isError = message.is_error === true;
      if (text) {
        out.push({
          role: 'tool',
          text,
          timestamp,
          sessionId,
          index: index++,
          name: typeof message.tool_use_id === 'string' ? `result:${message.tool_use_id}` : undefined,
          error: isError,
        });
      }
    }
  }
  return out;
}
