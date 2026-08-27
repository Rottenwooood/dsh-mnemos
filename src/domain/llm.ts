/**
 * LLM seam for the distillation pipeline (M2).
 *
 * dsh-mnemos never calls a provider directly; it depends on this narrow
 * interface so the pipeline is unit-testable with a fake, and the DSH adapter
 * (`src/dsh/llm-adapter.ts`) maps `ctx.llm` onto it once real types exist.
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface Llm {
  complete(messages: LlmMessage[]): Promise<string>;
}
