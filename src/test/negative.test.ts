import { describe, it, expect } from 'vitest';
import { openNegativeMemoryStore, negativeFingerprint } from '../domain/negative.js';

function rec(fingerprint = negativeFingerprint('bash', '/ws', 'ls')) {
  return {
    fingerprint,
    kind: 'command' as const,
    claim: 'ls',
    evidence: 'ls: cannot access',
    ttlMs: 300_000,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('negative memory store', () => {
  it('records, finds and resolves a failure by fingerprint', () => {
    const store = openNegativeMemoryStore(':memory:');
    const r = rec();
    store.record(r);
    expect(store.findActive(r.fingerprint)?.evidence).toContain('cannot access');
    store.resolve(r.fingerprint);
    expect(store.findActive(r.fingerprint)).toBeUndefined();
    store.close();
  });

  it('fingerprint changes with cwd (precondition change) or command', () => {
    const a = negativeFingerprint('bash', '/ws', 'rm -rf /tmp/x');
    const b = negativeFingerprint('bash', '/ws2', 'rm -rf /tmp/x');
    const c = negativeFingerprint('bash', '/ws', 'rm -rf /tmp/y');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('expires an old record after TTL', () => {
    const store = openNegativeMemoryStore(':memory:');
    store.record({ ...rec(), createdAt: new Date(Date.now() - 600_000).toISOString(), ttlMs: 300_000 });
    store.expire(Date.now());
    expect(store.findActive(rec().fingerprint)).toBeUndefined();
    store.close();
  });
});
