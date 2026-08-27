/**
 * Adapter from the harness LLM seam to the distillation pipeline's `Llm`.
 *
 * `ctx.llm` is an optional harness service; the strict cordis property proxy
 * refuses undeclared access, so it is read through `ctx.get('llm')` (the
 * optional-service read, per harness convention) and degrades to `undefined`
 * when no adapter is mounted so distillation can report "LLM unavailable"
 * instead of failing hard.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Llm, LlmMessage } from '../domain/llm.js';
import type { DshLlm } from './types.js';

export function createLlmFromContext(ctx: Context): Llm | undefined {
  const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as DshLlm | undefined;
  if (!llm || typeof llm.complete !== 'function') {
    return undefined;
  }
  return {
    async complete(messages: LlmMessage[]): Promise<string> {
      return llm.complete(messages);
    },
  };
}
