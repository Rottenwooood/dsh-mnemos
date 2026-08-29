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
  DshTools,
} from './types.js';
import type { MemoryService } from '../domain/service.js';
import type { MemoryBus, BusEvent } from '../domain/bus.js';
import type { GitStore } from '../domain/gitstore.js';
import type { SettingsServiceFace } from './settings.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: DshTools;
    commands: DshCommands;
    jobs: DshJobs;
    agents: DshAgents;
    sessions: DshSessions;
    /** The dsh-mnemos memory service (the approval-gated write path). */
    mnemos: MemoryService;
    /** The open memory bus: third-party plugins recall/record/subscribe. */
    mnemosBus: MemoryBus;
    /** Git versioning + sync for the memory mirror. */
    mnemosGit?: GitStore;
    /** The harness LLM seam, when an adapter is mounted. */
    llm?: DshLlm;
    /** The harness user-settings seam, when dsh-settings is mounted. */
    settings?: SettingsServiceFace;
    /** Present only when the optional dsh-better-sidebar plugin is mounted. */
    betterSidebar?: unknown;
    /** The harness skill registry, when a skill service is mounted. */
    skills?: {
      registerProvider(create: () => unknown): () => void;
    };
  }

  interface Events {
    /** Durable session feed: every appended event with the live session. */
    'session/event'(
      session: { id?: unknown; header?: { cwd?: unknown } },
      event: {
        type: string;
        seq?: number;
        time?: number;
        data?: {
          turn?: number;
          step?: number;
          role?: string;
          text?: string;
          message?: { role?: string; content?: unknown[] };
        };
      },
    ): void;
    /** Memory-bus change notifications (committed/proposed/replaced/revoked/rule-approved). */
    'mnemos/memory'(event: BusEvent): void;
    /**
     * Waterfall deciding the next step; listeners call next() then may return
     * `{ kind: 'enter', messages }` with injected UserMessages.
     * @mode waterfall
     */
    'agent/pre-step'(
      payload: { agent: DshAgent; messages: unknown[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<unknown>,
    ): Promise<unknown>;
    /**
     * Waterfall configuring a model call; listeners call next() and may
     * adjust the LlmCallConfig (provider/model/parameters only — no content).
     * @mode waterfall
     */
    'agent/request'(
      payload: { agent: DshAgent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<unknown>,
    ): Promise<unknown>;
  }
}
