/**
 * DSH skill provider (M2 wiring): expose the mnemos skills directory
 * (`~/.dsh/mnemos/skills/`, where approved rules are promoted to SKILL files)
 * to the harness's `ctx.skills` registry. This makes a promoted skill loadable
 * through DSH's `skill` tool — the knowledge leaves mnemos and works anywhere
 * in the harness.
 *
 * The provider is intentionally minimal: it scans flat Markdown files in the
 * skills directory and parses YAML frontmatter (`name` + `description` are
 * required, matching the local skill-file convention). It is typed against the
 * small structural face declared in `dsh.d.ts` so mnemos never hard-depends on
 * `@deepseek-ai/dsh-skill`; if `ctx.skills` is absent (no skill registry
 * mounted), registration is skipped and mnemos still works.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Structural face of `ctx.skills.registerProvider` (see dsh.d.ts). */
export interface SkillsRegistryFace {
  registerProvider(create: () => unknown): () => void;
}

/** Structural face of the provider we register (see dsh.d.ts). */
export interface SkillProviderFace {
  name: string;
  list: (options: { cwd?: string; signal?: AbortSignal }) => Promise<readonly unknown[]> | readonly unknown[];
  get: (candidate: unknown, options: { signal?: AbortSignal }) => unknown | Promise<unknown | undefined>;
}

function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return undefined;
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  const data: Record<string, unknown> = {};
  for (const line of head.split('\n')) {
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]!] = m[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Structural face of `ctx.effect` (see dsh.d.ts). */
export interface CtxEffectFace {
  effect(fn: () => unknown): unknown;
}

/** Register the mnemos skill directory as a harness skill provider. */
export function registerMnemosSkillProvider(
  ctx: { skills?: SkillsRegistryFace } & CtxEffectFace,
  skillsDir: string,
  logger: { warn(msg: string): void },
): void {
  const registry = ctx.skills;
  if (!registry) {
    return;
  }
  const register = (): (() => void) | undefined => {
    try {
      return registry.registerProvider(() => {
        const provider: SkillProviderFace = {
          name: 'mnemos',
          list: () => {
            let names: string[] = [];
            try {
              names = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
            } catch {
              return [];
            }
            const candidates: unknown[] = [];
            for (const file of names) {
              const full = join(skillsDir, file);
              try {
                if (!statSync(full).isFile()) continue;
                const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
                if (!parsed) continue;
                const name = parsed.data.name;
                const description = parsed.data.description;
                if (typeof name !== 'string' || typeof description !== 'string') continue;
                candidates.push({
                  name,
                  description,
                  invocation: { modelInvocable: true, userInvocable: true },
                  source: 'user',
                  provider: 'mnemos',
                  rank: 400,
                  locator: full,
                  path: full,
                  metadata: isObject(parsed.data) ? parsed.data : undefined,
                });
              } catch {
                // skip unreadable skill files
              }
            }
            return candidates;
          },
          get: (candidate) => {
            if (!isObject(candidate) || typeof candidate.path !== 'string') return undefined;
            try {
              const parsed = parseFrontmatter(readFileSync(candidate.path, 'utf8'));
              if (!parsed) return undefined;
              const name = parsed.data.name;
              const description = parsed.data.description;
              if (typeof name !== 'string' || typeof description !== 'string') return undefined;
              return {
                name,
                description,
                invocation: { modelInvocable: true, userInvocable: true },
                source: 'user',
                provider: 'mnemos',
                content: parsed.body,
                path: candidate.path,
                metadata: isObject(parsed.data) ? parsed.data : undefined,
              };
            } catch {
              return undefined;
            }
          },
        };
        return provider;
      });
    } catch (err) {
      logger.warn(`mnemos skill provider registration failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  // Register inside ctx.effect so cordis disposes the provider on unload.
  ctx.effect(() => {
    const disposer = register();
    return () => disposer?.();
  });
}
