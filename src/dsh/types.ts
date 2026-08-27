/**
 * Minimal, honest placeholder types for the DeepSeek Harness context surface
 * that dsh-mnemos consumes.
 *
 * The real `@deepseek-ai/dsh-*` packages are not published to npm, so these
 * interfaces describe only the seams we use, matching the documented extension
 * points (ctx.tools / ctx.commands / ctx.jobs / ctx.agents / ctx.sessions).
 * Once the harness types are available, delete `dsh.d.ts`'s augmentation and
 * depend on the real packages; the implementation only relies on these shapes.
 */
import type { Context } from '@deepseek-ai/cordis';

export type Caller = 'human' | 'model' | 'plugin';

/** Runtime information DSH passes to a tool invocation. */
export interface ToolRuntime {
  caller: Caller;
  sessionId?: string;
  workspace?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-schema-ish parameter description that joins prompt assembly. */
  parameters: Record<string, unknown>;
  /** Canonical output schema plus a pure Native render projection. */
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: string; text?: string; [key: string]: unknown }>;
    presentationMeta?: unknown;
  };
  execute(args: unknown, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown>;
}

export interface DshTools {
  register(tool: ToolDefinition): () => boolean;
}

export interface CommandRuntime {
  caller: Caller;
  sessionId?: string;
  workspace?: string;
  say(text: string): void;
}

/**
 * The real `@deepseek-ai/dsh-commands` command contract: the handler receives
 * ONE invocation object (not `(args, runtime)`) and must return a
 * `CommandResult`. The registry validates the return shape; anything else
 * throws "handler must return a CommandResult".
 */
export interface CommandInvocation {
  readonly commandId: unknown;
  readonly agent: {
    readonly id: string;
    readonly session?: { readonly id?: string; readonly header?: { readonly cwd?: string } };
  };
  /** Exact text after the command name, including separator whitespace. */
  readonly rawInput: string;
  readonly attachments: readonly unknown[];
  readonly signal: AbortSignal;
}

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string };

export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  name: string;
  /** Human-readable summary used in discovery UI. */
  description: string;
  /** Optional free-form input hint advertised to capable clients. */
  input?: { hint: string };
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

export interface DshCommands {
  register(command: CommandDefinition): () => boolean;
}

export interface JobDefinition {
  name: string;
  run(): Promise<unknown>;
}

export interface DshJobs {
  register(job: JobDefinition): () => boolean;
}

export interface DshAgent {
  id: string;
  sessionId: string;
  ctx: Context;
  /** Queue model-visible context for the next admitted request. */
  inject(content: unknown): void;
}

export interface DshAgents {
  get(id: string): DshAgent | undefined;
}

/** A durable entry appended to the session log and broadcast on session/event. */
export interface DshSessionEvent {
  type: string;
  sessionId?: string;
  index?: number;
  [key: string]: unknown;
}

export interface DshSessions {
  list(filter?: unknown): Array<{ id: string }>;
}

export interface LlmMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Placeholder for the harness LLM seam. The real `ctx.llm` is a streaming
 * adapter service; `createLlmFromContext` maps the surface dsh-mnemos needs
 * onto whatever is mounted. Refine against real types at integration time.
 */
export interface DshLlm {
  complete(messages: LlmMessageLike[]): Promise<string>;
}
