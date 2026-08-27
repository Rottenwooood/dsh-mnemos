import { describe, it, expect } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { createBackfillService, CheckpointStore, Checkpoint } from '../domain/backfill.js';

function memoryCheckpoint(initial: Checkpoint = {}): CheckpointStore {
  let data = initial;
  return {
    read: () => data,
    write: (c) => {
      data = c;
    },
  };
}

const LOG = [
  JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }),
  JSON.stringify({ type: 'user/message', text: 'hello world', index: 1 }),
  JSON.stringify({ type: 'assistant/message', text: 'ok', index: 2 }),
].join('\n');

function make() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  return { store, service };
}

describe('backfill service', () => {
  it('extracts and commits candidates when caller is human', () => {
    const { service } = make();
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
    });
    const stats = backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    expect(stats.parsedMessages).toBe(3);
    expect(stats.candidates).toBe(1);
    expect(stats.committed).toBe(1);
    expect(service.listActive('workspace', 'ws')).toHaveLength(1);
  });

  it('queues candidates when caller is model', () => {
    const { service } = make();
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'model',
      scope: 'workspace',
      workspace: 'ws',
    });
    const stats = backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    expect(stats.proposed).toBe(1);
    expect(service.listActive()).toHaveLength(0);
  });

  it('skips a file that is fully covered by the checkpoint (incremental resume)', () => {
    const { service } = make();
    const checkpoint = memoryCheckpoint();
    const backfill = createBackfillService(service, {
      checkpoint,
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
      incremental: true,
    });
    backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    const again = createBackfillService(service, {
      checkpoint,
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
      incremental: true,
    });
    const stats = again.run([{ path: '/x/session.jsonl', text: LOG }]);
    expect(stats.parsedMessages).toBe(0);
    expect(stats.candidates).toBe(0);
  });

  it('processes only the tail of an appended file on resume', () => {
    const { service } = make();
    const checkpoint = memoryCheckpoint();
    const backfill = createBackfillService(service, {
      checkpoint,
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
      incremental: true,
    });
    backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    const appended = `${LOG}\n${JSON.stringify({ type: 'user/message', text: '记住：用 yarn', index: 3 })}`;
    const again = createBackfillService(service, {
      checkpoint,
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
      incremental: true,
    });
    const stats = again.run([{ path: '/x/session.jsonl', text: appended }]);
    expect(stats.parsedMessages).toBe(1);
    expect(stats.candidates).toBe(1);
    expect(service.listActive()).toHaveLength(2);
  });

  it('denies sensitive candidates even when caller is human', () => {
    const { service } = make();
    const sensitiveLog = JSON.stringify({
      type: 'user/message',
      text: '记住：密钥是 sk-abcdefghijklmnopqrstuvwxyzABCDEFGHI',
      index: 0,
    });
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
    });
    const stats = backfill.run([{ path: '/x/session.jsonl', text: sensitiveLog }]);
    expect(stats.denied).toBe(1);
    expect(service.listActive()).toHaveLength(0);
  });

  it('dedupes identical candidates within one run', () => {
    const { service } = make();
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
    });
    const same = [
      { path: '/a.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }) },
      { path: '/b.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }) },
    ];
    const stats = backfill.run(same);
    expect(stats.candidates).toBe(2);
    expect(stats.committed).toBe(1);
    expect(stats.duplicateSkipped).toBe(1);
  });

  it('skips a subset duplicate ("用 pnpm" vs "用 pnpm 安装依赖") as duplicate', () => {
    const { service } = make();
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
    });
    const files = [
      { path: '/a.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }) },
      { path: '/b.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 pnpm 安装依赖', index: 0 }) },
    ];
    const stats = backfill.run(files);
    expect(stats.committed).toBe(1);
    expect(stats.duplicateSkipped).toBe(1);
    expect(service.listActive('workspace', 'ws')).toHaveLength(1);
  });

  it('keeps genuinely different facts as separate memories', () => {
    const { service } = make();
    const backfill = createBackfillService(service, {
      checkpoint: memoryCheckpoint(),
      caller: 'human',
      scope: 'workspace',
      workspace: 'ws',
    });
    const files = [
      { path: '/a.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }) },
      { path: '/b.jsonl', text: JSON.stringify({ type: 'user/message', text: '记住：用 yarn 安装', index: 0 }) },
    ];
    const stats = backfill.run(files);
    expect(stats.committed).toBe(2);
    expect(service.listActive('workspace', 'ws')).toHaveLength(2);
  });
});
