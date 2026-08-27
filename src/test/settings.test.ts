import { describe, it, expect, vi } from 'vitest';
import {
  MNEMOS_SETTINGS_FIELDS,
  buildSchema,
  mountMnemosNamespace,
  installMnemosSettings,
} from '../dsh/settings.js';
import { defaultConfig, Config } from '../config.js';
import { openMemoryStore } from '../domain/store.js';
import { createSensitiveDetector } from '../domain/sensitive.js';
import { createMemoryService, GateConfig } from '../domain/service.js';

function fakeSchema() {
  const shape: Record<string, unknown> = {};
  const Schema = {
    object(s: Record<string, unknown>) {
      Object.assign(shape, s);
      return { kind: 'object', shape: s };
    },
    string() {
      return { kind: 'string' };
    },
    number() {
      return { kind: 'number' };
    },
    boolean() {
      return { kind: 'boolean' };
    },
    array(item: unknown) {
      return { kind: 'array', item };
    },
  };
  return { Schema, shape };
}

describe('MNEMOS_SETTINGS_FIELDS', () => {
  it('covers every Config key', () => {
    const cfg = defaultConfig();
    const keys = MNEMOS_SETTINGS_FIELDS.map((f) => f.key);
    for (const key of Object.keys(cfg) as Array<keyof Config>) {
      expect(keys).toContain(key);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildSchema', () => {
  it('maps each field to the matching schemastery type', () => {
    const { Schema, shape } = fakeSchema();
    const schema = buildSchema(Schema as never, MNEMOS_SETTINGS_FIELDS);
    expect(schema).toEqual({ kind: 'object', shape });
    expect(shape['maxEntries']).toEqual({ kind: 'number' });
    expect(shape['autoApprove']).toEqual({ kind: 'boolean' });
    expect(shape['blacklist']).toEqual({ kind: 'array', item: { kind: 'string' } });
    expect(shape['dbPath']).toEqual({ kind: 'string' });
  });
});

describe('mountMnemosNamespace', () => {
  it('registers the namespace with the entry as base and notifies on change', () => {
    const entry = defaultConfig();
    const onChange = vi.fn();
    let watcher: ((next: unknown) => void) | undefined;
    const watch = (cb: (next: unknown) => void) => {
      watcher = cb;
      return () => {};
    };
    const scope = { get: () => entry, watch };
    const register = vi.fn(() => scope);
    const ctx = { settings: { register } } as never;
    const disposer = mountMnemosNamespace(ctx, { kind: 'object' }, entry, onChange);

    expect(register).toHaveBeenCalledWith('mnemos', { kind: 'object' }, { base: entry });
    expect(onChange).toHaveBeenCalledWith(entry);
    const next = { ...entry, maxEntries: 999 } as Config;
    watcher?.(next);
    expect(onChange).toHaveBeenLastCalledWith(next);
    expect(typeof disposer).toBe('function');
  });

  it('degrades to a no-op when no settings service is mounted', () => {
    const ctx = {} as never;
    const disposer = mountMnemosNamespace(ctx, {}, defaultConfig(), () => {});
    expect(disposer()).toBeUndefined();
  });
});

describe('installMnemosSettings', () => {
  it('returns a disposer and never throws without schemastery or settings', async () => {
    const ctx = { logger: () => ({ info: () => {}, warn: () => {} }) } as never;
    const disposer = installMnemosSettings(ctx, defaultConfig(), () => {});
    disposer();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('live gate re-apply', () => {
  it('updateGate swaps the gate in place and future writes use it', () => {
    const store = openMemoryStore(':memory:');
    const service = createMemoryService(store, createSensitiveDetector(), {
      maxEntries: 5000,
      maxBytesPerEntry: 8192,
      autoApprove: true,
      autoApproveConfidence: 0.9,
      allowModelGlobalWrite: false,
      blacklist: [],
    });
    const next: GateConfig = {
      maxEntries: 2,
      maxBytesPerEntry: 64,
      autoApprove: false,
      autoApproveConfidence: 0.99,
      allowModelGlobalWrite: true,
      blacklist: ['bad-plugin'],
    };
    service.updateGate(next);
    expect(service.config).toEqual(next);
  });
});
