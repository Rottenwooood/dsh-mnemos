import { describe, it, expect } from 'vitest';
import { extractCandidates } from '../domain/extract.js';
import { ImportedMessage } from '../domain/imports/types.js';

function msg(partial: Partial<ImportedMessage> & Pick<ImportedMessage, 'role' | 'text'>): ImportedMessage {
  return {
    sessionId: 's1',
    index: 0,
    ...partial,
  };
}

describe('deterministic extractor', () => {
  it('extracts an explicit remember request as a preference candidate', () => {
    const out = extractCandidates(
      [msg({ role: 'user', text: '记住：用 pnpm 构建这个项目', index: 0 })],
      { scope: 'workspace', workspace: 'ws' },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.signal).toBe('remember');
    expect(out[0]!.input.type).toBe('preference');
    expect(out[0]!.input.summary).toContain('用 pnpm 构建这个项目');
    expect(out[0]!.input.evidence[0]!.quote).toContain('记住：用 pnpm');
  });

  it('extracts an english remember request', () => {
    const out = extractCandidates([msg({ role: 'user', text: 'Remember that we use vitest.', index: 0 })], {
      scope: 'global',
    });
    expect(out[0]!.input.summary).toBe('we use vitest.');
    expect(out[0]!.input.scope).toBe('global');
  });

  it('extracts a user correction of a prior assistant claim as error_fix', () => {
    const out = extractCandidates(
      [
        msg({ role: 'assistant', text: 'I will scaffold with npm.', index: 0 }),
        msg({ role: 'user', text: '不对，用 pnpm 不是 npm', index: 1 }),
      ],
      { scope: 'workspace', workspace: 'ws' },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.signal).toBe('correction');
    expect(out[0]!.input.type).toBe('error_fix');
    expect(out[0]!.input.evidence).toHaveLength(2);
  });

  it('ignores plain chat without signals', () => {
    const out = extractCandidates(
      [
        msg({ role: 'user', text: 'hello', index: 0 }),
        msg({ role: 'assistant', text: 'hi', index: 1 }),
      ],
      { scope: 'global' },
    );
    expect(out).toHaveLength(0);
  });
});
