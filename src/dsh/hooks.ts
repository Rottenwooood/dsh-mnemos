/**
 * Session-signal collection (M0 minimal).
 *
 * Listens to durable session/event facts and maintains a per-session cursor so
 * later milestones can extract memories incrementally without reprocessing
 * older messages. M0 only detects high-value signals (explicit "remember"
 * requests) and logs them; the extraction pipeline lands in M2.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from '../domain/service.js';
import { recallHot } from '../domain/recall.js';
import type { Config } from '../config.js';
import type { DshSessionEvent } from './types.js';

const REMEMBER_RE = /(?:^|[^\p{L}])(记住|记得|remember)(?:[^\p{L}]|$)/iu;

export class SignalCollector {
  private readonly cursor = new Map<string, number>();

  constructor(private readonly log: (message: string) => void) {}

  onEvent(event: DshSessionEvent): void {
    if (!event.sessionId || typeof event.index !== 'number') {
      return;
    }
    const prev = this.cursor.get(event.sessionId) ?? -1;
    if (event.index <= prev) {
      return;
    }
    this.cursor.set(event.sessionId, event.index);
    if (event.type !== 'user/message' && event.type !== 'assistant/message') {
      return;
    }
    const text = typeof event.text === 'string' ? event.text : '';
    if (REMEMBER_RE.test(text)) {
      this.log(
        `dsh-mnemos: remember-signal in session ${event.sessionId} at index ${event.index} (extraction pipeline lands in M2)`,
      );
    }
  }
}

export function registerHooks(ctx: Context, collector: SignalCollector): void {
  ctx.on('session/event', (event) => collector.onEvent(event));
}

/**
 * Cold/hot layered injection (M1): on each agent step, build the hot-layer
 * projection under the hard byte budget and queue it into the same request via
 * `agent.inject()` — no second API call. The waterfall always delegates with
 * next().
 */
export function registerInjection(ctx: Context, service: MemoryService, config: Config): void {
  ctx.on('agent/pre-step', async (agent, _input, next) => {
    try {
      const injection = recallHot(service, {
        maxBytes: config.injectMaxBytes,
        limit: config.injectLimit,
        scope: 'workspace',
        minHits: config.injectMinHits,
      });
      if (injection.injectedCount > 0) {
        agent.inject(injection.text);
      }
    } catch {
      // injection is best-effort; never fail a step because of memory recall
    }
    return next();
  });
}
