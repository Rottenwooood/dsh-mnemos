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
    // DSH session events wrap the payload in `data`; the message text is a
    // content block array there, the role sits next to it.
    if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) {
      const inner = o.data as Record<string, unknown>;
      return extractText(inner.content ?? inner.text ?? inner.message ?? o.data);
    }
    return extractText(o.text ?? o.content ?? o.leaf ?? o.message);
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
    const inner = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown>
      : undefined;
    const content = extractText(entry);
    if (!content) {
      continue;
    }
    const declaredRole = inner !== undefined && typeof inner.role === 'string' ? inner.role : undefined;
    const role =
      typeof declaredRole === 'string' && ['user', 'assistant', 'tool'].includes(declaredRole)
        ? (declaredRole as ImportedMessage['role'])
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
