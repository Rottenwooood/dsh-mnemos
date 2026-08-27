/**
 * SKILL synthesis (M2): turn an approved procedure/preference rule into a
 * Markdown skill file. A skill file is written to disk only after the rule has
 * been approved — never from a draft — and the rule is then marked promoted.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryService } from './service.js';
import { Rule } from './types.js';

export function skillSlug(rule: Rule): string {
  const base = rule.text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `mnemos-${base || rule.id.replace(/[^a-z0-9-]/gi, '-')}`;
}

export function renderSkillFile(rule: Rule): string {
  const name = skillSlug(rule);
  const evidence = rule.evidence
    .map((e) => `- ${e.sessionId} [${e.eventRange[0]}-${e.eventRange[1]}] ${e.quote}`)
    .join('\n');
  return [
    '---',
    `name: ${name}`,
    `description: ${rule.text}`,
    'type: skill',
    'source: dsh-mnemos',
    `rule-id: ${rule.id}`,
    `version: ${rule.version}`,
    '---',
    '',
    `# ${name}`,
    '',
    rule.text,
    '',
    evidence ? `## 来源\n\n${evidence}` : '',
    '',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

export interface PromoteResult {
  ok: boolean;
  reason?: string;
  path?: string;
}

/**
 * Write the skill file only when the rule is approved, then mark it promoted.
 * Existing files are overwritten so re-promotion is idempotent.
 */
export function promoteRuleToSkill(
  service: MemoryService,
  ruleId: string,
  skillsDir: string,
): PromoteResult {
  const rule = service.getRule(ruleId);
  if (!rule) {
    return { ok: false, reason: 'not-found' };
  }
  if (rule.state !== 'approved') {
    return { ok: false, reason: `not-approved (state=${rule.state})` };
  }
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${skillSlug(rule)}.md`);
  writeFileSync(path, renderSkillFile(rule), 'utf8');
  const result = service.setRuleState(ruleId, 'promoted');
  return result.ok ? { ok: true, path } : { ok: false, reason: result.reason };
}

export function listSkillFiles(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}
