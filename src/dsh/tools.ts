/**
 * Model-facing tools for dsh-mnemos.
 *
 * Every write path goes through MemoryService (the approval gate). The model
 * can propose memories and read/search them, but never bypasses governance.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from '../domain/service.js';
import type { MemoryScope, MemoryType } from '../domain/types.js';
import type { Caller, ToolDefinition } from './types.js';

const SCOPES = new Set<MemoryScope>(['global', 'workspace']);
const TYPES = new Set<MemoryType>([
  'project_fact',
  'procedure',
  'preference',
  'error_fix',
  'decision',
]);

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

export function registerTools(ctx: Context, service: MemoryService): void {
  const search: ToolDefinition = {
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
    async run(args, runtime) {
      const query = asString(args.query);
      if (!query) {
        return { error: 'query is required' };
      }
      const scope = asString(args.scope);
      const limit = asNumber(args.limit, 10);
      const rows = service.search(query, limit);
      return {
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
      };
    },
  };

  const record: ToolDefinition = {
    name: 'memory_record',
    description:
      'Propose a memory entry. The write goes through an approval gate: sensitive content, duplicates, budget and scope policy are checked, low-risk project facts may auto-approve, everything else is queued for the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short normalized title of the memory.' },
        summary: { type: 'string', description: 'One-sentence fact to remember.' },
        detail: { type: 'string', description: 'Optional longer context.' },
        type: { type: 'string', enum: [...TYPES], description: 'Default project_fact.' },
        scope: { type: 'string', enum: [...SCOPES], description: 'Default workspace.' },
        confidence: { type: 'number', description: '0..1, default 0.9.' },
      },
      required: ['topic', 'summary'],
    },
    async run(args, runtime) {
      const topic = asString(args.topic);
      const summary = asString(args.summary);
      if (!topic || !summary) {
        return { error: 'topic and summary are required' };
      }
      const scope = (asString(args.scope) ?? 'workspace') as MemoryScope;
      const type = (asString(args.type) ?? 'project_fact') as MemoryType;
      const caller = (runtime.caller ?? 'model') as Caller;
      const result = service.add(
        {
          type,
          scope,
          workspace: scope === 'workspace' ? runtime.workspace : undefined,
          topic,
          summary,
          detail: asString(args.detail),
          evidence:
            runtime.sessionId && caller !== 'plugin'
              ? [{ sessionId: runtime.sessionId, eventRange: [0, 0], quote: summary }]
              : [],
          confidence: asNumber(args.confidence, 0.9),
          source: caller === 'model' ? 'manual' : 'third_party',
          writer: caller,
        },
        caller,
      );
      return {
        outcome: result.outcome,
        reason: result.reason ?? null,
        memoryId: result.memory?.id ?? null,
        approvalId: result.approvalId ?? null,
        auditId: result.auditId,
      };
    },
  };

  const list: ToolDefinition = {
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
    async run(args) {
      const scope = asString(args.scope) as MemoryScope | undefined;
      const workspace = asString(args.workspace);
      const rows = service.listActive(scope, workspace);
      const type = asString(args.type);
      const filtered = type ? rows.filter((r) => r.type === type) : rows;
      return {
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
      };
    },
  };

  const stats: ToolDefinition = {
    name: 'memory_stats',
    description: 'Report memory store statistics: counts by scope/type/status.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const active = service.listActive();
      const byScope = new Map<string, number>();
      const byType = new Map<string, number>();
      for (const m of active) {
        byScope.set(m.scope, (byScope.get(m.scope) ?? 0) + 1);
        byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
      }
      return {
        totalActive: active.length,
        byScope: Object.fromEntries(byScope),
        byType: Object.fromEntries(byType),
        gate: {
          maxEntries: service.config.maxEntries,
          autoApprove: service.config.autoApprove,
        },
      };
    },
  };

  for (const tool of [search, record, list, stats]) {
    ctx.effect(() => ctx.tools.register(tool));
  }
}
