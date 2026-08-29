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
import { recallIndex, recallByKeywords } from '../domain/recall.js';
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

/**
 * Effect telemetry (P0): does an injected memory actually get used?
 *
 * After an injection we remember which memories were placed into the request
 * for a session. When the model's next assistant message references one of
 * those memories (its keywords / topic appear in the text), we mark the
 * ledger row used=1 and the memory verified=1. The pending set is dropped at
 * the next user message (a new turn), so we only credit usage in the turn
 * right after the injection — a cheap proxy for "the model actually used it".
 */
export class UsageTracker {
  private pending = new Map<string, Array<{ memoryId: string; terms: string[]; ledgerId: number }>>();

  record(sessionId: string, items: Array<{ memoryId: string; terms: string[]; ledgerId: number }>): void {
    if (!sessionId) return;
    const existing = this.pending.get(sessionId) ?? [];
    this.pending.set(sessionId, existing.concat(items).slice(-100));
  }

  /** New user message: the previous turn is over, drop its pending credits. */
  onUserMessage(sessionId: string): void {
    if (sessionId) this.pending.delete(sessionId);
  }

  /** Model text after an injection: credit any pending memory it references. */
  onAssistantText(sessionId: string, text: string, service: MemoryService): void {
    if (!sessionId) return;
    const items = this.pending.get(sessionId);
    if (!items || items.length === 0) return;
    const lower = text.toLowerCase();
    const still: Array<{ memoryId: string; terms: string[]; ledgerId: number }> = [];
    for (const item of items) {
      const hit = item.terms.some((t) => t.trim().length >= 2 && lower.includes(t.trim().toLowerCase()));
      if (hit) {
        service.markLedgerUsed(item.ledgerId);
        service.markMemoryVerified(item.memoryId);
      } else {
        still.push(item);
      }
    }
    this.pending.set(sessionId, still);
  }
}

/** Rough UTF-8 token estimate for an injected block (CJK ≈ 1 token/char, latin ≈ 4 chars). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
}

export function registerHooks(ctx: Context, collector: SignalCollector, usage: UsageTracker, service: MemoryService): void {
  ctx.on('session/event', (session, event) => {
    collector.onEvent(session, event);
    const sessionId = (session as { id?: unknown })?.id;
    if (typeof sessionId !== 'string') return;
    const data = event.data as { role?: unknown; content?: unknown[]; text?: unknown } | undefined;
    const text = blockText(data?.content ?? data?.text);
    if (event.type === 'assistant/message' && text) {
      usage.onAssistantText(sessionId, text, service);
    } else if (event.type === 'user/message') {
      usage.onUserMessage(sessionId);
    }
  });
}

/**
 * Progressive-disclosure injection (P1): inject a byte-stable frozen INDEX of
 * applicable memories (global + this workspace) once per session, so the block
 * is KV-cache friendly and cheap. The model drills into details with
 * memory_get. Protocol conventions stay always-on beside it.
 */
