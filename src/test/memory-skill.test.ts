import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkillFiles, memorySkillSlug, renderMemorySkill, writeMemorySkill } from '../domain/skill.js';
import type { Memory } from '../domain/types.js';

function memory(partial: Partial<Memory> = {}): Memory {
  return {
    id: '2026-01-01T00:00:00.000Z-memory-1',
    type: 'procedure',
    scope: 'workspace',
    workspace: '/ws',
    topic: 'release checks',
    summary: 'Run typecheck before tests before release.',
    detail: 'Run typecheck, then run the test suite before release.',
    keywords: ['release', 'typecheck'],
    evidence: [{ sessionId: 's1', eventRange: [0, 1], quote: 'run typecheck then tests' }],
    confidence: 0.9,
    source: 'evolve',
    writer: 'distill',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 0,
    status: 'active',
    ...partial,
  };
}

describe('memory skill synthesis', () => {
  it('renders a portable skill with memory provenance', () => {
    const md = renderMemorySkill(memory());
    expect(md).toContain('type: skill');
    expect(md).toContain('memory-id: 2026-01-01T00:00:00.000Z-memory-1');
    expect(md).toContain('Run typecheck, then run the test suite before release.');
    expect(md).toContain('## 来源');
  });

  it('writes and lists a skill file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-skills-'));
    const result = writeMemorySkill(memory(), dir);
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    expect(listSkillFiles(dir)).toEqual([`${memorySkillSlug(memory())}.md`]);
    expect(readFileSync(result.path!, 'utf8')).toContain('source: dsh-mnemos');
    rmSync(dir, { recursive: true, force: true });
  });
});
