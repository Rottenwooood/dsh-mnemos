/**
 * ChatGPT export adapter.
 *
 * Input: `conversations.json` from a ChatGPT data export — an array of
 * conversations whose `mapping` is a parent/child tree of message nodes. We
 * flatten each conversation into a user/assistant stream ordered by
 * `create_time`, skipping tool/system roles and empty parts.
 */
import { ImportedMessage } from './types.js';

interface ChatNode {
  id?: string;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { parts?: unknown[]; content_type?: string };
  } | null;
  parent?: string | null;
  children?: string[];
}

interface ChatConversation {
  title?: string;
  create_time?: number;
  mapping?: Record<string, ChatNode>;
}

function nodeText(node: ChatNode): string {
  const content = node.message?.content;
  if (!content || !Array.isArray(content.parts)) {
    return '';
  }
  return content.parts
    .map((p) => (typeof p === 'string' ? p : ''))
    .join('\n')
    .trim();
}

/** Convert a single ChatGPT conversation into ordered ImportedMessage. */
export function parseChatGptConversation(
  conversation: ChatConversation,
  sessionId: string,
): ImportedMessage[] {
  const mapping = conversation.mapping ?? {};
  const nodes = Object.values(mapping)
    .filter((n) => n?.message?.author?.role === 'user' || n?.message?.author?.role === 'assistant')
    .map((n) => ({ n, time: n?.message?.create_time ?? 0 }))
    .filter(({ n, time }) => Number.isFinite(time) && nodeText(n).length > 0)
    .sort((a, b) => a.time - b.time);

  const out: ImportedMessage[] = [];
  let index = 0;
  for (const { n } of nodes) {
    const role = n!.message!.author!.role === 'user' ? 'user' : 'assistant';
    const text = nodeText(n!);
    if (!text) {
      continue;
    }
    out.push({
      role,
      text,
      timestamp: n!.message!.create_time ?? undefined,
      sessionId,
      index: index++,
    });
  }
  return out;
}

/** Parse a full `conversations.json` export. */
export function parseChatGptExport(text: string, sessionIdPrefix = 'chatgpt'): ImportedMessage[] {
  let conversations: ChatConversation[];
  try {
    conversations = JSON.parse(text) as ChatConversation[];
  } catch {
    return [];
  }
  if (!Array.isArray(conversations)) {
    return [];
  }
  const out: ImportedMessage[] = [];
  let n = 0;
  for (const conv of conversations) {
    const id = `${sessionIdPrefix}-${n++}`;
    out.push(...parseChatGptConversation(conv, id));
  }
  return out;
}
