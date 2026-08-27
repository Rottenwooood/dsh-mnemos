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
import type { Config } from '../config.js';
import { detectSource, parseAny } from '../domain/imports/detect.js';
import { processImported } from '../domain/backfill.js';
import { ImportSource } from '../domain/imports/types.js';
import { Llm } from '../domain/llm.js';
import { runDistillIncremental, DistillCursor } from '../domain/distill.js';
import { promoteRuleToSkill, listSkillFiles } from '../domain/skill.js';
import { MemoryBus } from '../domain/bus.js';
import { GitStore } from '../domain/gitstore.js';
import type { SignalCollector } from './hooks.js';
import type { CommandDefinition, CommandResult } from './types.js';

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

export interface CommandDeps {
  service: MemoryService;
  config: Config;
  llm?: Llm;
  collector?: SignalCollector;
  bus?: MemoryBus;
  gitStore?: GitStore;
  distillCursor: DistillCursor;
  persistCursor: (cursor: DistillCursor) => void;
}

export function registerCommand(ctx: Context, deps: CommandDeps): void {
  const { service, config, llm, collector } = deps;
  const ok = (text: string): CommandResult => ({ kind: 'success', text });
  const command: CommandDefinition = {
    name: 'memory',
    description:
      'Manage dsh-mnemos memories: search across sessions, list active entries, show stats, approve/reject proposals, import/backfill history, distill sessions, manage rules and promote skills.',
    input: { hint: 'search <query> | list | stats | approve <id> | reject <id> | import <src> <path> | backfill <dir> | distill [path] | rules <...> | skill <...> | bus <...> | git <...>' },
    async handler(invocation) {
      const raw = invocation.rawInput.trim();
      const [verb, ...rest] = raw.split(/\s+/);
      const workspace = invocation.agent.session?.header?.cwd;
      const sessionId = invocation.agent.id ?? invocation.agent.session?.id;
      const scope = workspace ? 'workspace' : ('global' as const);
      switch (verb) {
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            return ok('usage: /memory search <query>');
          }
          const rows = service.search(query, 10);
          if (rows.length === 0) {
            return ok('No memories matched.');
          }
          return ok(
            rows
              .map(
                (r) =>
                  `- [${r.type}] ${r.topic} (${r.crossSessionHits} hit${
                    r.crossSessionHits === 1 ? '' : 's'
                  }): ${r.summary}`,
              )
              .join('\n'),
          );
        }
        case 'list': {
          const rows = service.listActive(workspace ? 'workspace' : undefined, workspace);
          if (rows.length === 0) {
            return ok('No active memories.');
          }
          return ok(rows.map((r) => `- [${r.type}] ${r.topic}: ${r.summary}`).join('\n'));
        }
        case 'stats': {
          const rows = service.listActive();
          return ok(`Active memories: ${rows.length}`);
        }
        case 'approve': {
          const id = Number(rest[0]);
          if (!Number.isInteger(id)) {
            return ok('usage: /memory approve <approvalId>');
          }
          const result = service.approve(id, 'approve');
          return ok(result.ok ? `Approved memory ${result.memory?.id ?? id}.` : `Cannot approve: ${result.reason}.`);
        }
        case 'reject': {
          const id = Number(rest[0]);
          if (!Number.isInteger(id)) {
            return ok('usage: /memory reject <approvalId>');
          }
          const result = service.approve(id, 'reject');
          return ok(result.ok ? `Rejected proposal ${id}.` : `Cannot reject: ${result.reason}.`);
        }
        case 'import': {
          const kind = (rest[0] ?? 'auto') as ImportSource | 'auto';
          const path = rest[1];
          if (!path || !existsSync(path)) {
            return ok('usage: /memory import <auto|claude|codex|chatgpt|dsh> <path>');
          }
          const text = readFileSync(path, 'utf8');
          const source = kind === 'auto' ? detectSource(text) : kind;
          if (!source) {
            return ok('Cannot detect transcript format; pass one explicitly.');
          }
          const messages = parseAny(text, source);
          const stats = processImported(service, messages, {
            caller: config.importCaller,
            scope,
            workspace,
          });
          return ok(
            `Imported ${stats.parsedMessages} messages from ${source}; ${stats.candidates} candidates → ` +
              `${stats.committed} committed, ${stats.proposed} proposed, ${stats.denied} denied, ${stats.duplicateSkipped} duplicates skipped.`,
          );
        }
        case 'backfill': {
          const dir = rest[0];
          if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
            return ok('usage: /memory backfill <session-log-dir>');
          }
          const files = listJsonlFiles(dir);
          if (files.length === 0) {
            return ok('No .jsonl session logs found in that directory.');
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
                workspace,
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
          return ok(
            `Backfilled ${stats.scannedFiles} files, ${stats.parsedMessages} messages, ${stats.candidates} candidates → ` +
              `${stats.committed} committed, ${stats.proposed} proposed, ${stats.denied} denied, ${stats.duplicateSkipped} duplicates skipped.`,
          );
        }
        case 'distill': {
          if (!llm) {
            return ok('LLM unavailable; distillation is disabled until a model adapter is mounted.');
          }
          const path = rest[0];
          let messages = collector ? collector.drain() : [];
          if (path && existsSync(path)) {
            const text = readFileSync(path, 'utf8');
            const source = detectSource(text);
            messages = source ? parseAny(text, source) : [];
            if (messages.length === 0) {
              return ok('No parseable messages in that file.');
            }
          } else if (messages.length === 0) {
            return ok('No buffered session messages to distill (or pass a transcript path).');
          }
          const result = await runDistillIncremental(
            llm,
            service,
            messages,
            deps.distillCursor,
            { scope, workspace, sessionId },
          );
          deps.persistCursor(result.cursor);
          return ok(
            `Distilled ${result.stats.requested} messages → ${result.stats.memories} memory candidate(s), ` +
              `${result.stats.rules} rule proposal(s), ${result.stats.conflicts} conflict(s), ` +
              `${result.stats.dropped} dropped.`,
          );
        }
        case 'rules': {
          const sub = rest[0];
          if (sub === 'list' || sub === undefined) {
            const rules = service.listRules();
            if (rules.length === 0) {
              return ok('No rules.');
            }
            return ok(
              rules
                .map((r) => `- [${r.state}] ${r.id} (${r.kind}) ${r.text}`)
                .join('\n'),
            );
          }
          const id = rest[1];
          if (!id) {
            return ok('usage: /memory rules <list|activate|rollback|deprecate> [ruleId]');
          }
          const stateMap: Record<string, 'approved' | 'rolled_back' | 'deprecated'> = {
            activate: 'approved',
            rollback: 'rolled_back',
            deprecate: 'deprecated',
          };
          const target = stateMap[sub];
          if (!target) {
            return ok('usage: /memory rules <list|activate|rollback|deprecate> [ruleId]');
          }
          const result = service.setRuleState(id, target);
          return ok(result.ok ? `Rule ${id} → ${target}.` : `Cannot update rule: ${result.reason}.`);
        }
        case 'skill': {
          const sub = rest[0];
          if (sub === 'list') {
            const files = listSkillFiles(config.skillsDir);
            return ok(files.length ? files.map((f) => `- ${f}`).join('\n') : 'No skill files yet.');
          }
          if (sub === 'promote') {
            const id = rest[1];
            if (!id) {
              return ok('usage: /memory skill promote <ruleId>');
            }
            const result = promoteRuleToSkill(service, id, config.skillsDir);
            return ok(result.ok ? `Promoted ${id} → ${result.path}.` : `Cannot promote: ${result.reason}.`);
          }
          return ok('usage: /memory skill <list|promote <ruleId>>');
        }
        case 'bus': {
          const bus = deps.bus;
          if (!bus) {
            return ok('Memory bus unavailable.');
          }
          const sub = rest[0];
          if (sub === 'blacklist') {
            const name = rest[1];
            if (!name) {
              return ok('usage: /memory bus blacklist <pluginName> [reason]');
            }
            bus.blacklistPlugin(name, rest.slice(2).join(' ') || undefined);
            return ok(`Blacklisted ${name}.`);
          }
          if (sub === 'unblacklist') {
            const name = rest[1];
            if (!name) {
              return ok('usage: /memory bus unblacklist <pluginName>');
            }
            bus.unblacklistPlugin(name);
            return ok(`Unblacklisted ${name}.`);
          }
          if (sub === 'list' || sub === 'blacklist-list') {
            const entries = bus.listBlacklist();
            return ok(entries.length ? entries.map((e) => `- ${e.name}${e.reason ? `: ${e.reason}` : ''}`).join('\n') : 'No blacklisted plugins.');
          }
          if (sub === 'revoke') {
            const id = rest[1];
            if (!id) {
              return ok('usage: /memory bus revoke <memoryId>');
            }
            const result = bus.revoke(id, { name: 'human', version: '1' });
            return ok(result.ok ? `Revoked ${id}.` : `Cannot revoke: ${result.reason}.`);
          }
          if (sub === 'writers') {
            const name = rest[1];
            const rows = name ? bus.listByWriter(name) : [];
            if (!name) {
              return ok('usage: /memory bus writers <pluginName>');
            }
            return ok(rows.length ? rows.map((r) => `- ${r.topic}: ${r.summary}`).join('\n') : `No active memories by ${name}.`);
          }
          return ok('usage: /memory bus <blacklist|unblacklist|list|revoke|writers>');
        }
        case 'git': {
          const gitStore = deps.gitStore;
          if (!gitStore) {
            return ok('Git versioning is disabled.');
          }
          const sub = rest[0];
          if (sub === 'status') {
            const { changed } = await gitStore.status();
            return ok(changed.length ? `Uncommitted:\n${changed.map((c) => `- ${c}`).join('\n')}` : 'Working tree clean.');
          }
          if (sub === 'log') {
            const commits = await gitStore.history(rest[1]);
            if (commits.length === 0) {
              return ok('No history.');
            }
            return ok(commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.date} ${c.message}`).join('\n'));
          }
          if (sub === 'rollback') {
            const [id, sha] = rest.slice(1);
            if (!id || !sha) {
              return ok('usage: /memory git rollback <memoryId> <sha>');
            }
            const result = await gitStore.rollback(id, sha);
            return ok(result.ok ? `Rolled back ${id} to ${sha.slice(0, 8)}.` : `Cannot rollback: ${result.reason}.`);
          }
          if (sub === 'restore') {
            const id = rest[1];
            if (!id) {
              return ok('usage: /memory git restore <memoryId>');
            }
            const result = await gitStore.restoreDeleted(id);
            return ok(result.ok ? `Restored deleted memory ${id}.` : `Cannot restore: ${result.reason}.`);
          }
          if (sub === 'remote') {
            const url = rest[1];
            if (!url) {
              return ok('usage: /memory git remote <url>');
            }
            await gitStore.setRemote(url);
            return ok(`Remote set to ${url}.`);
          }
          if (sub === 'push') {
            const result = await gitStore.push();
            return ok(result.ok ? 'Pushed.' : `Push failed: ${result.reason}.`);
          }
          if (sub === 'pull') {
            const result = await gitStore.pull();
            if (result.ok) {
              return ok(`Pulled (${result.applied ?? 0} entries reconciled).`);
            }
            return ok(`Pull conflicted on:\n${result.conflicts.map((c) => `- ${c}`).join('\n')}`);
          }
          if (sub === 'backup') {
            const out = rest[1];
            if (!out) {
              return ok('usage: /memory git backup <outPath>');
            }
            await gitStore.exportBundle(out);
            return ok(`Backup written to ${out}.`);
          }
          return ok('usage: /memory git <status|log|rollback|restore|remote|push|pull|backup>');
        }
        default:
          return ok(
            'commands: search <query> | list | stats | approve <id> | reject <id> | import <src> <path> | backfill <dir> | distill [path] | rules <...> | skill <...> | bus <...> | git <...>',
          );
      }
    },
  };
  ctx.effect(() => ctx.commands.register(command));
}
