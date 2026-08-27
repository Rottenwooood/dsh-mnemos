import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { promoteRuleToSkill, renderSkillFile, listSkillFiles, skillSlug } from '../domain/skill.js';
import { Rule } from '../domain/types.js';

function make() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

function rule(partial: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    kind: 'skill',
    text: 'Run typecheck then tests before release.',
    evidence: [{ sessionId: 's1', eventRange: [0, 1], quote: 'run typecheck then tests' }],
    state: 'proposed',
    proposedBy: 'distill',
    version: 1,
    ...partial,
  };
}

describe('rule lifecycle', () => {
  it('proposes a rule, approves it, then allows rollback and deprecation', () => {
    const { service } = make();
    const proposed = service.proposeRule(rule(), 'model');
    expect(proposed.outcome).toBe('proposed');
    expect(service.listRules('proposed')).toHaveLength(1);

    const approved = service.approve(proposed.approvalId!, 'approve');
    expect(approved.ok).toBe(true);
    expect(approved.rule?.state).toBe('approved');

    const rollback = service.setRuleState('rule-1', 'rolled_back');
    expect(rollback.ok).toBe(true);
    expect(rollback.rule?.state).toBe('rolled_back');

    const reactivate = service.setRuleState('rule-1', 'approved');
    expect(reactivate.ok).toBe(true);

    const deprecate = service.setRuleState('rule-1', 'deprecated');
    expect(deprecate.ok).toBe(true);
  });

  it('rejects invalid state transitions', () => {
    const { service } = make();
    service.proposeRule(rule(), 'model');
    const bad = service.setRuleState('rule-1', 'deprecated');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('invalid transition');
  });

  it('denies a sensitive rule proposal and a duplicate', () => {
    const { service } = make();
    const sensitive = service.proposeRule(
      rule({ text: 'Key: sk-abcdefghijklmnopqrstuvwxyzABCDEFGHI' }),
      'model',
    );
    expect(sensitive.outcome).toBe('denied');
    expect(sensitive.reason).toBe('sensitive');

    const r = rule();
    service.proposeRule(r, 'model');
    const dup = service.proposeRule(r, 'model');
    expect(dup.outcome).toBe('denied');
    expect(dup.reason).toBe('duplicate');
  });
});

describe('skill synthesis', () => {
  it('renders a markdown skill file with frontmatter', () => {
    const md = renderSkillFile(rule({ state: 'approved' }));
    expect(md).toContain('---');
    expect(md).toContain('name: mnemos-run-typecheck-then-tests-before');
    expect(md).toContain('type: skill');
    expect(md).toContain('rule-id: rule-1');
    expect(md).toContain('Run typecheck then tests before release.');
  });

  it('refuses to promote a rule that is not approved', () => {
    const { service } = make();
    service.proposeRule(rule(), 'model');
    const result = promoteRuleToSkill(service, 'rule-1', '/tmp/opencode/nonexistent-skills');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not-approved');
  });

  it('writes the file and marks the rule promoted only after approval', () => {
    const { service } = make();
    service.proposeRule(rule(), 'model');
    service.approve(1, 'approve');
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-skills-'));
    const result = promoteRuleToSkill(service, 'rule-1', dir);
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    const files = listSkillFiles(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(result.path!, 'utf8')).toContain('type: skill');
    expect(service.getRule('rule-1')?.state).toBe('promoted');
    expect(skillSlug(rule())).toContain('mnemos-');
    rmSync(dir, { recursive: true, force: true });
  });
});
