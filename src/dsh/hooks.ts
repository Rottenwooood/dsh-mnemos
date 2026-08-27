/**
 * Session-signal collection (M0 minimal).
 *
 * Listens to durable session/event facts and maintains a per-session cursor so
 * later milestones can extract memories incrementally without reprocessing
 * older messages. M0 only detects high-value signals (explicit "remember"
 * requests) and logs them; the extraction pipeline lands in M2.
 */
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type { MemoryService } from '../domain/service.js';
import { recallHot } from '../domain/recall.js';
import type { Config } from '../config.js';
import type { ImportedMessage } from '../domain/imports/types.js';

const REMEMBER_RE = /(?:^|[^\p{L}])(记住|记得|remember)(?:[^\p{L}]|$)/iu;

/** Structural face of one `session/event` payload (the real rc.2 shape). */
export interface DshSessionFeedEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: { role?: string; content?: unknown[]; text?: string };
}

/** Concatenate a dsh content-block array (or plain text) into one string. */
function blockText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((b) => (typeof b === 'string' ? b : (b as { text?: unknown })?.text))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
  }
  return '';
}

export class SignalCollector {
  private readonly cursor = new Map<string, number>();
  private readonly buffer: ImportedMessage[] = [];

  constructor(
    private readonly log: (message: string) => void,
    private readonly maxBuffer = 200,
  ) {}

  onEvent(session: { id?: unknown }, event: DshSessionFeedEvent): void {
    const sessionId = typeof session.id === 'string' ? session.id : undefined;
    if (!sessionId || typeof event.seq !== 'number') {
      return;
    }
    const prev = this.cursor.get(sessionId) ?? -1;
    if (event.seq <= prev) {
      return;
    }
    this.cursor.set(sessionId, event.seq);
    if (event.type !== 'user/message' && event.type !== 'assistant/message') {
      return;
    }
    const text = blockText(event.data?.content ?? event.data?.text);
    if (!text.trim()) {
      return;
    }
    if (REMEMBER_RE.test(text)) {
      this.log(
        `dsh-mnemos: remember-signal in session ${sessionId} at index ${event.seq} buffered for distillation`,
      );
    }
    const role =
      event.data?.role === 'assistant'
        ? 'assistant'
        : event.data?.role === 'tool'
          ? 'tool'
          : event.type === 'user/message'
            ? 'user'
            : 'assistant';
    this.buffer.push({ role, text, sessionId, index: event.seq });
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
  }

  /** Drain buffered messages for the distillation trigger. */
  drain(): ImportedMessage[] {
    const out = [...this.buffer];
    this.buffer.length = 0;
    return out;
  }
}

export function registerHooks(ctx: Context, collector: SignalCollector): void {
  ctx.on('session/event', (session, event) => collector.onEvent(session, event));
}

/**
 * Cold/hot layered injection (M1): on each agent step, build the hot-layer
 * projection under the hard byte budget and append it as one injected
 * UserMessage, returning `{ kind: 'enter', messages: [...] }` per the real
 * `agent/pre-step` contract (payload + next waterfall).
 */
export function registerInjection(ctx: Context, service: MemoryService, getConfig: () => Config): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    try {
      const config = getConfig();
      const injection = recallHot(service, {
        maxBytes: config.injectMaxBytes,
        limit: config.injectLimit,
        scope: 'workspace',
        minHits: config.injectMinHits,
      });
      if (injection.injectedCount > 0) {
        return { kind: 'enter', messages: [...decision.messages, makeUserMessage(injection.text)] };
      }
    } catch {
      // injection is best-effort; never fail a step because of memory recall
    }
    return decision;
  });
}

/**
 * Rule effect (M2): append approved rules as one injected UserMessage on the
 * step, so the model sees the standing preferences the user approved. The
 * real `agent/request` waterfall only configures the model call (no
 * system/messages), so rules inject here, beside the memory projection.
 */
export function registerRuleInjection(ctx: Context, service: MemoryService, getConfig: () => Config): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    try {
      if (!getConfig().rulesInjectEnabled) {
        return decision;
      }
      const rules = service.listRules('approved');
      if (rules.length > 0) {
        const text = `# dsh-mnemos 生效规则\n${rules.map((r) => `- [${r.kind}] ${r.text}`).join('\n')}`;
        return { kind: 'enter', messages: [...decision.messages, makeUserMessage(text)] };
      }
    } catch {
      // rule injection is best-effort; never fail a request
    }
    return decision;
  });
}

/** Structural face of the real `agent/pre-step` payload (see dsh.d.ts). */
export interface PreStepPayload {
  agent: unknown;
  messages: unknown[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

/** Structural face of the real `PreStepDecision`. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: unknown[] };

/** Build one injected UserMessage (structural dsh Message shape). */
function makeUserMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-mnemos', form: 'instructions' },
  };
}
