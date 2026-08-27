/**
 * Module augmentation bridging the DeepSeek Harness context surface onto the
 * vendored `@deepseek-ai/cordis` Context and Events.
 *
 * These are placeholder declarations (see types.ts). Delete this file once the
 * real `@deepseek-ai/dsh-*` packages are available and their own declaration
 * merging covers the same keys.
 */
import type {
  DshAgents,
  DshAgent,
  DshCommands,
  DshJobs,
  DshLlm,
  DshSessions,
  DshSessionEvent,
  DshTools,
} from './types.js';
import type { MemoryService } from '../domain/service.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: DshTools;
    commands: DshCommands;
    jobs: DshJobs;
    agents: DshAgents;
    sessions: DshSessions;
    /** The dsh-mnemos memory service (the approval-gated write path). */
    mnemos: MemoryService;
    /** The harness LLM seam, when an adapter is mounted. */
    llm?: DshLlm;
    /** Present only when the optional dsh-better-sidebar plugin is mounted. */
    betterSidebar?: unknown;
  }

  interface Events {
    /** Durable session events; see DshSessionEvent. */
    'session/event'(event: DshSessionEvent): void;
    /**
     * Waterfall deciding what the model sees; listeners must call next().
     * @mode waterfall
     */
    'agent/pre-step'(
      agent: DshAgent,
      input: unknown,
      next: () => Promise<unknown>,
    ): Promise<unknown>;
    /**
     * Waterfall before a model request is sent; listeners must call next().
     * @mode waterfall
     */
    'agent/request'(
      agent: DshAgent,
      request: unknown,
      next: () => Promise<unknown>,
    ): Promise<unknown>;
  }
}
