import { llm, MODEL } from '../llm/openrouter.js';
import { config } from '../config.js';
import { store } from '../store/db.js';
import { logger } from '../logger.js';

/**
 * Decide whether Shivani should speak in a group right now. Order matters: the
 * cheap gates (addressed-by-name, cooldown, hourly cap, trivial) run BEFORE any
 * LLM call, so a burst of chatter does not trigger a model call per message.
 */
interface GroupState {
  lastReplyAt: number;
  hourStart: number;
  countThisHour: number;
}

const groupState = new Map<string, GroupState>();
const ADDRESS_RE = new RegExp(`\\b${config.AGENT_NAME}\\b`, 'i');

function stateFor(groupJid: string): GroupState {
  const now = Date.now();
  let s = groupState.get(groupJid);
  if (!s) {
    s = { lastReplyAt: 0, hourStart: now, countThisHour: 0 };
    groupState.set(groupJid, s);
  }
  if (now - s.hourStart > 3_600_000) {
    s.hourStart = now;
    s.countThisHour = 0;
  }
  return s;
}

/** Record that she just replied in a group (feeds cooldown + hourly cap). */
export function noteGroupReply(groupJid: string): void {
  const s = stateFor(groupJid);
  s.lastReplyAt = Date.now();
  s.countThisHour += 1;
}

export async function shouldRespondInGroup(
  groupJid: string,
  text: string,
  senderName: string,
): Promise<boolean> {
  const addressed = ADDRESS_RE.test(text);
  if (addressed) return true; // always answer when named

  const s = stateFor(groupJid);
  const now = Date.now();
  if (now - s.lastReplyAt < config.GROUP_COOLDOWN_MS) return false; // just spoke — stay quiet
  if (s.countThisHour >= config.GROUP_MAX_PER_HOUR) return false; // hourly cap
  if (text.trim().length < 3) return false; // "ok", emoji, etc.

  const history = store
    .recentMessages(groupJid, 15)
    .map((m) => (m.role === 'assistant' ? `${config.AGENT_NAME}: ${m.content}` : m.content))
    .join('\n');

  try {
    const res = await llm.chat.completions.create({
      model: config.GROUP_TRIAGE_MODEL || MODEL,
      temperature: 0,
      max_tokens: 3,
      messages: [
        {
          role: 'system',
          content: `You are ${config.AGENT_NAME}, a sharp teammate silently watching the founders' WhatsApp group. Decide if you should speak NOW. Speak ONLY when you add real value: someone is stuck/blocked, an answerable question, a commitment made worth logging, a reserved matter being decided, a number that conflicts with company data, or a genuinely useful nudge to stay on the money mission. Otherwise stay silent. Answer with exactly YES or NO.`,
        },
        {
          role: 'user',
          content: `Recent group messages:\n${history}\n\nLatest (from ${senderName || 'someone'}): ${text}\n\nSpeak now? YES or NO.`,
        },
      ],
    });
    const ans = (res.choices[0]?.message?.content ?? '').trim().toUpperCase();
    return ans.startsWith('Y');
  } catch (e) {
    logger.warn(e, 'group triage failed; staying silent');
    return false;
  }
}
