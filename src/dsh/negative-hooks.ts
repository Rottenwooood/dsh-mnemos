/**
 * Negative-memory hooks (P2): intercept tool execution.
 *
 * tools/execute  — on a command-tool failure, record a negative memory keyed by
 *                  (tool, cwd, command); on success, resolve the matching one.
 * tools/pre-execute — before a command runs, if an active negative memory
 *                  matches, deny up front with the stored evidence so the model
 *                  changes approach instead of repeating a known failure.
 *
 * The two real contracts are structural (see @deepseek-ai/dsh-tools):
 *   tools/execute(exec, next) -> ToolExecutionResult  ({ isError, error?, ... })
 *   tools/pre-execute(exec, next) -> PreToolDecision  ({ kind: 'allow'|'deny'|'ask', ... })
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config.js';
import { NegativeMemoryStore, negativeFingerprint } from '../domain/negative.js';

interface ToolExecLike {
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: { session?: { header?: { cwd?: string } } };
}

/** Extract the command string from a command-like tool's parsed arguments. */
function commandOf(exec: ToolExecLike): string | undefined {
  const args = exec.arguments as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object') return undefined;
  for (const key of ['command', 'cmd', 'script', 'shellCommand']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

const COMMAND_TOOLS = new Set(['bash', 'run_code', 'sh', 'shell', 'terminal', 'exec']);

export interface NegativeHooksDeps {
  store: NegativeMemoryStore;
  getConfig: () => Config;
}

export function registerNegativeMemory(ctx: Context, deps: NegativeHooksDeps): void {
  const { store, getConfig } = deps;
  // The dsh-tools events aren't in cordis's base event map; drive them through
  // a structural face (same pattern as every other seam in this plugin).
  const c = ctx as unknown as {
    on(name: 'tools/execute', cb: (exec: ToolExecLike, next: () => Promise<unknown>) => Promise<unknown>): () => void;
    on(name: 'tools/pre-execute', cb: (exec: ToolExecLike, next: () => Promise<{ kind: string }>) => Promise<unknown>): () => void;
  };

  c.on('tools/execute', async (exec, next) => {
    const result = (await next()) as { isError?: boolean; error?: { message?: string } };
    const cmd = commandOf(exec);
    if (!cmd || !COMMAND_TOOLS.has(exec.name)) {
      return result;
    }
    const cwd = exec.agent?.session?.header?.cwd;
    const fp = negativeFingerprint(exec.name, cwd, cmd);
    if (result.isError) {
      const evidence = result.error?.message ?? 'tool call failed';
      store.record({
        fingerprint: fp,
        kind: 'command',
        claim: cmd.slice(0, 200),
        evidence: evidence.slice(0, 500),
        ttlMs: getConfig().negativeMemoryTtlMs,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      store.resolve(fp);
    }
    return result;
  });

  c.on('tools/pre-execute', async (exec, next) => {
    const cmd = commandOf(exec);
    if (!cmd || !COMMAND_TOOLS.has(exec.name)) {
      return next();
    }
    store.expire(Date.now());
    if (!getConfig().negativeMemoryEnabled) {
      return next();
    }
    const cwd = exec.agent?.session?.header?.cwd;
    const neg = store.findActive(negativeFingerprint(exec.name, cwd, cmd));
    if (neg) {
      return { kind: 'deny', reason: `此命令已知失败（dsh-mnemos 负面记忆，等待 TTL 失效）：${neg.evidence}` };
    }
    return next();
  });
}
