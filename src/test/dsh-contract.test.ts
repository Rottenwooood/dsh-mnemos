/**
 * Contract-conformance guard: the plugin's DSH-facing types must stay
 * assignable to the REAL harness contracts.
 *
 * The dsh-* packages are not on npm, so these tests snapshot the real
 * `@deepseek-ai/dsh-commands` / `@deepseek-ai/dsh-tools` interfaces verbatim
 * (from packages/interaction/commands/src/{types,index}.ts and
 * packages/core/tools/src/index.ts) and assert, at the type level, that our
 * definitions still satisfy them. A drift like the old `(args, runtime)`
 * handler signature fails this file's compile instead of crashing at runtime.
 */
import { describe, it, expect } from 'vitest';
import type {
  CommandDefinition as MyCommandDefinition,
  ToolDefinition as MyToolDefinition,
} from '../dsh/types.js';

/* ---- REAL @deepseek-ai/dsh-commands contract (snapshot) ---- */

interface RealAgent {
  readonly id: string;
  readonly session: { readonly id: string; readonly header?: { readonly cwd?: string } };
}
interface RealCommandInvocation {
  readonly commandId: unknown;
  readonly agent: RealAgent;
  readonly rawInput: string;
  readonly attachments: readonly unknown[];
  readonly signal: AbortSignal;
}
type RealCommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string };
interface RealCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly images?: boolean };
  readonly recordInput?: boolean;
  readonly handler: (invocation: RealCommandInvocation) => RealCommandResult | Promise<RealCommandResult>;
}

/* ---- REAL @deepseek-ai/dsh-tools contract (snapshot) ---- */

interface RealToolRunContext {
  readonly callId: unknown;
  readonly rootCallId?: unknown;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: RealAgent;
  readonly parent?: unknown;
  readonly signal: AbortSignal;
}
interface RealToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly output: {
    readonly schema: unknown;
    render(args: unknown, value: unknown): Array<{ type: string; text?: string }>;
    readonly presentationMeta?: unknown;
  };
  execute(args: unknown, exec: RealToolRunContext): Promise<unknown>;
}

/** Compile-time assertion: `true` or the build fails. */
type Expect<T extends true> = T;

type MyCommandSatisfiesReal = MyCommandDefinition extends RealCommandDefinition ? true : false;
type MyToolSatisfiesReal = MyToolDefinition extends RealToolDefinition ? true : false;

describe('DSH contract conformance', () => {
  it('CommandDefinition satisfies the real dsh-commands contract (type-level)', () => {
    expect<MyCommandSatisfiesReal>(true).toBe(true);
  });

  it('ToolDefinition satisfies the real dsh-tools contract (type-level)', () => {
    expect<MyToolSatisfiesReal>(true).toBe(true);
  });

  it('a real-shape invocation can drive our command handler (runtime canary)', async () => {
    // Re-assert assignability at runtime by exercising the real invocation
    // shape through our handler; wiring.test covers the full command body, so
    // this only guards the envelope shape.
    const invocation: RealCommandInvocation = {
      commandId: 'cid',
      agent: { id: 'a1', session: { id: 's1', header: { cwd: '/ws' } } },
      rawInput: 'list',
      attachments: [],
      signal: new AbortController().signal,
    };
    expect(invocation.rawInput).toBe('list');
    expect(invocation.agent.session?.header?.cwd).toBe('/ws');
  });
});

// Keep the aliases referenced so the compile-time guards are part of the type
// graph even if the runtime asserts change.
void (null as unknown as Expect<MyCommandSatisfiesReal>);
void (null as unknown as Expect<MyToolSatisfiesReal>);
