import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMnemosSkillProvider, type SkillsRegistryFace, type SkillProviderFace } from '../dsh/skill-provider.js';
function makeRegistry(): {
  registry: SkillsRegistryFace & { providers: SkillProviderFace[]; disposed: number };
} {
  const providers: SkillProviderFace[] = [];
  const state = {
    providers,
    disposed: 0,
    registry: {} as SkillsRegistryFace & { providers: SkillProviderFace[]; disposed: number },
  };
  state.registry = {
    providers,
    disposed: 0,
    registerProvider(create: () => unknown) {
      const provider = create() as SkillProviderFace;
      providers.push(provider);
      return () => {
        const idx = providers.indexOf(provider);
        if (idx >= 0) providers.splice(idx, 1);
        state.disposed++;
      };
    },
  };
  return { registry: state.registry };
}

const SKILL_MD = `---
name: mnemos-use-pnpm
description: Use pnpm for dependency installs in this repo.
type: skill
---
# mnemos-use-pnpm

Always install dependencies with pnpm, never npm.
`;

describe('mnemos skill provider (DSH wiring)', () => {
  it('registers only when ctx.skills exists and lists/gets formalized skill files', async () => {
    const dir = join(tmpdir(), `mnemos-skills-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mnemos-use-pnpm.md'), SKILL_MD, 'utf8');
    writeFileSync(join(dir, 'invalid.md'), '# no frontmatter\n', 'utf8');

    const { registry } = makeRegistry();
    const ctx = {
      get: () => registry,
      effect(fn: () => unknown): void {
        void fn();
      },
    };
    registerMnemosSkillProvider(ctx, dir, { warn: () => {} });
    expect(registry.providers).toHaveLength(1);

    const provider = registry.providers[0]!;
    expect(provider.name).toBe('mnemos');
    const candidates = await provider.list({}) as Array<{ name: string; description: string; path: string }>;
    expect(candidates).toHaveLength(1); // invalid.md has no frontmatter -> skipped
    expect(candidates[0]!.name).toBe('mnemos-use-pnpm');
    expect(candidates[0]!.description).toBe('Use pnpm for dependency installs in this repo.');

    const body = await provider.get(candidates[0]!, {});
    expect((body as { content: string }).content).toContain('Always install dependencies with pnpm');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the skills registry is absent', () => {
    const { registry } = makeRegistry();
    registerMnemosSkillProvider({ get: () => undefined, effect: () => {} }, join(tmpdir(), 'nonexistent'), { warn: () => {} });
    expect(registry.providers).toHaveLength(0);
  });

  it('disposes the provider on unload', () => {
    const dir = join(tmpdir(), `mnemos-skills-dispose-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const { registry } = makeRegistry();
    let cleanup: () => void = () => {};
    const ctx = {
      get: () => registry,
      effect(fn: () => unknown): void {
        cleanup = fn() as () => void;
      },
    };
    registerMnemosSkillProvider(ctx, dir, { warn: () => {} });
    expect(registry.providers).toHaveLength(1);
    // Run the effect's returned disposer (cordis unload).
    cleanup();
    expect(registry.providers).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
