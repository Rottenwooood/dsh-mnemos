/**
 * Model-facing tools for dsh-mnemos.
 *
 * Every write path goes through MemoryService (the approval gate). The model
 * can propose memories and read/search them, but never bypasses governance.
 *
 * The tools are built against the real `@deepseek-ai/dsh-tools`
 * `ToolDefinition` contract (name/description/parameters + mandatory
 * `output { schema, render, presentationMeta? }` + `execute`). The real
 * registry validates that contract at registration; this module constructs
 * the objects structurally and does not hard-depend on the package, so the
 * plugin's own install stays dependency-free (the profile provides it).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from '../domain/service.js';
import type { MemoryScope, MemoryType } from '../domain/types.js';
import type { Caller, ToolDefinition } from './types.js';
import type { Llm } from '../domain/llm.js';
import { runDistillIncremental, DistillCursor } from '../domain/distill.js';
import type { SignalCollector } from './hooks.js';

export interface ToolDeps {
  service: MemoryService;
  llm?: Llm;
  collector?: SignalCollector;
  /** Mutable distill cursor holder shared with the manual/auto distill paths. */
  cursor: { current: DistillCursor };
  persistCursor: (cursor: DistillCursor) => void;
}

const SCOPES = new Set<MemoryScope>(['global', 'workspace']);
const TYPES = new Set<MemoryType>([
  'project_fact',
  'procedure',
  'preference',
  'error_fix',
  'decision',
]);

/** A `{ type: 'text' }` content block as the real harness renders it. */
interface ContentBlock {
  type: 'text';
  text: string;
}

/** Structural face of the executing agent the tool registry hands to tools. */
interface ToolAgentLike {
  readonly id?: string;
  readonly session?: {
    readonly id?: string;
    readonly header?: { readonly cwd?: string };
  };
}

/** Structural face of `ToolRunContext` — only the fields the tools read. */
interface ToolExecLike {
  readonly agent?: ToolAgentLike;
  readonly signal?: AbortSignal;
}

/** Structural `ToolDefinition` mirror used to build the registered tools. */
interface MnemosTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return fallback;
}

function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }];
}

