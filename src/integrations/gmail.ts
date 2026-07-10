/**
 * Gmail integration (credential-gated).
 *
 * Degrades gracefully: OAuth credentials are read from the `connectors` table
 * (name='gmail') when Postgres is configured, else from `GOOGLE_*` env vars. If
 * neither yields a usable client, every function returns a clear
 * "Gmail not connected: run the setup in docs/integrations-setup.md" string
 * rather than throwing — so the base app boots fine with nothing configured.
 *
 * Each exported function returns a ready-to-send human string (result, the
 * not-connected notice, or a "Gmail error: ..." message). The tool layer stays
 * a thin wrapper that only adds arg parsing + audit.
 */
import { google, type gmail_v1 } from 'googleapis';
import { getPool, query } from '../db/pg.js';
import { type Connector } from '../db/types.js';
import { logger } from '../logger.js';

export const GMAIL_NOT_CONNECTED =
  'Gmail not connected: run the setup in docs/integrations-setup.md';

/** Coerce an unknown token/env value to a trimmed, non-empty string (or undefined). */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** Clamp a caller-supplied result count into a sane 1..50 range. */
function clampMax(n: number | undefined, dflt = 10): number {
  if (!Number.isFinite(n) || !n) return dflt;
  return Math.min(50, Math.max(1, Math.floor(n as number)));
}

/**
 * Read a connector's stored tokens from Postgres, or null when Postgres is not
 * configured / the row is absent / the lookup fails. Never throws.
 */
async function connectorTokens(name: string): Promise<Record<string, unknown> | null> {
  if (!getPool()) return null; // Postgres not configured — fall back to env.
  try {
    const rows = await query<Connector>('SELECT tokens FROM connectors WHERE name = $1 LIMIT 1', [
      name,
    ]);
    return rows[0]?.tokens ?? null;
  } catch (err) {
    logger.warn(err, `gmail connector lookup failed for '${name}'`);
    return null;
  }
}

interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  redirectUri?: string;
}

/** Merge connector-table tokens with GOOGLE_* env; null when unusable. */
async function resolveCreds(): Promise<GmailCreds | null> {
  const t = (await connectorTokens('gmail')) ?? {};
  const clientId = str(t.client_id) ?? str(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = str(t.client_secret) ?? str(process.env.GOOGLE_CLIENT_SECRET);
  const refreshToken = str(t.refresh_token) ?? str(process.env.GOOGLE_REFRESH_TOKEN);
  const accessToken = str(t.access_token) ?? str(process.env.GOOGLE_ACCESS_TOKEN);
  const redirectUri = str(t.redirect_uri) ?? str(process.env.GOOGLE_REDIRECT_URI);
  if (!clientId || !clientSecret) return null;
  if (!refreshToken && !accessToken) return null;
  return { clientId, clientSecret, refreshToken, accessToken, redirectUri };
}

function gmailClient(creds: GmailCreds): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
  auth.setCredentials({ refresh_token: creds.refreshToken, access_token: creds.accessToken });
  return google.gmail({ version: 'v1', auth });
}

function gmailError(err: unknown): string {
  logger.error(err, 'gmail api error');
  return `Gmail error: ${(err as Error)?.message ?? String(err)}`;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeB64(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Depth-first search for the first part matching a mime type; returns decoded text. */
function partByMime(part: gmail_v1.Schema$MessagePart | undefined, mime: string): string {
  if (!part) return '';
  if (part.mimeType === mime && part.body?.data) return decodeB64(part.body.data);
  for (const child of part.parts ?? []) {
    const found = partByMime(child, mime);
    if (found) return found;
  }
  return '';
}

/** Best-effort plain-text body: prefer text/plain, fall back to stripped text/html. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = partByMime(payload, 'text/plain');
  if (plain) return plain;
  const html = partByMime(payload, 'text/html');
  if (html) return html.replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim();
  return '';
}

/** Build a base64url-encoded RFC 2822 message for drafts.create / messages.send. */
function buildRaw(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const lines = [`To: ${opts.to}`];
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.body,
  );
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/**
 * Search (or list recent) messages. An empty query lists the inbox. Returns a
 * compact one-block-per-message summary with the id needed by gmailRead().
 */
export async function gmailSearch(queryStr: string | undefined, max?: number): Promise<string> {
  const creds = await resolveCreds();
  if (!creds) return GMAIL_NOT_CONNECTED;
  try {
    const gmail = gmailClient(creds);
    const q = str(queryStr) ?? 'in:inbox';
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: clampMax(max) });
    const ids = list.data.messages ?? [];
    if (!ids.length) return `No Gmail messages matched: ${q}`;
    const msgs = await Promise.all(
      ids.map((m) =>
        gmail.users.messages.get({
          userId: 'me',
          id: m.id as string,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        }),
      ),
    );
    return msgs
      .map((r) => {
        const d = r.data;
        return [
          `id: ${d.id}`,
          `from: ${header(d, 'From')}`,
          `date: ${header(d, 'Date')}`,
          `subject: ${header(d, 'Subject') || '(no subject)'}`,
          `snippet: ${(d.snippet ?? '').trim()}`,
        ].join('\n');
      })
      .join('\n\n');
  } catch (err) {
    return gmailError(err);
  }
}

/** Read one message in full: key headers + best-effort plain-text body. */
export async function gmailRead(id: string): Promise<string> {
  const creds = await resolveCreds();
  if (!creds) return GMAIL_NOT_CONNECTED;
  const messageId = str(id);
  if (!messageId) return 'Gmail error: a message id is required.';
  try {
    const gmail = gmailClient(creds);
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const d = res.data;
    const body = extractBody(d.payload) || (d.snippet ?? '').trim() || '(no text body)';
    return [
      `id: ${d.id}`,
      `from: ${header(d, 'From')}`,
      `to: ${header(d, 'To')}`,
      `date: ${header(d, 'Date')}`,
      `subject: ${header(d, 'Subject') || '(no subject)'}`,
      '',
      body,
    ].join('\n');
  } catch (err) {
    return gmailError(err);
  }
}

/** Create a draft (does NOT send). Returns the new draft id. */
export async function gmailDraft(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<string> {
  const creds = await resolveCreds();
  if (!creds) return GMAIL_NOT_CONNECTED;
  if (!str(opts.to)) return 'Gmail error: a recipient (to) is required.';
  try {
    const gmail = gmailClient(creds);
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: buildRaw(opts) } },
    });
    return `Draft created (id: ${res.data.id}) to ${opts.to} — subject "${opts.subject}". Not sent.`;
  } catch (err) {
    return gmailError(err);
  }
}

/** Send a message immediately. Returns the sent message id. */
export async function gmailSend(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<string> {
  const creds = await resolveCreds();
  if (!creds) return GMAIL_NOT_CONNECTED;
  if (!str(opts.to)) return 'Gmail error: a recipient (to) is required.';
  try {
    const gmail = gmailClient(creds);
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: buildRaw(opts) },
    });
    return `Sent to ${opts.to} — subject "${opts.subject}" (message id: ${res.data.id}).`;
  } catch (err) {
    return gmailError(err);
  }
}
