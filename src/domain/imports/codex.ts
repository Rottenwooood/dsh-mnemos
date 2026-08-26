/**
 * OpenAI Codex transcript adapter.
 *
 * Input: one JSON object per line (`~/.codex/sessions/**\/*.jsonl`). Handles
 * both the legacy `{"type":"user|agent","payload":{"content":...}}` shape and
 * the newer `response_item` envelope (message / function_call /
 * function_call_output). Tool error results are surfaced for error-fix
 * extraction.
 */
import { ImportedMessage } from './types.js';

function blockText(content: unknown): string {
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
        if (typeof b.text === 'string') {
          return b.text;
        }
        if (b.content_type === 'text' && Array.isArray(b.parts)) {
          return b.parts.filter((p): p is string => typeof p === 'string').join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function parseCodexLog(text: string, sessionId: string): ImportedMessage[] {
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
    const timestamp =
      typeof entry.timestamp === 'string'
        ? Date.parse(entry.timestamp) / 1000
        : undefined;

    if (type === 'session_meta') {
      continue;
    }

    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    const role = typeof payload.role === 'string' ? payload.role : '';

    if (type === 'user' && role === 'user') {
      const text = blockText(payload.content).trim();
      if (text) {
        out.push({ role: 'user', text, timestamp, sessionId, index: index++ });
      }
    } else if (type === 'agent' || (type === 'response_item' && payloadType === 'message')) {
      const role2 = (type === 'agent' ? 'assistant' : role) as 'assistant' | 'user';
      const text = blockText(payload.content).trim();
      if (text) {
        out.push({ role: role2, text, timestamp, sessionId, index: index++, name: 'assistant' });
      }
    } else if (type === 'response_item' && payloadType === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : undefined;
      const args = payload.arguments;
      const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
      out.push({ role: 'tool', text, timestamp, sessionId, index: index++, name });
    } else if (type === 'response_item' && payloadType === 'function_call_output') {
      const output = blockText(payload.output);
      const isError = output.trim().toLowerCase().startsWith('error');
      out.push({
        role: 'tool',
        text: output,
        timestamp,
        sessionId,
        index: index++,
        name: 'function_call_output',
        error: isError,
      });
    }
  }
  return out;
}
