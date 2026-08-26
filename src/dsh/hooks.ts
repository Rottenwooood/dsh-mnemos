/**
 * Session-signal collection (M0 minimal).
 *
 * Listens to durable session/event facts and maintains a per-session cursor so
 * later milestones can extract memories incrementally without reprocessing
 * older messages. M0 only detects high-value signals (explicit "remember"
 * requests) and logs them; the extraction pipeline lands in M2.
 */
import type { Context } from '@deepseek-ai/cordis';
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
