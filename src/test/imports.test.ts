import { describe, it, expect } from 'vitest';
import { parseClaudeCodeLog } from '../domain/imports/claude-code.js';
import { parseCodexLog } from '../domain/imports/codex.js';
import { parseChatGptExport } from '../domain/imports/chatgpt.js';
import { parseDshSessionLog } from '../domain/imports/dsh.js';
import { detectSource } from '../domain/imports/detect.js';

const CLAUDE = [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'remember to use pnpm' }] },
    timestamp: '2025-01-01T00:00:00.000Z',
    uuid: 'u1',
    sessionId: 'sess-a',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Got it, I will use pnpm.' }],
    },
    timestamp: '2025-01-01T00:00:01.000Z',
    uuid: 'u2',
  }),
  JSON.stringify({
    type: 'tool_use',
    message: { id: 'toolu_1', name: 'Bash', input: { command: 'pnpm install' } },
    timestamp: '2025-01-01T00:00:02.000Z',
    uuid: 'u3',
  }),
  JSON.stringify({
    type: 'result',
    message: { tool_use_id: 'toolu_1', content: 'Done in 1.2s', is_error: false, subtype: 'success' },
    timestamp: '2025-01-01T00:00:03.000Z',
    uuid: 'u4',
  }),
  JSON.stringify({ type: 'summary', message: { leaf: { text: 'set up pnpm' } }, timestamp: '2025-01-01T00:00:04.000Z' }),
].join('\n');

const CODEX = [
  JSON.stringify({ timestamp: '2025-01-01T00:00:00.000Z', type: 'session_meta', payload: { timezone: 'UTC' } }),
  JSON.stringify({
    timestamp: '2025-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a test for recall' }] },
  }),
  JSON.stringify({
    timestamp: '2025-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Adding a test.' }] },
  }),
  JSON.stringify({
    timestamp: '2025-01-01T00:00:03.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"pytest"}' },
  }),
  JSON.stringify({
    timestamp: '2025-01-01T00:00:04.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: 'PASSED' },
  }),
  JSON.stringify({ timestamp: '2025-01-01T00:00:05.000Z', type: 'user', payload: { role: 'user', content: 'and now legacy' } }),
  JSON.stringify({ type: 'agent', payload: { content: [{ type: 'text', text: 'legacy done' }] } }),
].join('\n');

const CHATGPT = JSON.stringify([
  {
    title: 'Project setup',
    create_time: 1700000000,
    mapping: {
      node0: { id: 'node0', message: null, parent: null, children: ['node1'] },
      node1: {
        id: 'node1',
        message: {
          id: 'node1',
          author: { role: 'user' },
          create_time: 1700000000,
          content: { parts: ['remember: build with pnpm'], content_type: 'text' },
        },
        parent: 'node0',
        children: ['node2'],
      },
      node2: {
        id: 'node2',
        message: {
          id: 'node2',
          author: { role: 'assistant' },
          create_time: 1700000005,
          content: { parts: ['Use pnpm. Add a test.'], content_type: 'text' },
        },
        parent: 'node1',
        children: [],
      },
    },
  },
]);

const DSH = [
  JSON.stringify({ type: 'user/message', text: '记住：用 pnpm 构建', index: 0 }),
  JSON.stringify({ type: 'assistant/message', text: '好的，用 pnpm。', index: 1 }),
  JSON.stringify({ type: 'tool/result', name: 'Bash', text: 'Done', index: 2 }),
].join('\n');

describe('claude-code adapter', () => {
  it('parses user/assistant/tool messages with roles and order', () => {
    const msgs = parseClaudeCodeLog(CLAUDE, 'sess-a');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(msgs[0]!.text).toContain('remember to use pnpm');
    expect(msgs[1]!.name).toBe('claude-sonnet-4-5');
    expect(msgs[2]!.text).toContain('pnpm install');
    expect(msgs[3]!.error).toBe(false);
  });
});

describe('codex adapter', () => {
  it('handles both response_item and legacy envelopes', () => {
    const msgs = parseCodexLog(CODEX, 'codex-s1');
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[2]!.role).toBe('tool');
    expect(msgs[2]!.name).toBe('shell');
    expect(msgs[3]!.role).toBe('tool');
    expect(msgs[3]!.error).toBe(false);
    expect(msgs[4]!.text).toBe('and now legacy');
    expect(msgs[5]!.text).toBe('legacy done');
  });
});

describe('chatgpt adapter', () => {
  it('flattens a conversation ordered by create_time', () => {
    const msgs = parseChatGptExport(CHATGPT, 'chatgpt');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.text).toContain('remember: build with pnpm');
    expect(msgs[1]!.text).toContain('Use pnpm');
  });
});

describe('dsh adapter', () => {
  it('extracts role and text from session event lines', () => {
    const msgs = parseDshSessionLog(DSH, 'dsh-s1');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(msgs[0]!.text).toBe('记住：用 pnpm 构建');
  });
});

describe('detectSource', () => {
  it('detects claude-code, codex and chatgpt', () => {
    expect(detectSource(CLAUDE)).toBe('claude-code');
    expect(detectSource(CODEX)).toBe('codex');
    expect(detectSource(CHATGPT)).toBe('chatgpt');
    expect(detectSource('')).toBeUndefined();
  });
});
