/**
 * The `/memory` human command: search, list, stats and approval review.
 *
 * Approval decisions are human-only (this command dispatches without a model
 * turn), so governance cannot be delegated back to the model.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from '../domain/service.js';
import type { CommandDefinition } from './types.js';

export function registerCommand(ctx: Context, service: MemoryService): void {
  const command: CommandDefinition = {
    name: 'memory',
    usage: 'memory <search|list|stats|approve|reject> ...',
    description:
      'Manage dsh-mnemos memories: search across sessions, list active entries, show stats, and approve/reject proposed memories.',
    async handler(args, runtime) {
      const [verb, ...rest] = args.trim().split(/\s+/);
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
          const scope = rest[0] === 'global' || rest[0] === 'workspace' ? rest[0] : undefined;
          const rows = service.listActive(scope);
          if (rows.length === 0) {
            runtime.say('No active memories.');
            return;
          }
          runtime.say(
            rows
              .map((r) => `- [${r.type}] ${r.topic}: ${r.summary}`)
              .join('\n'),
          );
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
        default:
          runtime.say(
            'commands: search <query> | list [global|workspace] | stats | approve <id> | reject <id>',
          );
      }
    },
  };
  ctx.effect(() => ctx.commands.register(command));
}
