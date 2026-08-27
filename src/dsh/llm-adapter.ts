/**
 * Adapter from the harness LLM seam to the distillation pipeline's `Llm`.
 *
 * This is a placeholder mapping over `ctx.llm` (see types.ts / dsh.d.ts). The
 * real `ctx.llm` is a streaming adapter service; this narrows the surface
 * dsh-mnemos needs and degrades to `undefined` when no adapter is mounted so
 * distillation can report "LLM unavailable" instead of failing hard.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Llm, LlmMessage } from '../domain/llm.js';
import type { DshLlm } from './types.js';

export function createLlmFromContext(ctx: Context): Llm | undefined {
  const llm = ctx.llm as DshLlm | undefined;
  if (!llm || typeof llm.complete !== 'function') {
    return undefined;
  }
  return {
    async complete(messages: LlmMessage[]): Promise<string> {
      return llm.complete(messages);
    },
  };
}
