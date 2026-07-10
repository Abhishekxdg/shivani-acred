import { operatorNumbers, numberFromJid } from '../config.js';

/**
 * Is this message key from an operator? Robust to LID- and device-addressed
 * DMs: modern WhatsApp keys may carry the phone number in senderPn/participantPn
 * while remoteJid is an @lid or has a `:device` suffix. We compare canonical
 * phone numbers across every candidate field.
 */
export function isOperatorKey(key: unknown): boolean {
  const k = (key ?? {}) as Record<string, unknown>;
  const candidates = [k.remoteJid, k.senderPn, k.participant, k.participantPn];
  for (const c of candidates) {
    const n = numberFromJid(typeof c === 'string' ? c : null);
    if (n && operatorNumbers.has(n)) return true;
  }
  return false;
}

/** Extract the text body, unwrapping ephemeral / view-once envelopes first. */
export function extractText(message: unknown): string {
  const m = (message ?? {}) as Record<string, any>;
  const content: Record<string, any> =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.viewOnceMessageV2Extension?.message ??
    m;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ''
  );
}
