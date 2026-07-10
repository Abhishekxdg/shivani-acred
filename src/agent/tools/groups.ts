import { type WASocket } from '@whiskeysockets/baileys';
import {
  resolveSocket,
  createGroup,
  addToGroup,
  listGroups,
} from '../../whatsapp/groups.js';
import { enqueueSend, pacingStatus, estimateDrainMs } from '../../whatsapp/pacing.js';
import { resolveTarget } from '../../whatsapp/targets.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

const NOT_CONNECTED =
  'not configured: WhatsApp is not connected yet (or gateway.ts does not export ' +
  'getSocket() — see integration notes). Link the agent and retry.';

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.trim() !== '');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export const createGroupTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'create_group',
      description:
        'Create a new WhatsApp group with a subject and an initial set of participants ' +
        '(names of founders, bare numbers, or JIDs). Returns the new group JID.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The group name/subject.' },
          participants: {
            type: 'array',
            items: { type: 'string' },
            description: 'People to add: founder names, bare numbers, or raw JIDs.',
          },
        },
        required: ['subject', 'participants'],
      },
    },
  },
  async run(args, ctx) {
    const sock = await resolveSocket();
    if (!sock) return NOT_CONNECTED;

    const subject = String(args.subject ?? '').trim();
    if (!subject) return 'Provide a group subject.';
    const requested = asStringList(args.participants).map((p) => resolveTarget(p, ''));
    const members = requested.filter(Boolean);
    if (members.length === 0) return 'Provide at least one resolvable participant.';

    audit(ctx.actor, 'create_group', `${subject}: ${members.length} participants`);
    const group = await createGroup(sock, subject, members);
    return `Created group "${group.subject}" (${group.id}) with ${group.participants.length} participant(s).`;
  },
};

export const addToGroupTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_to_group',
      description:
        'Add participants to an existing WhatsApp group. Give the group JID (or ' +
        '"group"/"founders") and the people to add (names, numbers, or JIDs).',
      parameters: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            description: 'Target group JID, or "group"/"founders" for the founders group.',
          },
          participants: {
            type: 'array',
            items: { type: 'string' },
            description: 'People to add: founder names, bare numbers, or raw JIDs.',
          },
        },
        required: ['group', 'participants'],
      },
    },
  },
  async run(args, ctx) {
    const sock = await resolveSocket();
    if (!sock) return NOT_CONNECTED;

    const group = resolveTarget(String(args.group ?? ''), '');
    if (!group || !group.endsWith('@g.us')) {
      return 'Provide a valid group JID (ends with @g.us) or "group"/"founders".';
    }
    const members = asStringList(args.participants).map((p) => resolveTarget(p, '')).filter(Boolean);
    if (members.length === 0) return 'Provide at least one resolvable participant.';

    audit(ctx.actor, 'add_to_group', `${group}: ${members.length} participants`);
    const results = await addToGroup(sock, group, members);
    const summary = results.map((r) => `${r.jid}=${r.status}`).join(', ');
    return `Add to ${group}: ${summary || '(no response)'}`;
  },
};

export const listGroupsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_groups',
      description: 'List all WhatsApp groups this account is a member of, with JID and size.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run(_args, ctx) {
    const sock = await resolveSocket();
    if (!sock) return NOT_CONNECTED;

    audit(ctx.actor, 'list_groups', '');
    const groups = await listGroups(sock);
    if (groups.length === 0) return 'No groups found.';
    const lines = groups
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .map((g) => `- ${g.subject} (${g.size}) — ${g.id}`);
    return trim(`${groups.length} group(s):\n${lines.join('\n')}`);
  },
};

export const broadcastTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'broadcast',
      description:
        'Send the SAME WhatsApp text to many recipients individually, PACED to avoid ' +
        'bans (a minimum gap + jitter between sends and an hourly cap). Recipients may be ' +
        'founder names, bare numbers, or JIDs. This can take a while for large lists.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'array',
            items: { type: 'string' },
            description: 'Recipients: founder names, bare numbers, or raw JIDs.',
          },
          text: { type: 'string', description: 'The message to send to each recipient.' },
        },
        required: ['to', 'text'],
      },
    },
  },
  async run(args, ctx) {
    const sock: WASocket | null = await resolveSocket();
    if (!sock) return NOT_CONNECTED;

    const text = String(args.text ?? '');
    if (!text.trim()) return 'Provide a message to broadcast.';

    // Resolve + de-dupe recipients; drop anything that doesn't resolve.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const r of asStringList(args.to)) {
      const jid = resolveTarget(r, '');
      if (jid && !seen.has(jid)) {
        seen.add(jid);
        recipients.push(jid);
      }
    }
    if (recipients.length === 0) return 'No resolvable recipients provided.';

    const est = estimateDrainMs(recipients.length);
    audit(
      ctx.actor,
      'broadcast',
      `${recipients.length} recipients, ~${Math.round(est / 1000)}s, ${text.length} chars`,
    );

    let sent = 0;
    const failures: string[] = [];
    await Promise.allSettled(
      recipients.map((jid) =>
        enqueueSend(() => sock.sendMessage(jid, { text }))
          .then(() => {
            sent += 1;
          })
          .catch((e: unknown) => {
            failures.push(`${jid}: ${(e as Error)?.message ?? String(e)}`);
          }),
      ),
    );

    const status = pacingStatus();
    const parts = [
      `Broadcast done: ${sent}/${recipients.length} sent.`,
      failures.length > 0 ? `Failed: ${failures.length} (${failures.slice(0, 5).join('; ')})` : '',
      `Pacing: min ${status.minGapMs}ms gap, ${status.sentLastHour}/${status.maxPerHour} used this hour.`,
    ].filter(Boolean);
    return trim(parts.join('\n'));
  },
};
