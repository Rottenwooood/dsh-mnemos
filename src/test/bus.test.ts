import { describe, it, expect, vi } from 'vitest';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService } from '../domain/service.js';
import { createMemoryBus, BusEvent } from '../domain/bus.js';
import { MemoryInput } from '../domain/types.js';

function make() {
  const store = openMemoryStore(':memory:');
  const service = createMemoryService(store, createSensitiveDetector());
  const external = vi.fn();
  const bus = createMemoryBus(service, store, external);
  return { store, service, bus, external };
}

function input(partial: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: 'project_fact',
    scope: 'workspace',
    workspace: 'ws',
    topic: 'build',
    summary: 'Builds with pnpm.',
    evidence: [{ sessionId: 's1', eventRange: [0, 0], quote: 'use pnpm' }],
    confidence: 0.95,
    source: 'manual',
    writer: 'x',
    ...partial,
  };
}

const identity = { name: 'my-plugin', version: '1.2.3' };

describe('memory bus', () => {
  it('record requires identity and always proposes (never auto-commits)', () => {
    const { service, bus } = make();
    const result = bus.record(input({ confidence: 1 }), identity);
    expect(result.outcome).toBe('proposed');
    expect(result.approvalId).toBeGreaterThan(0);
    expect(service.listActive()).toHaveLength(0);
  });

  it('stamps writer and source for third-party writes', async () => {
    const { store, bus } = make();
    const result = bus.record(input(), identity);
    const payload = store.listApprovals('proposed')[0]!.payload as MemoryInput;
    expect(payload.writer).toBe('plugin:my-plugin@1.2.3');
    expect(payload.source).toBe('third_party');
    expect(result.outcome).toBe('proposed');
  });

  it('denies a blacklisted plugin with an audit entry', () => {
    const { store, bus } = make();
    bus.blacklistPlugin('my-plugin', 'spam');
    const result = bus.record(input(), identity);
    expect(result.outcome).toBe('denied');
    expect(result.reason).toBe('plugin-blacklisted');
    expect(bus.isBlacklisted('my-plugin')).toBe(true);
    const audits = store.listAudit(10);
    expect(audits.some((a) => a.denied === 1 && a.reason === 'plugin-blacklisted')).toBe(true);
  });

  it('unblacklists a plugin', () => {
    const { bus } = make();
    bus.blacklistPlugin('my-plugin');
    bus.unblacklistPlugin('my-plugin');
    expect(bus.isBlacklisted('my-plugin')).toBe(false);
    expect(bus.listBlacklist()).toHaveLength(0);
  });

  it('subscribe receives proposal events and unsubscribing stops delivery', () => {
    const { bus } = make();
    const seen: BusEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    bus.record(input(), identity);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('memory-proposed');
    off();
    bus.record(input({ topic: 'other' }), identity);
    expect(seen).toHaveLength(1);
  });

  it('emits external (cordis) events', () => {
    const { external, bus } = make();
    bus.record(input(), identity);
    expect(external).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory-proposed' }));
  });

  it('recall searches or lists by scope', () => {
    const { service, bus } = make();
    service.add(input(), 'human');
    expect(bus.recall({ query: 'pnpm' }).length).toBeGreaterThan(0);
    expect(bus.recall({ scope: 'workspace', workspace: 'ws' }).length).toBe(1);
  });

  it('revoke is owner-only (or human), and soft-deletes', () => {
    const { store, service, bus } = make();
    const result = bus.record(input(), identity);
    const approved = service.approve(result.approvalId!, 'approve');
    expect(approved.ok).toBe(true);
    const memoryId = approved.memory!.id;

    const stranger = bus.revoke(memoryId, { name: 'other-plugin', version: '1' });
    expect(stranger.ok).toBe(false);
    expect(stranger.reason).toBe('not-owner');

    const owner = bus.revoke(memoryId, identity);
    expect(owner.ok).toBe(true);
    expect(store.getMemory(memoryId)?.status).toBe('deleted');
  });

  it('listByWriter groups memories across plugin versions', () => {
    const { service, bus } = make();
    const res = bus.record(input({ topic: 'a' }), identity);
    service.approve(res.approvalId!, 'approve');
    const res2 = bus.record(input({ topic: 'b' }), { name: 'my-plugin', version: '2.0.0' });
    service.approve(res2.approvalId!, 'approve');
    const rows = bus.listByWriter('my-plugin');
    expect(rows.map((r) => r.topic).sort()).toEqual(['a', 'b']);
  });
});
