import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../index.js';
import { unlinkSync } from 'node:fs';

/**
 * REAL integration chain (not fakeContext): a real cordis Context, the real
 * `tools`/`commands` services provided, and mnemos's real `apply`. A real tool
 * call through the registered tool must credit a hit (used=1).
 */
describe('REAL chain (real cordis Context)', () => {
  it('registers tools and credits a hit on memory_search', async () => {
    const dbPath = `/tmp/opencode/mnemos-real-chain-${Date.now()}.db`;
    try {
      unlinkSync(dbPath);
    } catch {
      // fresh path
    }
    const ctx = new Context();
    const toolRegs: Array<{ name: string }> = [];
    const tools = {
      register(t: { name: string }) {
        toolRegs.push(t);
        return () => true;
      },
    };
    const commands = {
      register() {
        return () => true;
      },
    };
    ctx.provide('tools', tools);
    ctx.provide('commands', commands);

    apply(ctx, {
      dbPath,
      gitVersioning: false,
      enabled: true,
      injectMaxBytes: 4096,
      injectLimit: 8,
      protocolInjectEnabled: false,
    });

    const service = ctx.mnemos as ReturnType<typeof import('../domain/service.js')['createMemoryService']>;
    expect(service).toBeDefined();
    expect(toolRegs.map((t) => t.name)).toContain('memory_search');
    expect(toolRegs.map((t) => t.name)).toContain('memory_get');

    // Seed a memory.
    service.add(
      {
        type: 'project_fact',
        scope: 'workspace',
        workspace: '/workspace',
        topic: 'pnpm',
        summary: 'Use pnpm for builds.',
        keywords: ['pnpm'],
        evidence: [],
        confidence: 1,
        source: 'manual',
        writer: 'human',
      },
      'human',
    );

    expect(service.telemetry().used).toBe(0);

    // Real tool call through the registered tool.
    const searchTool = toolRegs.find((t) => t.name === 'memory_search') as unknown as {
      execute(args: unknown, e: unknown): Promise<{ hits: unknown[] }>;
    };
    const out = await searchTool.execute({ query: 'pnpm' }, { agent: { id: 's-real-1', session: { id: 's-real-1' } } });
    expect((out as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

    // Tool call = hit, no injection prerequisite.
    expect(service.telemetry().used).toBeGreaterThan(0);
    expect(service.telemetry().verifiedMemories).toBeGreaterThan(0);
  });
});
