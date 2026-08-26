/**
 * DeepSeek Harness session-log adapter (best-effort).
 *
 * DSH session logs are JSONL of durable session events. The exact event shape
 * is not pinned here; this tolerant parser picks out role + text from the
 * common shapes (flat `type`/`text`, `content` string, block array, or a
 * nested `message` object) and labels roles from the event `type` prefix.
 * Refine against a real log once one is available.
 */
import { ImportedMessage } from './types.js';

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((b) => (typeof b === 'string' ? b : extractText((b as { text?: unknown })?.text ?? (b as { content?: unknown })?.content)))
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return extractText(o.text ?? o.content ?? o.leaf);
  }
  return '';
}

export function parseDshSessionLog(text: string, sessionId: string): ImportedMessage[] {
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
    const content = extractText(entry);
    if (!content) {
      continue;
    }
    const role =
      typeof entry.role === 'string' && ['user', 'assistant', 'tool'].includes(entry.role)
        ? (entry.role as ImportedMessage['role'])
        : type.startsWith('user')
          ? 'user'
          : type.startsWith('assistant')
            ? 'assistant'
            : type.startsWith('tool')
              ? 'tool'
              : undefined;
    if (!role) {
      continue;
    }
    out.push({
      role,
      text: content,
      sessionId,
      index: index++,
      name: typeof entry.name === 'string' ? entry.name : undefined,
    });
  }
  return out;
}
