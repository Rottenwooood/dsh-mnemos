/** Render formalized memories as portable DSH skill files. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Memory } from './types.js';

export function memorySkillSlug(memory: Memory): string {
  const base = memory.topic
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `mnemos-${base || memory.id.replace(/[^a-z0-9-]/gi, '-')}`;
}

export function renderMemorySkill(memory: Memory, body?: string): string {
  const name = memorySkillSlug(memory);
  const content = (body ?? memory.detail ?? memory.summary).trim();
  const evidence = memory.evidence
    .map((e) => `- ${e.sessionId} [${e.eventRange[0]}-${e.eventRange[1]}] ${e.quote}`)
    .join('\n');
  return [
    '---',
    `name: ${name}`,
    `description: ${memory.summary}`,
    'type: skill',
    'source: dsh-mnemos',
    `memory-id: ${memory.id}`,
    '---',
    '',
    `# ${name}`,
    '',
    content,
    '',
    evidence ? `## 来源\n\n${evidence}` : '',
    '',
  ].filter((line) => line.length > 0).join('\n');
}

export interface WriteSkillResult {
  ok: boolean;
  reason?: string;
  path?: string;
}

export function writeMemorySkill(memory: Memory, skillsDir: string, body?: string): WriteSkillResult {
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${memorySkillSlug(memory)}.md`);
  writeFileSync(path, renderMemorySkill(memory, body), 'utf8');
  return { ok: true, path };
}

export function listSkillFiles(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return [];
  }
}
