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
import { recallByKeywords } from '../domain/recall.js';
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
  private userCount = 0;

  constructor(
    private readonly log: (message: string) => void,
    private readonly maxBuffer = 200,
    /** Called with the running user-message count; drives count-based auto-distill. */
    private readonly onUserMessage?: (count: number) => void,
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
    if (role === 'user') {
      this.trackUserMessage();
    }
    this.trim();
  }

  /** Ingest parsed transcript messages (import/backfill) into the distill buffer. */
  ingest(messages: ImportedMessage[]): void {
    for (const m of messages) {
      this.buffer.push(m);
    }
    this.trim();
  }

  private trackUserMessage(): void {
    this.userCount += 1;
    this.onUserMessage?.(this.userCount);
  }

  private trim(): void {
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

  /** Running count of user messages seen (drives the every-N auto-distill). */
  get userMessages(): number {
    return this.userCount;
  }
}

export function registerHooks(ctx: Context, collector: SignalCollector): void {
  ctx.on('session/event', (session, event) => collector.onEvent(session, event));
}

/**
 * Cold/hot layered injection: keyword-triggered and low-frequency.
 *
 * On each `agent/pre-step`, when the step carries NEW user text (the first
 * step of a user turn; tool-loop steps carry none), the session text is
 * scanned against each active memory's keywords. Any hit is injected as one
 * UserMessage into the next model request ("keyword appears → inject in the
 * next block"). No LLM, no embeddings, no per-session frozen snapshot.
 */
export function registerInjection(
  ctx: Context,
  service: MemoryService,
  getConfig: () => Config,
): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    const sessionId = (payload.agent as { session?: { id?: string } })?.session?.id;
    const cwd = (payload.agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd;
    try {
      const config = getConfig();
      if (!config.enabled || !config.injectionEnabled) {
        return decision;
      }
      // Low-frequency scan: only a step carrying user input can trigger.
      const userText = userTextOf(payload.messages);
      if (!userText) {
        return decision;
      }
      // Candidates = global memories + this workspace's memories (project A's
      // facts must not inject into project B).
      const injection = recallByKeywords(service, userText, {
        maxBytes: config.injectMaxBytes,
        limit: config.injectLimit,
        workspace: cwd,
      });
      if (injection.injectedCount > 0) {
        // A memory that actually reached a request counts as used.
        for (const id of injection.injectedIds) {
          try {
            service.recordHit(id, sessionId);
          } catch {
            // hit tracking is best-effort
          }
        }
        return { kind: 'enter', messages: [...decision.messages, makeUserMessage(injection.text)] };
      }
    } catch {
      // injection is best-effort; never fail a step because of memory recall
    }
    return decision;
  });
}

/** Concatenate the text of all user messages carried by a pre-step payload. */
function userTextOf(messages: unknown[]): string {
  let out = '';
  for (const message of messages) {
    const msg = message as { role?: string; content?: unknown[] | string };
    if (msg.role !== 'user') {
      continue;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      out += ` ${content}`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: unknown };
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
          out += ` ${b.text}`;
        }
      }
    }
  }
  return out.trim();
}

/**
 * Rule effect (M2): append approved rules as one injected UserMessage, so the
 * model sees the standing preferences the user approved. The real
 * `agent/request` waterfall only configures the model call (no
 * system/messages), so rules inject here, beside the memory projection. Rules
 * are frozen per session like the memory projection.
 */
export function registerRuleInjection(
  ctx: Context,
  service: MemoryService,
  getConfig: () => Config,
  getRevision: () => number = () => 0,
): void {
  const injectedRevision = new Map<string, number>();
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    const sessionId = (payload.agent as { session?: { id?: string } })?.session?.id;
    const revision = getRevision();
    if (sessionId !== undefined && injectedRevision.get(sessionId) === revision) {
      return decision;
    }
    try {
      if (!getConfig().enabled || !getConfig().rulesInjectEnabled) {
        return decision;
      }
      const rules = service.listRules('approved');
      if (sessionId !== undefined) injectedRevision.set(sessionId, revision);
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
