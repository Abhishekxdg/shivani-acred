import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { join } from 'node:path';
import { config, isGroupAllowed } from '../config.js';
import { logger } from '../logger.js';
import { isOperatorKey, extractText } from './jid.js';

export interface IncomingMessage {
  /** The chat to reply into (DM JID or group JID). */
  chatJid: string;
  /** Who sent it (for permission + personalization). */
  senderJid: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  /** Is the SENDER the controlling number? */
  isOperator: boolean;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

// Baileys gets its OWN logger, pinned independently, so raising the app
// LOG_LEVEL for debugging never makes Baileys dump decrypted message contents
// or auth-handshake material into the app stream.
const waLogger = pino({ level: config.BAILEYS_LOG_LEVEL });

let sock: WASocket | null = null;
let reconnectDelay = 1_000; // grows on repeated failures (capped)

function requireSock(): WASocket {
  if (!sock) throw new Error('WhatsApp is not connected yet');
  return sock;
}

/** The live Baileys socket, or null before connection. Used by group/broadcast tools. */
export function getSocket(): WASocket | null {
  return sock;
}

export async function startWhatsApp(onMessage: MessageHandler): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(join(config.DATA_DIR, 'wa-auth'));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger: waLogger });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('Scan this QR in WhatsApp > Linked Devices to connect the agent:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      reconnectDelay = 1_000; // reset backoff on a clean connect
      logger.info('WhatsApp connected.');
      return;
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.error('Logged out. Delete data/wa-auth and re-scan the QR.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Another device took the session; reconnecting would fight it in a loop.
        logger.error('Connection replaced by another session. Not reconnecting.');
        return;
      }
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000); // exponential, capped 60s
      logger.warn({ code, delay }, 'WhatsApp connection closed; reconnecting after backoff');
      setTimeout(() => {
        startWhatsApp(onMessage).catch((e) => logger.error(e, 'reconnect failed'));
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const chatJid = m.key.remoteJid ?? '';
      const text = extractText(m.message).trim();
      if (!text) continue;
      const isGroup = chatJid.endsWith('@g.us');
      const isDM = chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@lid');
      // Participate in allowlisted groups only; ignore other groups + status broadcasts.
      if (isGroup && !isGroupAllowed(chatJid)) continue;
      if (!isGroup && !isDM) continue;
      const senderJid = isGroup ? (m.key.participant ?? '') : chatJid;
      const senderName = m.pushName ?? '';
      const isOperator = isOperatorKey(m.key);
      try {
        await onMessage({ chatJid, senderJid, senderName, text, isGroup, isOperator });
      } catch (e) {
        logger.error(e, 'onMessage handler error');
      }
    }
  });
}

// --- outbound -------------------------------------------------------------

export async function sendMessage(to: string, text: string): Promise<void> {
  await requireSock().sendMessage(to, { text });
}

export async function sendPoll(
  to: string,
  name: string,
  values: string[],
  selectableCount = 1,
): Promise<void> {
  await requireSock().sendMessage(to, { poll: { name, values, selectableCount } });
}

export async function sendImage(to: string, source: string, caption?: string): Promise<void> {
  await requireSock().sendMessage(to, { image: { url: source }, caption });
}

export async function sendDocument(
  to: string,
  source: string,
  fileName: string,
  mimetype = 'application/octet-stream',
  caption?: string,
): Promise<void> {
  await requireSock().sendMessage(to, { document: { url: source }, fileName, mimetype, caption });
}

export async function sendLocation(to: string, latitude: number, longitude: number): Promise<void> {
  await requireSock().sendMessage(to, {
    location: { degreesLatitude: latitude, degreesLongitude: longitude },
  });
}
