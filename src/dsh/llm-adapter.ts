/**
 * Adapter from the harness LLM seam to the distillation pipeline's `Llm`.
 *
 * The harness agent is already configured (provider + model, defaulted by the
 * `agent-default-model` settings section), so dsh-mnemos never asks for its own
 * API key: it streams through `ctx.llm.stream()` with the DSH-configured
 * provider/model, resolving the target as the plugin's `llmProvider`/`llmModel`
 * settings first, then DSH's default. The seam is optional (headless profiles
 * may carry no llm service), read through `ctx.get('llm')` per the harness
 * optional-service convention, and the DSH types are consumed structurally.
 */
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { Llm, LlmMessage } from '../domain/llm.js';

/** Structural face of the llm service (`ctx.get('llm')`). */
export interface LlmRuntimeLike {
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    system?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<{
    type: string;
    text?: string;
    reason?: { kind?: string };
  }>;
}

/** One resolved model target for distillation. */
export interface LlmTarget {
  provider: string;
  model: string;
}

/** Options for {@link createLlmFromContext}. */
export interface LlmAdapterOptions {
  /** Resolve the provider/model target; undefined means no LLM is usable. */
  resolveTarget: () => Promise<LlmTarget | undefined>;
  /** Optional system prompt prepended to the distilled request. */
  system?: string;
}

/** Map one LlmMessage to the harness Message shape (structural). */
function toHarnessMessage(message: LlmMessage): unknown {
  return {
    id: randomUUID(),
    role: message.role === 'tool' ? 'user' : message.role,
    content: [{ type: 'text', text: message.content }],
    source: { kind: 'plugin', plugin: 'dsh-mnemos' },
  };
}

export function createLlmFromContext(ctx: Context, opts: LlmAdapterOptions): Llm | undefined {
  const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as LlmRuntimeLike | undefined;
  if (!llm || typeof llm.stream !== 'function') {
    return undefined;
  }
  return {
    async complete(messages: LlmMessage[]): Promise<string> {
      const target = await opts.resolveTarget();
      if (target === undefined) {
        throw new Error('dsh-mnemos: no LLM provider/model — configure llmProvider/llmModel or DSH agent-default-model');
      }
      const system = [...messages.filter((m) => m.role === 'system').map((m) => m.content), opts.system]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');
      const harnessMessages = messages.filter((m) => m.role !== 'system').map(toHarnessMessage);
      let text = '';
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        messages: harnessMessages,
        ...(system.length > 0 ? { system } : {}),
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
        }
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(`dsh-mnemos: llm stream failed (${target.provider}/${target.model})`);
        }
      }
      return text;
    },
  };
}
