/**
 * The `/memory` human command: search, list, stats, approval review, import
 * and backfill.
 *
 * Approval decisions are human-only (this command dispatches without a model
 * turn), so governance cannot be delegated back to the model. Import and
 * backfill parse foreign/DSH history and route candidates through the same
 * approval gate as every other write.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from '../domain/service.js';
import type { CommandDefinition } from './types.js';
import type { Config } from '../config.js';
import { detectSource, parseAny } from '../domain/imports/detect.js';
import { processImported } from '../domain/backfill.js';
import { ImportSource } from '../domain/imports/types.js';

function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(name));
    if (statSync(path).isFile() && path.endsWith('.jsonl')) {
      out.push(path);
    }
  }
  return out;
}

export function registerCommand(ctx: Context, service: MemoryService, config: Config): void {
  const command: CommandDefinition = {
    name: 'memory',
    usage: 'memory <search|list|stats|approve|reject|import|backfill> ...',
    description:
      'Manage dsh-mnemos memories: search across sessions, list active entries, show stats, approve/reject proposed memories, and import or backfill history.',
    async handler(args, runtime) {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const scope = runtime.workspace ? 'workspace' : ('global' as const);
      switch (verb) {
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            runtime.say('usage: /memory search <query>');
            return;
          }
          const rows = service.search(query, 10);
          if (rows.length === 0) {
            runtime.say('No memories matched.');
            return;
          }
          runtime.say(
            rows
              .map(
                (r) =>
                  `- [${r.type}] ${r.topic} (${r.crossSessionHits} hit${
                    r.crossSessionHits === 1 ? '' : 's'
                  }): ${r.summary}`,
              )
              .join('\n'),
          );
          return;
        }
        case 'list': {
          const rows = service.listActive(runtime.workspace ? 'workspace' : undefined, runtime.workspace);
          if (rows.length === 0) {
            runtime.say('No active memories.');
            return;
          }
          runtime.say(rows.map((r) => `- [${r.type}] ${r.topic}: ${r.summary}`).join('\n'));
          return;
        }
        case 'stats': {
          const rows = service.listActive();
          runtime.say(`Active memories: ${rows.length}`);
          return;
        }
        case 'approve': {
          const id = Number(rest[0]);
          if (!Number.isInteger(id)) {
            runtime.say('usage: /memory approve <approvalId>');
            return;
          }
          const result = service.approve(id, 'approve');
          runtime.say(result.ok ? `Approved memory ${result.memory?.id ?? id}.` : `Cannot approve: ${result.reason}.`);
          return;
        }
        case 'reject': {
          const id = Number(rest[0]);
          if (!Number.isInteger(id)) {
            runtime.say('usage: /memory reject <approvalId>');
            return;
          }
          const result = service.approve(id, 'reject');
          runtime.say(result.ok ? `Rejected proposal ${id}.` : `Cannot reject: ${result.reason}.`);
          return;
        }
        case 'import': {
          const kind = (rest[0] ?? 'auto') as ImportSource | 'auto';
          const path = rest[1];
          if (!path || !existsSync(path)) {
            runtime.say('usage: /memory import <auto|claude|codex|chatgpt|dsh> <path>');
            return;
          }
          const text = readFileSync(path, 'utf8');
          const source = kind === 'auto' ? detectSource(text) : kind;
          if (!source) {
            runtime.say('Cannot detect transcript format; pass one explicitly.');
            return;
          }
          const messages = parseAny(text, source);
          const stats = processImported(service, messages, {
            caller: config.importCaller,
            scope,
            workspace: runtime.workspace,
          });
          runtime.say(
            `Imported ${stats.parsedMessages} messages from ${source}; ${stats.candidates} candidates → ` +
              `${stats.committed} committed, ${stats.proposed} proposed, ${stats.denied} denied, ${stats.duplicateSkipped} duplicates skipped.`,
          );
          return;
        }
        case 'backfill': {
          const dir = rest[0];
          if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
            runtime.say('usage: /memory backfill <session-log-dir>');
            return;
          }
          const files = listJsonlFiles(dir);
          if (files.length === 0) {
            runtime.say('No .jsonl session logs found in that directory.');
            return;
          }
          const stats = {
            scannedFiles: 0,
            parsedMessages: 0,
            candidates: 0,
            committed: 0,
            proposed: 0,
            denied: 0,
            duplicateSkipped: 0,
          };
          const seen = new Set<string>();
          for (const file of files) {
            stats.scannedFiles++;
            try {
              const text = readFileSync(file, 'utf8');
              const source = detectSource(text) ?? 'dsh';
              const s = processImported(service, parseAny(text, source, file), {
                caller: config.importCaller,
                scope,
                workspace: runtime.workspace,
              }, seen);
              stats.parsedMessages += s.parsedMessages;
              stats.candidates += s.candidates;
              stats.committed += s.committed;
              stats.proposed += s.proposed;
              stats.denied += s.denied;
              stats.duplicateSkipped += s.duplicateSkipped;
            } catch {
              // skip unreadable/unsupported files
            }
          }
          runtime.say(
            `Backfilled ${stats.scannedFiles} files, ${stats.parsedMessages} messages, ${stats.candidates} candidates → ` +
              `${stats.committed} committed, ${stats.proposed} proposed, ${stats.denied} denied, ${stats.duplicateSkipped} duplicates skipped.`,
          );
          return;
        }
        default:
          runtime.say(
            'commands: search <query> | list | stats | approve <id> | reject <id> | import <src> <path> | backfill <dir>',
          );
      }
    },
  };
  ctx.effect(() => ctx.commands.register(command));
}
