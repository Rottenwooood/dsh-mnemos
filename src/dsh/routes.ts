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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { MemoryStore } from '../domain/store.js';
import type { MemoryService } from '../domain/service.js';
import type { MemoryInput } from '../domain/types.js';
import type { GitStore } from '../domain/gitstore.js';
import type { Config } from '../config.js';
import type { LlmRuntimeLike, LlmTarget } from './llm-adapter.js';
import { detectSource, parseAny } from '../domain/imports/detect.js';
import { extractCandidates } from '../domain/extract.js';
import { processImported } from '../domain/backfill.js';

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
  /** Live plugin config (import caller etc.). */
  getConfig: () => Config;
}

function json(res: Res, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const IMPORT_FILE_RE = /\.(?:jsonl|json|txt|md|zstd|ln)$/;

/** Recursively list transcript files under a directory, bounded to avoid runaway scans. */
function listImportFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(name));
    if (statSync(path).isFile() && IMPORT_FILE_RE.test(path)) {
      out.push(path);
      if (out.length >= 500) break;
    }
  }
  return out;
}

/** Read a transcript file, decompressing Zstandard DSH session logs (.zstd/.ln). */
function readTranscript(path: string): string {
  const buf = readFileSync(path);
  if (/\.(?:zstd|ln)$/.test(path)) {
    return decompressZstdMulti(buf);
  }
  return buf.toString('utf8');
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * DSH session logs are append-only: one zstd frame per appended batch, so a
 * file is many concatenated frames. `zstdDecompressSync` only yields the
 * first frame, so walk every magic and decompress each frame separately.
 */
function decompressZstdMulti(buf: Buffer): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor <= buf.length - ZSTD_MAGIC.length) {
    const found = buf.indexOf(ZSTD_MAGIC, cursor);
    if (found === -1) break;
    try {
      parts.push(zstdDecompressSync(buf.subarray(found)).toString('utf8'));
    } catch {
      // a corrupt or interrupted final frame is not a failed import
    }
    cursor = found + ZSTD_MAGIC.length;
  }
  return parts.join('\n');
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
        // Normalize empty query values to undefined: `?type=` (the client sends
        // it when the "all types" filter is selected) must mean "no filter",
        // not "type == ''", which would match nothing.
        const scope = url.searchParams.get('scope') || undefined;
        const workspace = url.searchParams.get('workspace') || undefined;
        const type = url.searchParams.get('type') || undefined;
        const status = url.searchParams.get('status') || 'active';
        if (status === 'deleted') {
          const rows = deps.service.listDeleted();
          json(res, 200, { count: rows.length, memories: rows });
          return;
        }
        if (status === 'all') {
          const rows = deps.store.listSummaries(scope === 'global' ? 'global' : 'workspace', workspace, undefined, type);
          json(res, 200, { count: rows.length, memories: rows });
          return;
        }
        const rows = deps.service.listActive(
          scope === 'global' ? 'global' : 'workspace',
          workspace,
          type,
        );
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
      if (method === 'POST' && route === '/memory/delete') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
          json(res, 400, { ok: false, reason: 'id is required' });
          return;
        }
        json(res, 200, deps.service.removeMemory(id));
        return;
      }
      if (method === 'POST' && route === '/memory/edit') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
          json(res, 400, { ok: false, reason: 'id is required' });
          return;
        }
        const patch: Partial<{ summary: string; detail: string }> = {};
        if (typeof body.summary === 'string') patch.summary = body.summary;
        if (typeof body.detail === 'string') patch.detail = body.detail;
        if (Object.keys(patch).length === 0) {
          json(res, 400, { ok: false, reason: 'summary or detail is required' });
          return;
        }
        json(res, 200, deps.service.editMemory(id, patch));
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
      if (method === 'GET' && route === '/usage') {
        const days = Number(url.searchParams.get('days') ?? 30);
        json(res, 200, deps.service.usageStats(Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30));
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
      if (route === '/import/sources') {
        json(res, 200, {
          sources: [
            { id: 'dsh', label: 'DSH 历史会话' },
            { id: 'claude-code', label: 'Claude Code' },
            { id: 'codex', label: 'Codex' },
            { id: 'chatgpt', label: 'ChatGPT' },
            { id: 'auto', label: '自动检测' },
          ],
        });
        return;
      }
      if (method === 'GET' && route === '/import/preview') {
        const dir = url.searchParams.get('dir');
        if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
          json(res, 400, { error: 'dir is required and must be a directory' });
          return;
        }
        const rows: unknown[] = [];
        const errors: string[] = [];
        let totalMessages = 0;
        let totalCandidates = 0;
        for (const file of listImportFiles(dir)) {
          try {
            const text = readTranscript(file);
            const source = detectSource(text);
            if (!source) continue;
            const messages = parseAny(text, source);
            const candidates = extractCandidates(messages, { scope: deps.getConfig().defaultScope }).length;
            totalMessages += messages.length;
            totalCandidates += candidates;
            rows.push({ path: file, source, messages: messages.length, candidates });
          } catch {
            errors.push(file);
          }
        }
        json(res, 200, { files: rows, totalFiles: rows.length, totalMessages, totalCandidates, errors });
        return;
      }
      if (method === 'POST' && route === '/import/run') {
        const body = await readJson(req);
        const dir = typeof body.dir === 'string' ? body.dir : '';
        if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
          json(res, 400, { error: 'dir is required and must be a directory' });
          return;
        }
        const config = deps.getConfig();
        const stats = {
          parsedMessages: 0,
          candidates: 0,
          committed: 0,
          proposed: 0,
          denied: 0,
          duplicateSkipped: 0,
        };
        const errors: string[] = [];
        for (const file of listImportFiles(dir)) {
          try {
            const text = readTranscript(file);
            const source = detectSource(text);
            if (!source) continue;
            const messages = parseAny(text, source);
            const s = processImported(deps.service, messages, {
              caller: config.importCaller,
              scope: config.defaultScope,
            });
            stats.parsedMessages += s.parsedMessages;
            stats.candidates += s.candidates;
            stats.committed += s.committed;
            stats.proposed += s.proposed;
            stats.denied += s.denied;
            stats.duplicateSkipped += s.duplicateSkipped;
          } catch {
            errors.push(file);
          }
        }
        json(res, 200, { ...stats, errors });
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
        const candidate = deps.store.getApproval(id);
        const edited =
          decision === 'approve' && body.edited && typeof body.edited === 'object' && candidate
            ? { ...(candidate.payload as Record<string, unknown>), ...(body.edited as Record<string, unknown>) }
            : undefined;
        json(res, 200, deps.service.approve(id, decision, edited as MemoryInput | undefined));
        return;
      }
      if (method === 'POST' && route === '/approve/batch') {
        const candidates = deps.store.listApprovals('proposed');
        const lowRisk = candidates.filter((c) => {
          if (c.kind !== 'memory') return false;
          const p = c.payload as { scope?: string; type?: string; confidence?: number };
          return p.scope === 'workspace' && p.type === 'project_fact' && (p.confidence ?? 0) >= 0.8;
        });
        let approved = 0;
        let failed = 0;
        for (const c of lowRisk) {
          const r = deps.service.approve(c.id, 'approve');
          if (r.ok) approved += 1;
          else failed += 1;
        }
        json(res, 200, { approved, skipped: candidates.length - lowRisk.length, failed });
        return;
      }
      if (method === 'GET' && route === '/history') {
        const state = url.searchParams.get('state') || 'rejected';
        const source = url.searchParams.get('source') || undefined;
        const rows = deps.store.listApprovals(state as never).filter(
          (r) => source === undefined || r.proposedBy === source,
        );
        json(res, 200, { state, count: rows.length, items: rows.map(approvalView) });
        return;
      }
      if (method === 'GET' && route === '/export') {
          const id = url.searchParams.get('id') || undefined;
        const ids = id ? [id] : deps.store.listSummaries(undefined, undefined, undefined, undefined).map((m) => m.id);
        const memories = ids
          .map((m) => deps.store.getMemory(m))
          .filter((m): m is NonNullable<typeof m> => m !== undefined);
        json(res, 200, {
          exportedAt: new Date().toISOString(),
          memories,
          rules: deps.store.listRules('approved'),
        });
        return;
      }
      if (method === 'GET' && route === '/cleanup') {
        const days = Number(url.searchParams.get('days') ?? 90);
        const ids = deps.service.listStale(Number.isFinite(days) && days > 0 ? days : 90);
        json(res, 200, { days: Number.isFinite(days) && days > 0 ? days : 90, count: ids.length, ids });
        return;
      }
      if (method === 'POST' && route === '/cleanup') {
        const body = await readJson(req);
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        let removed = 0;
        for (const id of ids) {
          const r = deps.service.removeMemory(id);
          if (r.ok) removed += 1;
        }
        json(res, 200, { removed, requested: ids.length });
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
        const id = url.searchParams.get('id') || undefined;
          json(res, 200, { history: await deps.gitStore.history(id) });
          return;
        }
        if (method === 'GET' && route === '/git/show') {
          const id = url.searchParams.get('id') ?? '';
          const sha = url.searchParams.get('sha') ?? '';
          if (!id || !sha) {
            json(res, 400, { error: 'id and sha are required' });
            return;
          }
          json(res, 200, { id, sha, content: (await deps.gitStore.showAt(sha, id)) ?? null });
          return;
        }
        if (method === 'POST' && route === '/git/rollback') {
          const body = await readJson(req);
          const id = typeof body.id === 'string' ? body.id : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (!id || !sha) {
            json(res, 400, { ok: false, reason: 'id and sha are required' });
            return;
          }
          json(res, 200, await deps.gitStore.rollback(id, sha));
          return;
        }
        if (method === 'POST' && route === '/git/restore') {
          const body = await readJson(req);
          const id = typeof body.id === 'string' ? body.id : '';
          if (!id) {
            json(res, 400, { ok: false, reason: 'id is required' });
            return;
          }
          json(res, 200, await deps.gitStore.restoreDeleted(id));
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
