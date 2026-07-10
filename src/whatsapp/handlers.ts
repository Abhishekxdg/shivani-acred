import { runAgent } from '../agent/core.js';
import { sendMessage, type IncomingMessage } from './gateway.js';
import { enqueueSend } from './pacing.js';
import { config, replyToAnyone, founderByJid } from '../config.js';
import { killSwitch } from '../control/killswitch.js';
import { audit } from '../control/audit.js';
import { logger } from '../logger.js';
import { store } from '../store/db.js';
import { shouldRespondInGroup, noteGroupReply } from './triage.js';
import { customerByJid } from '../outreach.js';

const HELP = [
  `${config.AGENT_NAME} — ${config.COMPANY_NAME} digital chief of staff.`,
  'Talk to me normally and I act, then report back.',
  '',
  'Operator commands (controlling number only):',
  '  !stop    — emergency stop (halt all actions, kill running command)',
  '  !resume  — reactivate after a stop',
  '  !status  — show agent status',
  '  !help    — this message',
].join('\n');

function statusText(): string {
  return [
    `Agent: ${config.AGENT_NAME} (${config.COMPANY_NAME})`,
    `Model: ${config.OPENROUTER_MODEL}`,
    `Kill switch: ${killSwitch.isStopped() ? 'ON (stopped)' : 'off (active)'}`,
  ].join('\n');
}

export async function handleMessage(msg: IncomingMessage): Promise<void> {
  if (msg.isGroup) return handleGroup(msg);
  return handleDm(msg);
}

async function handleDm(msg: IncomingMessage): Promise<void> {
  const { chatJid, senderJid, senderName, text, isOperator } = msg;
  const lower = text.toLowerCase();

  // Operator-only control commands.
  if (isOperator) {
    if (lower === '!help') return void (await sendMessage(chatJid, HELP));
    if (lower === '!stop' || lower === '!kill') {
      killSwitch.stop();
      audit(senderJid, 'killswitch_stop');
      return void (await sendMessage(
        chatJid,
        '🛑 Kill switch ON. Actions halted, running command aborted. Send "!resume".',
      ));
    }
    if (lower === '!resume') {
      killSwitch.resume();
      audit(senderJid, 'killswitch_resume');
      return void (await sendMessage(chatJid, '✅ Resumed. Agent is active again.'));
    }
    if (lower === '!status') return void (await sendMessage(chatJid, statusText()));
  }

  // Classify the sender: founder (personalized), known customer (sales mode), or
  // stranger (reply only if allowed).
  const founder = founderByJid(senderJid);
  const customer = !isOperator && !founder ? await customerByJid(senderJid) : null;
  if (!isOperator && !replyToAnyone && !founder && !customer) {
    audit(senderJid, 'ignored_dm', text.slice(0, 200));
    logger.warn({ senderJid }, 'Ignoring DM from unknown non-operator');
    return;
  }

  const mode: 'dm' | 'customer' = customer ? 'customer' : 'dm';
  try {
    const reply = await runAgent(chatJid, senderJid, text, {
      isOperator,
      mode,
      senderName: senderName || founder?.name || customer?.name,
    });
    await sendMessage(chatJid, reply);
  } catch (e) {
    logger.error(e, 'DM handler failed');
    try {
      await sendMessage(chatJid, '⚠️ Something went wrong handling that. The error is in the logs.');
    } catch {
      /* send also failed; already logged */
    }
  }
}

async function handleGroup(msg: IncomingMessage): Promise<void> {
  const { chatJid, senderJid, senderName, text, isOperator } = msg;

  // Record EVERY group message so context accumulates even when she stays silent.
  store.addMessage(chatJid, 'user', `${senderName || 'Someone'}: ${text}`);

  let speak = false;
  try {
    speak = await shouldRespondInGroup(chatJid, text, senderName);
  } catch (e) {
    logger.warn(e, 'group triage error');
  }
  if (!speak) return;

  try {
    const reply = await runAgent(chatJid, senderJid, `${senderName || 'Someone'}: ${text}`, {
      isOperator,
      mode: 'group',
      senderName,
      recordUser: false, // already stored above
    });
    noteGroupReply(chatJid);
    await enqueueSend(() => sendMessage(chatJid, reply)); // paced, ban-safe
  } catch (e) {
    logger.error(e, 'group handler failed');
  }
}
