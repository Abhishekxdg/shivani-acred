import { founders, ceoJid, foundersGroupJid, toJid } from '../config.js';

/**
 * Resolve a human-friendly target into a WhatsApp JID for the send_* tools.
 * Accepts: "me"/"operator" (the current chat), "ceo", "group"/"founders",
 * a founder's name, a raw JID, or a bare number. Falls back to `fallback`.
 */
export function resolveTarget(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const key = input.trim().toLowerCase();

  if (['me', 'operator', 'self', 'principal'].includes(key)) return fallback;
  if (key === 'ceo') return ceoJid || fallback;
  if (['group', 'founders', 'founders group', 'team'].includes(key)) {
    return foundersGroupJid || fallback;
  }

  const f = founders.find((x) => x.name.toLowerCase() === key);
  if (f) return f.jid;

  if (input.includes('@')) return input; // already a JID
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length >= 8) return toJid(digits);

  return fallback;
}
