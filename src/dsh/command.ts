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
import { Llm } from '../domain/llm.js';
import { runDistillIncremental, DistillCursor } from '../domain/distill.js';
import { promoteRuleToSkill, listSkillFiles } from '../domain/skill.js';
import { MemoryBus } from '../domain/bus.js';
import { GitStore } from '../domain/gitstore.js';
import type { SignalCollector } from './hooks.js';

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
  const command: CommandDefinition = {
    name: 'mnemos',
    usage: 'mnemos <search|list|stats|approve|reject|import|backfill|distill|rules|skill> ...',
    description:
      'Manage dsh-mnemos memories: search across sessions, list active entries, show stats, approve/reject proposals, import/backfill history, distill sessions, manage rules and promote skills.',
    async handler(args, runtime) {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const scope = runtime.workspace ? 'workspace' : ('global' as const);
      switch (verb) {
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            runtime.say('usage: /mnemos search <query>');
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
            runtime.say('usage: /mnemos approve <approvalId>');
            return;
          }
          const result = service.approve(id, 'approve');
          runtime.say(result.ok ? `Approved memory ${result.memory?.id ?? id}.` : `Cannot approve: ${result.reason}.`);
          return;
        }
        case 'reject': {
          const id = Number(rest[0]);
          if (!Number.isInteger(id)) {
            runtime.say('usage: /mnemos reject <approvalId>');
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
            runtime.say('usage: /mnemos import <auto|claude|codex|chatgpt|dsh> <path>');
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
            runtime.say('usage: /mnemos backfill <session-log-dir>');
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
        case 'distill': {
          if (!llm) {
            runtime.say('LLM unavailable; distillation is disabled until a model adapter is mounted.');
            return;
          }
          const path = rest[0];
          let messages = collector ? collector.drain() : [];
          if (path && existsSync(path)) {
            const text = readFileSync(path, 'utf8');
            const source = detectSource(text);
            messages = source ? parseAny(text, source) : [];
            if (messages.length === 0) {
              runtime.say('No parseable messages in that file.');
              return;
            }
          } else if (messages.length === 0) {
            runtime.say('No buffered session messages to distill (or pass a transcript path).');
            return;
          }
          const result = await runDistillIncremental(
            llm,
            service,
            messages,
            deps.distillCursor,
            { scope, workspace: runtime.workspace, sessionId: runtime.sessionId },
          );
          deps.persistCursor(result.cursor);
          runtime.say(
            `Distilled ${result.stats.requested} messages → ${result.stats.memories} memory candidate(s), ` +
              `${result.stats.rules} rule proposal(s), ${result.stats.conflicts} conflict(s), ` +
              `${result.stats.dropped} dropped.`,
          );
          return;
        }
        case 'rules': {
          const sub = rest[0];
          if (sub === 'list' || sub === undefined) {
            const rules = service.listRules();
            if (rules.length === 0) {
              runtime.say('No rules.');
              return;
            }
            runtime.say(
              rules
                .map((r) => `- [${r.state}] ${r.id} (${r.kind}) ${r.text}`)
                .join('\n'),
            );
            return;
          }
          const id = rest[1];
          if (!id) {
            runtime.say('usage: /mnemos rules <list|activate|rollback|deprecate> [ruleId]');
            return;
          }
          const stateMap: Record<string, 'approved' | 'rolled_back' | 'deprecated'> = {
            activate: 'approved',
            rollback: 'rolled_back',
            deprecate: 'deprecated',
          };
          const target = stateMap[sub];
          if (!target) {
            runtime.say('usage: /mnemos rules <list|activate|rollback|deprecate> [ruleId]');
            return;
          }
          const result = service.setRuleState(id, target);
          runtime.say(result.ok ? `Rule ${id} → ${target}.` : `Cannot update rule: ${result.reason}.`);
          return;
        }
        case 'skill': {
          const sub = rest[0];
          if (sub === 'list') {
            const files = listSkillFiles(config.skillsDir);
            runtime.say(files.length ? files.map((f) => `- ${f}`).join('\n') : 'No skill files yet.');
            return;
          }
          if (sub === 'promote') {
            const id = rest[1];
            if (!id) {
              runtime.say('usage: /mnemos skill promote <ruleId>');
              return;
            }
            const result = promoteRuleToSkill(service, id, config.skillsDir);
            runtime.say(result.ok ? `Promoted ${id} → ${result.path}.` : `Cannot promote: ${result.reason}.`);
            return;
          }
          runtime.say('usage: /mnemos skill <list|promote <ruleId>>');
          return;
        }
        case 'bus': {
          const bus = deps.bus;
          if (!bus) {
            runtime.say('Memory bus unavailable.');
            return;
          }
          const sub = rest[0];
          if (sub === 'blacklist') {
            const name = rest[1];
            if (!name) {
              runtime.say('usage: /mnemos bus blacklist <pluginName> [reason]');
              return;
            }
            bus.blacklistPlugin(name, rest.slice(2).join(' ') || undefined);
            runtime.say(`Blacklisted ${name}.`);
            return;
          }
          if (sub === 'unblacklist') {
            const name = rest[1];
            if (!name) {
              runtime.say('usage: /mnemos bus unblacklist <pluginName>');
              return;
            }
            bus.unblacklistPlugin(name);
            runtime.say(`Unblacklisted ${name}.`);
            return;
          }
          if (sub === 'list' || sub === 'blacklist-list') {
            const entries = bus.listBlacklist();
            runtime.say(entries.length ? entries.map((e) => `- ${e.name}${e.reason ? `: ${e.reason}` : ''}`).join('\n') : 'No blacklisted plugins.');
            return;
          }
          if (sub === 'revoke') {
            const id = rest[1];
            if (!id) {
              runtime.say('usage: /mnemos bus revoke <memoryId>');
              return;
            }
            const result = bus.revoke(id, { name: 'human', version: '1' });
            runtime.say(result.ok ? `Revoked ${id}.` : `Cannot revoke: ${result.reason}.`);
            return;
          }
          if (sub === 'writers') {
            const name = rest[1];
            const rows = name ? bus.listByWriter(name) : [];
            if (!name) {
              runtime.say('usage: /mnemos bus writers <pluginName>');
              return;
            }
            runtime.say(rows.length ? rows.map((r) => `- ${r.topic}: ${r.summary}`).join('\n') : `No active memories by ${name}.`);
            return;
          }
          runtime.say('usage: /mnemos bus <blacklist|unblacklist|list|revoke|writers>');
          return;
        }
        case 'git': {
          const gitStore = deps.gitStore;
          if (!gitStore) {
            runtime.say('Git versioning is disabled.');
            return;
          }
          const sub = rest[0];
          if (sub === 'status') {
            const { changed } = await gitStore.status();
            runtime.say(changed.length ? `Uncommitted:\n${changed.map((c) => `- ${c}`).join('\n')}` : 'Working tree clean.');
            return;
          }
          if (sub === 'log') {
            const commits = await gitStore.history(rest[1]);
            if (commits.length === 0) {
              runtime.say('No history.');
              return;
            }
            runtime.say(commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.date} ${c.message}`).join('\n'));
            return;
          }
          if (sub === 'rollback') {
            const [id, sha] = rest.slice(1);
            if (!id || !sha) {
              runtime.say('usage: /mnemos git rollback <memoryId> <sha>');
              return;
            }
            const result = await gitStore.rollback(id, sha);
            runtime.say(result.ok ? `Rolled back ${id} to ${sha.slice(0, 8)}.` : `Cannot rollback: ${result.reason}.`);
            return;
          }
          if (sub === 'restore') {
            const id = rest[1];
            if (!id) {
              runtime.say('usage: /mnemos git restore <memoryId>');
              return;
            }
            const result = await gitStore.restoreDeleted(id);
            runtime.say(result.ok ? `Restored deleted memory ${id}.` : `Cannot restore: ${result.reason}.`);
            return;
          }
          if (sub === 'remote') {
            const url = rest[1];
            if (!url) {
              runtime.say('usage: /mnemos git remote <url>');
              return;
            }
            await gitStore.setRemote(url);
            runtime.say(`Remote set to ${url}.`);
            return;
          }
          if (sub === 'push') {
            const result = await gitStore.push();
            runtime.say(result.ok ? 'Pushed.' : `Push failed: ${result.reason}.`);
            return;
          }
          if (sub === 'pull') {
            const result = await gitStore.pull();
            if (result.ok) {
              runtime.say(`Pulled (${result.applied ?? 0} entries reconciled).`);
            } else {
              runtime.say(`Pull conflicted on:\n${result.conflicts.map((c) => `- ${c}`).join('\n')}`);
            }
            return;
          }
          if (sub === 'backup') {
            const out = rest[1];
            if (!out) {
              runtime.say('usage: /mnemos git backup <outPath>');
              return;
            }
            await gitStore.exportBundle(out);
            runtime.say(`Backup written to ${out}.`);
            return;
          }
          runtime.say('usage: /mnemos git <status|log|rollback|restore|remote|push|pull|backup>');
          return;
        }
        default:
          runtime.say(
            'commands: search <query> | list | stats | approve <id> | reject <id> | import <src> <path> | backfill <dir> | distill [path] | rules <...> | skill <...> | bus <...> | git <...>',
          );
      }
    },
  };
  ctx.effect(() => ctx.commands.register(command));
}
