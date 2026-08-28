import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { renderMemoryFile, parseMemoryFile, syncMirror, memoryFileName, applyMirrorToStore, mirrorFileFor } from '../domain/mirror.js';
import { Memory } from '../domain/types.js';

function mem(partial: Partial<Memory> = {}): Memory {
  return {
    id: 'mm://mnemos/abc12345',
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'ws',
    topic: 'build tool',
    summary: 'The project builds with pnpm.',
    detail: 'pnpm + vitest',
    evidence: [{ sessionId: 's1', eventRange: [0, 1], quote: 'use pnpm' }],
    confidence: 0.95,
    source: 'manual',
    writer: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    crossSessionHits: 3,
    status: 'active',
    ...partial,
  };
}

function make() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

describe('markdown mirror', () => {
  it('round-trips render -> parse', () => {
    const m = mem({ keywords: ['pnpm', 'install', '部署到 us-east-1'] });
    const text = renderMemoryFile(m);
    expect(text).toContain('keywords: pnpm, install, 部署到 us-east-1');
    // summary lives in frontmatter now (format B), body has no bare first line.
    expect(text).toMatch(/^summary: /m);
    const parsed = parseMemoryFile(text)!;
    expect(parsed.id).toBe(m.id);
    expect(parsed.topic).toBe('build tool');
    expect(parsed.summary).toContain('pnpm');
    expect(parsed.detail).toContain('vitest');
    expect(parsed.scope).toBe('workspace');
    expect(parsed.keywords).toEqual(['pnpm', 'install', '部署到 us-east-1']);
    // 溯源 (evidence) is written AND read back.
    expect(parsed.evidence.length).toBeGreaterThan(0);
  });

  it('still parses pre-B files where summary is the bare first body line', () => {
    const old = `---
id: mm://mnemos/legacy-1
type: project_fact
scope: workspace
workspace: ws
topic: old style
---
The old bare-body summary here.
## 详情

extra context
`;
    const parsed = parseMemoryFile(old)!;
    expect(parsed.summary).toContain('bare-body');
    expect(parsed.detail).toContain('extra context');
  });

  it('derives a deterministic unique file name per memory', () => {
    const a = memoryFileName(mem({ id: 'mm://mnemos/abc12345', topic: 'build tool' }));
    const b = memoryFileName(mem({ id: 'mm://mnemos/def67890', topic: 'build tool' }));
    expect(a).not.toBe(b);
    expect(a.startsWith('abc12345-')).toBe(true);
  });

  it('syncMirror writes active+archived and removes deleted files', () => {
    const { store } = make();
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-mirror-'));
    const m1 = mem({ id: 'mm://mnemos/aaa', topic: 'one' });
    const m2 = mem({ id: 'mm://mnemos/bbb', topic: 'two', status: 'archived' });
    store.addMemory(m1);
    store.addMemory(m2);
    const first = syncMirror(store, dir);
    expect(first.written).toHaveLength(2);

    store.setMemoryStatus('mm://mnemos/aaa', 'deleted');
    const second = syncMirror(store, dir);
    expect(second.removed).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.md'))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('applyMirrorToStore upserts memories from disk files', () => {
    const { store } = make();
    const dir = mkdtempSync(join(tmpdir(), 'mnemos-apply-'));
    const m = mem();
    store.addMemory(m);
    syncMirror(store, dir);
    // change on disk, re-apply
    const file = mirrorFileFor(dir, m.id)!;
    writeFileSync(join(dir, file), renderMemoryFile(mem({ summary: 'Uses yarn now.' })), 'utf8');
    applyMirrorToStore(store, dir);
    expect(store.getMemory(m.id)?.summary).toContain('yarn');
    rmSync(dir, { recursive: true, force: true });
  });
});
