import { describe, it, expect } from 'vitest';
import {
  createBackfillService,
  processImported,
  CheckpointStore,
  Checkpoint,
  MessageSink,
} from '../domain/backfill.js';
import type { ImportedMessage } from '../domain/imports/types.js';

function memoryCheckpoint(initial: Checkpoint = {}): CheckpointStore {
  let data = initial;
  return {
    read: () => data,
    write: (c) => {
      data = c;
    },
  };
}

function makeSink(): { sink: MessageSink; ingested: ImportedMessage[] } {
  const ingested: ImportedMessage[] = [];
  return { sink: { ingest: (ms) => ingested.push(...ms) }, ingested };
}

const LOG = [
  JSON.stringify({ type: 'user/message', text: '记住：用 pnpm', index: 0 }),
  JSON.stringify({ type: 'user/message', text: 'hello world', index: 1 }),
  JSON.stringify({ type: 'assistant/message', text: 'ok', index: 2 }),
].join('\n');

describe('backfill service', () => {
  it('ingests parsed messages into the distill buffer (no heuristic extraction)', () => {
    const { sink, ingested } = makeSink();
    const backfill = createBackfillService(sink, { checkpoint: memoryCheckpoint() });
    const stats = backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    expect(stats.scannedFiles).toBe(1);
    expect(stats.parsedMessages).toBe(3);
    expect(ingested).toHaveLength(3);
    expect(ingested[0]!.text).toContain('pnpm');
  });

  it('is incremental: re-processes only the tail beyond the checkpoint', () => {
    const { sink, ingested } = makeSink();
    const checkpoint = memoryCheckpoint();
    const backfill = createBackfillService(sink, { checkpoint, incremental: true });
    backfill.run([{ path: '/x/session.jsonl', text: LOG }]);
    expect(ingested).toHaveLength(3);

    const appended = `${LOG}\n${JSON.stringify({ type: 'user/message', text: '记住：用 yarn', index: 3 })}`;
    const second = createBackfillService(sink, { checkpoint, incremental: true });
    const stats = second.run([{ path: '/x/session.jsonl', text: appended }]);
    expect(stats.parsedMessages).toBe(1);
    expect(ingested).toHaveLength(4);
    expect(ingested[3]!.text).toContain('yarn');
  });

  it('processImported ingests messages directly into the sink', () => {
    const { sink, ingested } = makeSink();
    const stats = processImported(
      sink,
      [{ role: 'user', text: 'hi', sessionId: 's1', index: 0 }],
      { caller: 'human', scope: 'workspace', workspace: 'ws' },
    );
    expect(stats.parsedMessages).toBe(1);
    expect(ingested).toHaveLength(1);
  });

  it('tolerates a malformed file without crashing the run', () => {
    const { sink, ingested } = makeSink();
    const backfill = createBackfillService(sink, { checkpoint: memoryCheckpoint() });
    const stats = backfill.run([{ path: '/x/broken.jsonl', text: 'not valid { json' }]);
    expect(stats.scannedFiles).toBe(1);
    expect(ingested.length).toBeGreaterThanOrEqual(0);
  });
});
