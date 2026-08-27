/**
 * Host RPC routes backing the better-sidebar management tab (M5).
 *
 * Registers `/mnemos/api/*` on the harness `webServer` when a web profile
 * mounts one (headless/non-web profiles never see a webServer, so the routes
 * are skipped). The client half fetches these same-origin endpoints to render
 * the memory console; every action goes through the same MemoryService gate
 * and GitStore as the /mnemos command, so the browser can never bypass
 * governance. Responses are lossless JSON.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryStore } from '../domain/store.js';
import type { MemoryService } from '../domain/service.js';
import type { GitStore } from '../domain/gitstore.js';
import type { LlmRuntimeLike, LlmTarget } from './llm-adapter.js';

/** Structural face of the node IncomingMessage/ServerResponse the routes use. */
type Req = IncomingMessage;

type Res = ServerResponse;

/** Everything the routes need; the plugin owns the closures. */
export interface MnemosRouteDeps {
  store: MemoryStore;
  service: MemoryService;
  gitStore?: GitStore;
  /** Manual distillation trigger ("现在提炼"); null when no LLM adapter is mounted. */
  runDistillNow: () => Promise<{ memories: number; rules: number; conflicts: number } | null>;
  /** The harness llm service (optional; absent in llm-less profiles). */
  llm?: LlmRuntimeLike;
  /** Resolve the plugin's distillation model target (DSH default fallback). */
  resolveModel: () => Promise<LlmTarget | undefined>;
}

function json(res: Res, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req: Req): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (body.length === 0) return {};
  return JSON.parse(body) as Record<string, unknown>;
}

/** Serialize one approval candidate for the wire (payload is JSON-compatible). */
function approvalView(c: {
  id: number;
  kind: string;
  payload: unknown;
  proposedBy: string;
  evidence: unknown[];
  createdAt: string;
}): unknown {
  return {
    id: c.id,
    kind: c.kind,
    proposedBy: c.proposedBy,
    evidence: c.evidence,
    createdAt: c.createdAt,
    payload: c.payload,
  };
}

/** Build the `/mnemos/api` request handler. */
export function createMnemosRouteHandler(deps: MnemosRouteDeps): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice('/mnemos/api'.length);
    try {
      const method = req.method ?? 'GET';
      if (method === 'GET' && route === '/pending') {
        const rows = deps.store.listApprovals('proposed');
        json(res, 200, { pending: rows.map(approvalView) });
        return;
      }
      if (method === 'GET' && route === '/memories') {
        const scope = url.searchParams.get('scope') ?? undefined;
        const workspace = url.searchParams.get('workspace') ?? undefined;
        const rows = deps.service.listActive(scope === 'global' ? 'global' : 'workspace', workspace ?? undefined);
        json(res, 200, { count: rows.length, memories: rows });
        return;
      }
      if (method === 'GET' && route === '/search') {
        const q = url.searchParams.get('q') ?? '';
        if (q.length === 0) {
          json(res, 200, { query: q, hits: [] });
          return;
        }
        const hits = deps.service.search(q, 20);
        json(res, 200, { query: q, hits });
        return;
      }
      if (method === 'GET' && route === '/stats') {
        const active = deps.service.listActive();
        json(res, 200, {
          totalActive: active.length,
          pending: deps.store.listApprovals('proposed').length,
          gate: { maxEntries: deps.service.config.maxEntries, autoApprove: deps.service.config.autoApprove },
        });
        return;
      }
      if (method === 'GET' && route === '/models') {
        const dflt = await deps.resolveModel().catch(() => undefined);
        const llm = deps.llm as (LlmRuntimeLike & {
          listProviders?(): Array<{ id: string; name?: string }>;
          listModels?(provider: string): Promise<Array<{ id: string; name?: string }>>;
        }) | undefined;
        const providers: unknown[] = [];
        if (llm) {
          for (const provider of llm.listProviders?.() ?? []) {
            let models: string[] = [];
            try {
              const listed = llm.listModels?.(provider.id) ?? Promise.resolve([]);
              // An unqueryable provider endpoint must never stall the page:
              // race the directory read against a short budget and degrade.
              const rows = await Promise.race([
                listed,
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error('model discovery timed out')), 3000);
                }),
              ]);
              models = rows.map((m) => m.id).slice(0, 50);
            } catch {
              // an unqueryable provider endpoint degrades to no advertised models
            }
            providers.push({ id: provider.id, name: provider.name ?? provider.id, models });
          }
        }
        json(res, 200, { default: dflt ?? null, providers });
        return;
      }
      if (method === 'POST' && route === '/approve') {
        const body = await readJson(req);
        const id = Number(body.approvalId);
        if (!Number.isInteger(id) || id <= 0) {
          json(res, 400, { ok: false, reason: 'approvalId is required' });
          return;
        }
        const decision = body.decision === 'reject' ? 'reject' : 'approve';
        json(res, 200, deps.service.approve(id, decision));
        return;
      }
      if (method === 'POST' && route === '/distill') {
        const result = await deps.runDistillNow();
        json(res, 200, result ?? { error: 'LLM unavailable' });
        return;
      }
      if (route.startsWith('/git/')) {
        if (!deps.gitStore) {
          json(res, 404, { error: 'git versioning disabled' });
          return;
        }
        if (method === 'GET' && route === '/git/status') {
          json(res, 200, await deps.gitStore.status());
          return;
        }
        if (method === 'GET' && route === '/git/history') {
          const id = url.searchParams.get('id') ?? undefined;
          json(res, 200, { history: await deps.gitStore.history(id) });
          return;
        }
        if (method === 'POST' && route === '/git/push') {
          json(res, 200, await deps.gitStore.push());
          return;
        }
        if (method === 'POST' && route === '/git/pull') {
          json(res, 200, await deps.gitStore.pull());
          return;
        }
        if (method === 'POST' && route === '/git/backup') {
          const body = await readJson(req);
          const out = typeof body.out === 'string' && body.out.length > 0 ? body.out : '/tmp/mnemos-backup.bundle';
          await deps.gitStore.exportBundle(out);
          json(res, 200, { bundle: out });
          return;
        }
        json(res, 404, { error: `unknown git route ${route}` });
        return;
      }
      json(res, 404, { error: `unknown route ${route}` });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Register the routes while a webServer service is mounted. Optional-service
 * wiring: the registration rides the inject fiber, so it unwinds when the
 * webServer (or this plugin) unloads, and nothing registers on non-web
 * profiles.
 * @param ctx - the plugin context.
 * @param deps - route dependencies.
 */
export function registerMnemosRoutes(ctx: Context, deps: MnemosRouteDeps): void {
  const inject = (ctx as unknown as { inject?: (names: string[], cb: (sctx: Context) => void) => void }).inject;
  if (typeof inject !== 'function') {
    return;
  }
  inject(['webServer'], (sctx) => {
    const webServer = (sctx as unknown as {
      webServer: { register(route: { kind: string; path: string; handler: (req: Req, res: Res) => void | Promise<void> }): () => void };
    }).webServer;
    const off = webServer.register({
      kind: 'prefix',
      path: '/mnemos/api',
      handler: createMnemosRouteHandler(deps),
    });
    sctx.effect(() => off);
  });
}
