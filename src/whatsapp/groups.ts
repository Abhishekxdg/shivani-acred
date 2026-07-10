import { type WASocket } from '@whiskeysockets/baileys';
import { toJid } from '../config.js';
import { logger } from '../logger.js';
import { enqueueSend } from './pacing.js';

/**
 * WhatsApp group management on top of the live Baileys socket.
 *
 * These helpers ACCEPT the socket (see `resolveSocket`) rather than reaching
 * into gateway.ts, which owns it privately. gateway.ts must expose the socket
 * for `resolveSocket` to find it — see the integration note. Until it does,
 * `resolveSocket` returns null and callers degrade to a clear "not connected"
 * message instead of throwing.
 */

// Cache the resolved accessor after the first probe (per process).
let cachedGetter: (() => WASocket | null) | null | undefined;

/**
 * Best-effort handle on the connected socket. Probes gateway.ts for a
 * `getSocket()` export without a static import, so the app still compiles and
 * boots before that accessor exists. Returns null when WhatsApp isn't linked
 * or the accessor is absent.
 */
export async function resolveSocket(): Promise<WASocket | null> {
  if (cachedGetter === undefined) {
    try {
      const gw = (await import('./gateway.js')) as unknown as Record<string, unknown>;
      const getter = gw.getSocket;
      cachedGetter = typeof getter === 'function' ? (getter as () => WASocket | null) : null;
      if (cachedGetter === null) {
        logger.warn('whatsapp/groups: gateway.ts exposes no getSocket(); group tools disabled');
      }
    } catch (e) {
      logger.warn(e, 'whatsapp/groups: could not load gateway.ts for socket access');
      cachedGetter = null;
    }
  }
  return cachedGetter ? cachedGetter() : null;
}

/** Normalize a bare number or JID into a user JID Baileys accepts as a member. */
function memberJid(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (t.includes('@')) return t;
  return toJid(t);
}

function normalizeMembers(participantJids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of participantJids) {
    const jid = memberJid(p);
    if (jid && !seen.has(jid)) {
      seen.add(jid);
      out.push(jid);
    }
  }
  return out;
}

export interface CreatedGroup {
  id: string;
  subject: string;
  participants: string[];
}

export interface GroupSummary {
  id: string;
  subject: string;
  size: number;
}

/** Result of a participant add/remove, per requested JID. */
export interface ParticipantResult {
  jid: string;
  status: string;
}

/** Create a group and seed it with participants. */
export async function createGroup(
  sock: WASocket,
  subject: string,
  participantJids: string[],
): Promise<CreatedGroup> {
  const members = normalizeMembers(participantJids);
  const meta = await sock.groupCreate(subject, members);
  return {
    id: meta.id,
    subject: meta.subject ?? subject,
    participants: (meta.participants ?? []).map((p) => p.id),
  };
}

/** Add participants to an existing group. */
export async function addToGroup(
  sock: WASocket,
  groupJid: string,
  participantJids: string[],
): Promise<ParticipantResult[]> {
  const members = normalizeMembers(participantJids);
  if (members.length === 0) return [];
  const res = await sock.groupParticipantsUpdate(groupJid, members, 'add');
  return res.map((r) => ({ jid: r.jid ?? '(unknown)', status: String(r.status) }));
}

/** Remove participants from a group. */
export async function removeFromGroup(
  sock: WASocket,
  groupJid: string,
  participantJids: string[],
): Promise<ParticipantResult[]> {
  const members = normalizeMembers(participantJids);
  if (members.length === 0) return [];
  const res = await sock.groupParticipantsUpdate(groupJid, members, 'remove');
  return res.map((r) => ({ jid: r.jid ?? '(unknown)', status: String(r.status) }));
}

/** List every group the linked account currently participates in. */
export async function listGroups(sock: WASocket): Promise<GroupSummary[]> {
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all).map((g) => ({
    id: g.id,
    subject: g.subject ?? '(no subject)',
    size: g.size ?? g.participants?.length ?? 0,
  }));
}

/**
 * Send a text to a group JID through the global pacer, so a group blast obeys
 * the same ban-avoidance rate limits as everything else.
 */
export async function sendToGroupPaced(
  sock: WASocket,
  groupJid: string,
  text: string,
): Promise<void> {
  await enqueueSend(() => sock.sendMessage(groupJid, { text }));
}