export function registerInjection(
  ctx: Context,
  service: MemoryService,
  getConfig: () => Config,
  usage: UsageTracker,
): void {
  const injectedSessions = new Set<string>();
  const lastPartial = new Map<string, number>();
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    const sessionId = (payload.agent as { session?: { id?: string } })?.session?.id;
    const cwd = (payload.agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd;
    const text = userTextOf(payload.messages ?? []);
    const config = getConfig();
    if (!config.enabled || !config.injectionEnabled) {
      return decision;
    }
    try {
      if (!injectedSessions.has(sessionId ?? '')) {
        // Session start: inject the FULL frozen index once (byte-stable).
        const index = recallIndex(service, {
          maxBytes: config.injectMaxBytes,
          limit: config.injectLimit,
          workspace: cwd,
        });
        if (sessionId !== undefined) {
          injectedSessions.add(sessionId);
          // interval is measured from the last injection (full or partial).
          lastPartial.set(sessionId, Date.now());
        }
        if (index.injectedCount > 0) {
          const tokens = estimateTokens(index.text);
          const tracked: Array<{ memoryId: string; terms: string[]; ledgerId: number }> = [];
          for (const id of index.injectedIds) {
            try {
              const ledgerId = service.recordHit(id, sessionId, tokens);
              const mem = service.getMemory(id);
              tracked.push({ memoryId: id, terms: (mem?.keywords?.length ? mem.keywords : mem ? [mem.topic] : []), ledgerId });
            } catch {
              // hit tracking is best-effort
            }
          }
          usage.record(sessionId ?? '', tracked);
          return { kind: 'enter', messages: [...decision.messages, makeUserMessage(index.text)] };
        }
        return decision;
      }
      // Mid-session PARTIAL refresh: only when both the interval has elapsed
      // AND the current message hits a memory's keywords. Still an index (short
      // ids), never full text — the model drills down with memory_get.
      const last = lastPartial.get(sessionId ?? '') ?? 0;
      const minutes = config.injectRefreshIntervalMinutes;
      const interval = minutes > 0 ? minutes * 60_000 : 0; // 0 = no interval gate
      if (interval > 0 && Date.now() - last < interval) {
        return decision;
      }
      if (text.length === 0) {
        return decision;
      }
      const partial = recallByKeywords(service, text, {
        workspace: cwd,
        maxBytes: config.injectMaxBytes,
        limit: config.injectPartialLimit,
      });
      if (partial.injectedCount === 0) {
        return decision;
      }
      if (sessionId !== undefined) lastPartial.set(sessionId, Date.now());
      const tokens = estimateTokens(partial.text);
      const tracked: Array<{ memoryId: string; terms: string[]; ledgerId: number }> = [];
      for (const id of partial.injectedIds) {
        try {
          const ledgerId = service.recordHit(id, sessionId, tokens);
          const mem = service.getMemory(id);
          tracked.push({ memoryId: id, terms: (mem?.keywords?.length ? mem.keywords : mem ? [mem.topic] : []), ledgerId });
        } catch {
          // best-effort
        }
      }
      usage.record(sessionId ?? '', tracked);
      return { kind: 'enter', messages: [...decision.messages, makeUserMessage(partial.text)] };
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
 * Protocol effect: inject active `protocol` memories (environment / tool-
 * calling conventions, e.g. sandbox rules, background-job usage) once per
 * session at the first pre-step, then re-inject right after a context
 * compaction completes. Protocol memories are real memories — visible in the
 * console, counted in stats — and this channel makes them always present before
 * the agent acts. Rules are NOT injected; they are the skill-promotion pipeline
 * only.
 *
 * Compaction drops standing instructions (2608.22752: standing rules survive
 * ~10% after 5 summary rounds), so instead of guessing with a turn counter we
 * listen for the harness's own `compaction/end` session event and re-attach the
 * protocol block at the next pre-step after it. The memory INDEX stays frozen
 * (progressive disclosure); only the standing-instruction block is refreshed.
 */
export function registerProtocolInjection(
  ctx: Context,
  service: MemoryService,
  getConfig: () => Config,
): void {
  const injectedSessions = new Set<string>();
  const pendingRefresh = new Set<string>();

  ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown })?.id;
    if (typeof sessionId !== 'string') return;
    const data = event.data as { error?: unknown } | undefined;
    if (event.type === 'compaction/end' && !data?.error) {
      pendingRefresh.add(sessionId);
    }
  });

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next) => {
    const decision = (await next()) as PreStepDecision;
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    const sessionId = (payload.agent as { session?: { id?: string } })?.session?.id;
    const first = sessionId === undefined || !injectedSessions.has(sessionId);
    const afterCompaction = sessionId !== undefined && pendingRefresh.has(sessionId);
    if (!first && !afterCompaction) {
      return decision;
    }
    try {
      if (!getConfig().enabled || !getConfig().protocolInjectEnabled) {
        return decision;
      }
      const protos = service.listActive().filter((m) => m.type === 'protocol').slice(0, 8);
      if (sessionId !== undefined) {
        injectedSessions.add(sessionId);
        pendingRefresh.delete(sessionId);
      }
      if (protos.length > 0) {
        const text = `# dsh-mnemos 环境约定\n${protos.map((p) => `- ${p.summary}`).join('\n')}`;
        return { kind: 'enter', messages: [...decision.messages, makeUserMessage(text)] };
      }
    } catch {
      // protocol injection is best-effort; never fail a request
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
