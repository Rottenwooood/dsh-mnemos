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
  run(args: Record<string, unknown>, runtime: ToolRuntime): Promise<unknown>;
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

export interface CommandDefinition {
  name: string;
  usage: string;
  description?: string;
  handler(args: string, runtime: CommandRuntime): void | Promise<void>;
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
