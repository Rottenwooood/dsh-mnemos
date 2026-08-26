import { describe, it, expect } from 'vitest';
import {
  normalizeTopic,
  exactDedupKey,
  similarity,
  findSimilar,
} from '../domain/dedup.js';
import { MemoryInput } from '../domain/types.js';

function input(partial: Partial<MemoryInput> & Pick<MemoryInput, 'topic'>): MemoryInput {
  return {
    type: 'project_fact',
    scope: 'workspace',
    summary: partial.topic,
    evidence: [],
    confidence: 1,
    source: 'manual',
    writer: 'test',
    ...partial,
  };
}

describe('dedup utilities', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeTopic('  Use   pnpm   ')).toBe('use pnpm');
  });

  it('builds a stable exact dedup key', () => {
    const a = exactDedupKey(input({ scope: 'workspace', type: 'project_fact', topic: 'pnpm' }));
    const b = exactDedupKey(input({ scope: 'workspace', type: 'project_fact', topic: ' Pnpm ' }));
    expect(a).toBe(b);
  });

  it('distinguishes scope in the dedup key', () => {
    const global = exactDedupKey(input({ scope: 'global', topic: 'pnpm' }));
    const ws = exactDedupKey(input({ scope: 'workspace', topic: 'pnpm' }));
    expect(global).not.toBe(ws);
  });

  it('computes similarity 1.0 for identical text and 0 for unrelated text', () => {
    expect(similarity('pnpm is the package manager', 'pnpm is the package manager')).toBe(1);
    expect(similarity('pnpm is the package manager', 'the sky is blue today')).toBeLessThan(0.3);
  });

  it('finds near-duplicate summaries above a threshold', () => {
    const summaries = [
      { id: 'm1', summary: 'The user prefers pnpm over npm for this repo.' },
      { id: 'm2', summary: 'Docker is used for local postgres.' },
    ];
    const hits = findSimilar(summaries, 'The user prefers pnpm, not npm, in this repo.', 0.6);
    expect(hits.map((h) => h.id)).toContain('m1');
    expect(hits.find((h) => h.id === 'm2')).toBeUndefined();
  });
});
