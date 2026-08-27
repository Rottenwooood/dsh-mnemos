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
import type { ImportedMessage } from '../domain/imports/types.js';

const REMEMBER_RE = /(?:^|[^\p{L}])(记住|记得|remember)(?:[^\p{L}]|$)/iu;

export class SignalCollector {
  private readonly cursor = new Map<string, number>();
  private readonly buffer: ImportedMessage[] = [];

  constructor(
    private readonly log: (message: string) => void,
    private readonly maxBuffer = 200,
  ) {}

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
        `dsh-mnemos: remember-signal in session ${event.sessionId} at index ${event.index} buffered for distillation`,
      );
    }
    const role = event.type === 'user/message' ? 'user' : 'assistant';
    this.buffer.push({ role, text, sessionId: event.sessionId, index: event.index });
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
  ctx.on('session/event', (event) => collector.onEvent(event));
}

/**
 * Cold/hot layered injection (M1): on each agent step, build the hot-layer
 * projection under the hard byte budget and queue it into the same request via
 * `agent.inject()` — no second API call. The waterfall always delegates with
 * next().
 */
export function registerInjection(ctx: Context, service: MemoryService, getConfig: () => Config): void {
  ctx.on('agent/pre-step', async (agent, _input, next) => {
    try {
      const config = getConfig();
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

/**
 * Rule effect (M2): inject approved rules into agent/request with a marker, so
 * the model sees the standing preferences/instructions the user approved. The
 * waterfall always delegates with next().
 */
export function registerRuleInjection(ctx: Context, service: MemoryService, getConfig: () => Config): void {
  ctx.on('agent/request', async (agent, _request, next) => {
    try {
      if (!getConfig().rulesInjectEnabled) {
        return next();
      }
      const rules = service.listRules('approved');
      if (rules.length > 0) {
        agent.inject(
          `# dsh-mnemos 生效规则\n${rules.map((r) => `- [${r.kind}] ${r.text}`).join('\n')}`,
        );
      }
    } catch {
      // rule injection is best-effort; never fail a request
    }
    return next();
  });
}