/** Workspace (cwd) of the calling agent, when the agent carries a session. */
function workspaceOf(exec: ToolExecLike): string | undefined {
  return exec.agent?.session?.header?.cwd;
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  const { service, llm, collector, cursor, persistCursor } = deps;
  const search: MnemosTool = {
    name: 'memory_search',
    description:
      'Search previously remembered facts across sessions. Returns matching memory entries with their source session and cross-session hit count.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (FTS5 full-text).' },
        scope: { type: 'string', enum: [...SCOPES], description: 'global or workspace (default workspace).' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'scope', 'hits'],
        properties: {
          query: { type: 'string' },
          scope: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'topic', 'summary', 'type', 'scope'],
              properties: {
                id: { type: 'string' },
                topic: { type: 'string' },
                summary: { type: 'string' },
                type: { type: 'string' },
                scope: { type: 'string' },
                workspace: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                crossSessionHits: { type: 'number' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const hits = (value as { hits: Array<{ topic: string; summary: string }> }).hits;
        return text(
          hits.length === 0
            ? 'memory_search: no matches.'
            : `memory_search: ${hits.length} match(es).\n${hits.map((h) => `- ${h.topic}: ${h.summary}`).join('\n')}`,
        );
      },
    },
    execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
      const a = args as { query?: unknown; scope?: unknown; limit?: unknown };
      const query = asString(a.query);
      if (!query) {
        throw new Error('query is required');
      }
      const scope = asString(a.scope);
      const limit = asNumber(a.limit, 10);
      const rows = service.search(query, limit);
      return Promise.resolve({
        query,
        scope: scope ?? 'workspace',
        hits: rows.map((r) => ({
          id: r.id,
          topic: r.topic,
          summary: r.summary,
          type: r.type,
          scope: r.scope,
          workspace: r.workspace ?? null,
          crossSessionHits: r.crossSessionHits,
          updatedAt: r.updatedAt,
        })),
      });
    },
  };

  const record: MnemosTool = {
    name: 'memory_record',
    description:
      'Propose a memory entry. Include "keywords": 2-5 short discriminative terms or phrases the user would type verbatim later (e.g. "pnpm", "deploy to us-east-1") — they drive automatic keyword-triggered injection. The write goes through an approval gate: sensitive content, duplicates, budget and scope policy are checked, low-risk project facts may auto-approve, everything else is queued for the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short normalized title of the memory.' },
        summary: { type: 'string', description: 'One-sentence fact to remember.' },
        detail: { type: 'string', description: 'Optional longer context.' },
        keywords: { type: 'string', description: 'Comma-separated keywords that trigger injection (2-5 short terms).' },
        type: { type: 'string', enum: [...TYPES], description: 'Default project_fact.' },
        scope: { type: 'string', enum: [...SCOPES], description: 'Default workspace.' },
        confidence: { type: 'number', description: '0..1, default 0.9.' },
      },
      required: ['topic', 'summary'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['outcome', 'reason', 'memoryId', 'approvalId', 'auditId'],
        properties: {
          outcome: { type: 'string' },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          memoryId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          approvalId: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          auditId: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { outcome: string; reason: string | null; memoryId: string | null };
        return text(
          `memory_record: ${v.outcome}${v.reason ? ` (${v.reason})` : ''}${v.memoryId ? ` id=${v.memoryId}` : ''}`,
        );
      },
    },
    execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
      const a = args as {
        topic?: unknown;
        summary?: unknown;
        detail?: unknown;
        keywords?: unknown;
        type?: unknown;
        scope?: unknown;
        confidence?: unknown;
      };
      const topic = asString(a.topic);
      const summary = asString(a.summary);
      if (!topic || !summary) {
        throw new Error('topic and summary are required');
      }
      const scope = (asString(a.scope) ?? 'workspace') as MemoryScope;
      const type = (asString(a.type) ?? 'project_fact') as MemoryType;
      const caller: Caller = 'model';
      const sessionId = exec.agent?.id ?? exec.agent?.session?.id;
      const keywords = asString(a.keywords)
        ?.split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 8);
      const result = service.add(
        {
          type,
          scope,
          workspace: scope === 'workspace' ? workspaceOf(exec) : undefined,
          topic,
          summary,
          detail: asString(a.detail),
          keywords,
          evidence:
            sessionId !== undefined
              ? [{ sessionId, eventRange: [0, 0], quote: summary }]
              : [],
          confidence: asNumber(a.confidence, 0.9),
          source: 'manual',
          writer: caller,
        },
        caller,
      );
      return Promise.resolve({
        outcome: result.outcome,
        reason: result.reason ?? null,
        memoryId: result.memory?.id ?? null,
        approvalId: result.approvalId ?? null,
        auditId: result.auditId,
      });
    },
  };

  const list: MnemosTool = {
    name: 'memory_list',
    description: 'List active memory entries, filtered by scope/workspace/type.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: [...SCOPES] },
        workspace: { type: 'string' },
        type: { type: 'string', enum: [...TYPES] },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'memories'],
        properties: {
          count: { type: 'number' },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'topic', 'summary', 'type', 'scope'],
              properties: {
                id: { type: 'string' },
                topic: { type: 'string' },
                summary: { type: 'string' },
                type: { type: 'string' },
                scope: { type: 'string' },
                workspace: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                crossSessionHits: { type: 'number' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { count: number; memories: Array<{ topic: string; summary: string }> };
        return text(
          `memory_list: ${v.count} active entr${v.count === 1 ? 'y' : 'ies'}.\n${v.memories
            .map((m) => `- ${m.topic}: ${m.summary}`)
            .join('\n')}`,
        );
      },
    },
    execute(args: unknown): Promise<unknown> {
      const a = args as { scope?: unknown; workspace?: unknown; type?: unknown };
      const scope = asString(a.scope) as MemoryScope | undefined;
      const workspace = asString(a.workspace);
      const rows = service.listActive(scope, workspace);
      const type = asString(a.type);
      const filtered = type ? rows.filter((r) => r.type === type) : rows;
      return Promise.resolve({
        count: filtered.length,
        memories: filtered.map((r) => ({
          id: r.id,
          topic: r.topic,
          summary: r.summary,
          type: r.type,
          scope: r.scope,
          workspace: r.workspace ?? null,
          crossSessionHits: r.crossSessionHits,
          updatedAt: r.updatedAt,
        })),
      });
    },
  };

  const stats: MnemosTool = {
    name: 'memory_stats',
    description: 'Report memory store statistics: counts by scope/type/status.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['totalActive', 'byScope', 'byType', 'gate'],
        properties: {
          totalActive: { type: 'number' },
          byScope: { type: 'object' },
          byType: { type: 'object' },
          gate: {
            type: 'object',
            additionalProperties: false,
            required: ['maxEntries', 'autoApprove'],
            properties: {
              maxEntries: { type: 'number' },
              autoApprove: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { totalActive: number; byScope: Record<string, number>; byType: Record<string, number> };
        return text(
          `memory_stats: ${v.totalActive} active; byScope=${JSON.stringify(v.byScope)}; byType=${JSON.stringify(v.byType)}`,
        );
      },
    },
    execute(): Promise<unknown> {
      const active = service.listActive();
      const byScope = new Map<string, number>();
      const byType = new Map<string, number>();
      for (const m of active) {
        byScope.set(m.scope, (byScope.get(m.scope) ?? 0) + 1);
        byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
      }
      return Promise.resolve({
        totalActive: active.length,
        byScope: Object.fromEntries(byScope),
        byType: Object.fromEntries(byType),
        gate: {
          maxEntries: service.config.maxEntries,
          autoApprove: service.config.autoApprove,
        },
      });
    },
  };

  const distill: MnemosTool = {
    name: 'memory_distill',
    description:
      'Distill the buffered recent conversation into memory and rule candidates. Call this when the user says to remember/record something, or when a reusable workflow/preference emerged. The LLM writes each memory\'s "keywords" — 2-5 short discriminative terms or phrases the user would type verbatim later (e.g. "pnpm", "deploy to us-east-1") — which drive automatic keyword-triggered injection. Candidates flow through the approval gate.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['requested', 'memories', 'rules', 'conflicts', 'dropped'],
        properties: {
          requested: { type: 'number' },
          memories: { type: 'number' },
          rules: { type: 'number' },
          conflicts: { type: 'number' },
          dropped: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { memories: number; rules: number; conflicts: number; dropped: number };
        return text(
          `memory_distill: ${v.memories} memory, ${v.rules} rule, ${v.conflicts} conflict, ${v.dropped} dropped`,
        );
      },
    },
    async execute(_args, exec: ToolExecLike): Promise<unknown> {
      if (!llm) {
        throw new Error('LLM unavailable; distillation is disabled until a model adapter is mounted.');
      }
      const messages = collector ? collector.drain() : [];
      if (messages.length === 0) {
        return { requested: 0, memories: 0, rules: 0, conflicts: 0, dropped: 0 };
      }
      const workspace = exec.agent?.session?.header?.cwd;
      const sessionId = exec.agent?.id ?? exec.agent?.session?.id;
      const result = await runDistillIncremental(llm, service, messages, cursor.current, {
        scope: workspace ? 'workspace' : 'global',
        workspace,
        sessionId,
      });
      cursor.current = result.cursor;
      persistCursor(result.cursor);
      return {
        requested: result.stats.requested,
        memories: result.stats.memories,
        rules: result.stats.rules,
        conflicts: result.stats.conflicts,
        dropped: result.stats.dropped,
      };
    },
  };

  for (const tool of [search, record, list, stats, distill]) {
    ctx.effect(() => ctx.tools.register(tool as unknown as ToolDefinition));
  }
}
