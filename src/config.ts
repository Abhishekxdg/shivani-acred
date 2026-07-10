import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4.5'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),

  // The controlling number(s). Only these may command the agent.
  OPERATOR_JIDS: z.string().min(1, 'OPERATOR_JIDS is required (the controlling number)'),

  AGENT_NAME: z.string().default('Shivani'),
  COMPANY_NAME: z.string().default('ACRED'),
  KB_PATH: z.string().default('./knowledge/acred-kb.md'),

  // "Name:number,Name:number" — used so tools can target a founder by name.
  FOUNDERS: z.string().default(''),
  FOUNDERS_GROUP_JID: z.string().default(''), // e.g. 1203630xxxxx@g.us
  CEO_JID: z.string().default(''), // weekly digest recipient; defaults to first operator

  // Proactive cadence (Shivani's operating rhythm). Off until founders are wired.
  ENABLE_CADENCE: z.string().default('false'),
  CHECKIN_CRON: z.string().default('0 9,13,17,21 * * *'), // ~4-hourly, daytime
  DIGEST_CRON: z.string().default('0 18 * * 5'), // Friday 18:00 weekly digest
  DAILY_CRON: z.string().default('0 19 * * *'), // daily 19:00 updates + focus report

  DATA_DIR: z.string().default('./data'),
  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(25),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  APP_TITLE: z.string().default('ACRED Shivani'),
  APP_URL: z.string().default('https://acred.in'),
  TZ: z.string().default('Asia/Kolkata'),
  BAILEYS_LOG_LEVEL: z.string().default('warn'),

  // Postgres long-term brain (pgvector). Unset => super-memory/people/skills
  // degrade to "not configured: set DATABASE_URL" and the base app still boots.
  DATABASE_URL: z.string().optional(),

  // Semantic search (OpenAI-compatible /embeddings). Unset => recall() uses
  // an ILIKE keyword fallback and embed() returns null.
  EMBEDDINGS_BASE_URL: z.string().optional(),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),

  // Self-evolution: repo/build/deploy layout used by deploy/watchdog/skills/plugins.
  REPO_ROOT: z.string().default(process.cwd()),
  SKILLS_DIR: z.string().default('skills'),
  PLUGINS_DIR: z.string().default('plugins'),
  WATCHDOG_ENTRY: z.string().default('dist/index.js'),
  HEALTH_WINDOW_MS: z.coerce.number().int().positive().default(20_000),
  SHIVANI_LOG_FILE: z.string().optional(),

  // Web search. Unset => web_search falls back to keyless DuckDuckGo HTML.
  SEARCH_API_URL: z.string().optional(),
  SEARCH_API_KEY: z.string().optional(),

  // Gmail OAuth (alt: connectors row name='gmail'). Optional — tools inert until set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // Notion internal integration secret (alt: connectors row name='notion').
  NOTION_TOKEN: z.string().optional(),

  // Outbound WhatsApp pacing (ban-avoidance). Safe defaults.
  WA_MIN_GAP_MS: z.coerce.number().int().nonnegative().default(4_000),
  WA_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  WA_JITTER_MS: z.coerce.number().int().nonnegative().default(2_000),

  // Group participation + collaborate-tier behavior.
  GROUP_ALLOWLIST: z.string().default(''), // extra group JIDs Shivani participates in
  REPLY_TO_ANYONE: z.string().default('true'), // reply to non-operator DMs (collaborate tier)
  GROUP_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(45_000),
  GROUP_MAX_PER_HOUR: z.coerce.number().int().positive().default(12),
  GROUP_TRIAGE_MODEL: z.string().default(''), // '' => main model
  SUBAGENT_MODEL: z.string().default(''), // '' => main model
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** Normalize a bare number or JID to a WhatsApp JID. Empty string stays empty. */
export function toJid(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (t.includes('@')) return t;
  return `${t.replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

/** Extract the bare phone-number local part from a user JID (drops device suffix). */
export function numberFromJid(jid?: string | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const local = jid.split('@')[0]?.split(':')[0]?.replace(/[^\d]/g, '') ?? '';
  return local || null;
}

export const operatorJids: string[] = config.OPERATOR_JIDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(toJid);

/** Canonical phone numbers of operators, for robust (LID/device-safe) matching. */
export const operatorNumbers: Set<string> = new Set(
  operatorJids.map((j) => numberFromJid(j)).filter((n): n is string => Boolean(n)),
);

export interface Founder {
  name: string;
  jid: string;
}

export const founders: Founder[] = config.FOUNDERS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const idx = pair.indexOf(':');
    const name = (idx >= 0 ? pair.slice(0, idx) : pair).trim();
    const num = idx >= 0 ? pair.slice(idx + 1).trim() : '';
    return { name, jid: toJid(num) };
  })
  .filter((f) => f.name && f.jid);

export const ceoJid: string = config.CEO_JID ? toJid(config.CEO_JID) : (operatorJids[0] ?? '');
export const foundersGroupJid: string = config.FOUNDERS_GROUP_JID.trim();
export const cadenceEnabled: boolean = config.ENABLE_CADENCE.trim().toLowerCase() === 'true';

export const groupAllowlist: string[] = config.GROUP_ALLOWLIST.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Groups Shivani actively participates in (founders' group + any allowlisted). */
export function isGroupAllowed(jid: string): boolean {
  if (!jid.endsWith('@g.us')) return false;
  return jid === foundersGroupJid || groupAllowlist.includes(jid);
}

/** Reply to non-operator DMs (collaborate tier) vs ignore strangers. */
export const replyToAnyone: boolean = config.REPLY_TO_ANYONE.trim().toLowerCase() === 'true';

/** Find a known founder by JID (device/@lid tolerant via phone number). */
export function founderByJid(jid: string): Founder | undefined {
  const n = numberFromJid(jid);
  return founders.find((f) => f.jid === jid || (n !== null && numberFromJid(f.jid) === n));
}
