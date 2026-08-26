/**
 * Deterministic high-signal extraction (M1).
 *
 * Extracts memory candidates from a normalized ImportedMessage stream without
 * any LLM: explicit "remember" requests and user corrections of a preceding
 * assistant/tool message. Every candidate carries provenance evidence and flows
 * through the normal approval gate downstream. The LLM distillation pipeline
 * (M2) layers richer extraction on top of these same signals.
 */
import { MemoryInput, MemoryScope } from './types.js';
import { ImportedMessage } from './imports/types.js';
import { normalizeTopic } from './dedup.js';

export type ExtractionSignal = 'remember' | 'correction';

export interface ExtractedCandidate {
  signal: ExtractionSignal;
  input: MemoryInput;
}

const REMEMBER_RE = /(?:记住|记得|remember(?: that)?|note that)[:：\s]*(.+)/iu;
const CORRECTION_RE =
  /^(不对|不是|错了|其实|应该说|应该是|反了|No,? actually|Not quite|That'?s wrong|That is wrong|Correction|更正|纠正)/iu;

const MAX_QUOTE = 800;

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE)}…` : t;
}

function topicFrom(text: string): string {
  const t = normalizeTopic(text);
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

export function extractCandidates(
  messages: ImportedMessage[],
  opts: { scope: MemoryScope; workspace?: string },
): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];

  for (const msg of messages) {
    if (msg.role !== 'user') {
      continue;
    }
    const match = REMEMBER_RE.exec(msg.text);
    if (!match?.[1]?.trim()) {
      continue;
    }
    const content = clip(match[1]);
    const input: MemoryInput = {
      type: 'preference',
      scope: opts.scope,
      workspace: opts.scope === 'workspace' ? opts.workspace : undefined,
      topic: topicFrom(content),
      summary: content,
      detail: `user said: ${clip(msg.text)}`,
      evidence: [{ sessionId: msg.sessionId, eventRange: [msg.index, msg.index], quote: clip(msg.text) }],
      confidence: 0.7,
      source: 'import',
      writer: 'import:extract-remember',
    };
    out.push({ signal: 'remember', input });
  }

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const cur = messages[i]!;
    if (cur.role !== 'user' || !CORRECTION_RE.test(cur.text)) {
      continue;
    }
    if (prev.role !== 'assistant' && !(prev.role === 'tool' && prev.error)) {
      continue;
    }
    const correction = clip(cur.text);
    const input: MemoryInput = {
      type: 'error_fix',
      scope: opts.scope,
      workspace: opts.scope === 'workspace' ? opts.workspace : undefined,
      topic: topicFrom(correction),
      summary: correction,
      detail: `user corrected a prior ${prev.role} statement`,
      evidence: [
        { sessionId: prev.sessionId, eventRange: [prev.index, prev.index], quote: clip(prev.text) },
        { sessionId: cur.sessionId, eventRange: [cur.index, cur.index], quote: correction },
      ],
      confidence: 0.5,
      source: 'import',
      writer: 'import:extract-correction',
    };
    out.push({ signal: 'correction', input });
  }

  return out;
}
