import { config, operatorJids, cadenceEnabled } from './config.js';
import { logger } from './logger.js';
import { startWhatsApp, sendMessage } from './whatsapp/gateway.js';
import { handleMessage } from './whatsapp/handlers.js';
import { runAgent } from './agent/core.js';
import { setScheduleHandler, addJob, loadSchedules } from './scheduler/scheduler.js';
import { audit } from './control/audit.js';
import { initSchema } from './db/pg.js';
import { loadPlugins } from './evolve/plugins.js';
import { refreshSkillsCache } from './evolve/skills.js';
import { toolMap, toolDefinitions } from './agent/tools/index.js';
import { startReminderLoop } from './reminders/loop.js';

// Safety net: a stray async error must not kill this long-running service.
process.on('unhandledRejection', (reason) => logger.error(reason, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error(err, 'uncaughtException'));

const CHECKIN_INSTRUCTION =
  '[cadence] Time for a founder check-in. Per your mandate, message the founders (or the ' +
  'founders group) to ask what each achieved since last check-in, what is next, and any ' +
  'blockers. Log any commitments made with log_commitment. Then reply to me (the CEO) with a ' +
  'one-line status of who is on or behind pace on ELINA. Be brief and warm.';

const DIGEST_INSTRUCTION =
  '[cadence] Compose the weekly digest for the CEO: open commitments by owner (use ' +
  'list_commitments), what is overdue, who is behind pace on ELINA (~4 bookings/month target), ' +
  'and the single top risk to watch. Send it to the CEO.';

const DAILY_INSTRUCTION =
  '[cadence] Daily rhythm: use request_daily_update to ask each founder for today\'s update, ' +
  'then build focus_report and post it to the founders\' group — bluntly steer everyone off ' +
  'diversions back to the one money mission (ELINA sales, ~4 bookings/month).';

const ESCALATION_INSTRUCTION =
  '[escalation] Daily escalation sweep: call the escalate_overdue tool. It runs findOverdue() over ' +
  'open commitments + tasks and, only when something is slipping, sends the blunt summary to the ' +
  'CEO. Stay silent when nothing is overdue — never spam the CEO.';

const MEMORY_CONSOLIDATION_INSTRUCTION =
  '[memory-consolidation] Weekly memory hygiene: call consolidate_memory with NO scope so it sweeps ' +
  'every scope (dedup, summarize, decay). It returns a short report and never throws.';

async function main(): Promise<void> {
  logger.info(`Starting ${config.AGENT_NAME} — ${config.COMPANY_NAME} digital chief of staff`);
  logger.info(`Model: ${config.OPENROUTER_MODEL} via OpenRouter`);
  logger.info(`Operators: ${operatorJids.join(', ')}`);

  // Ensure the Postgres super-memory schema (pgvector + tables). Guarded so a
  // missing/unreachable Postgres never blocks boot — the app degrades to SQLite.
  try {
    await initSchema();
  } catch (e) {
    logger.warn(e, 'super-memory schema init skipped (Postgres not configured)');
  }

  // Load learned skills into the persona cache so systemPrompt() can render them.
  try {
    await refreshSkillsCache();
  } catch (e) {
    logger.warn(e, 'skills cache refresh skipped');
  }

  // Load dynamic plugins (*.plugin.js) into the live tool registry. loadPlugins()
  // never throws (missing ./plugins folder => empty result).
  try {
    const { tools: pluginTools, loaded, failed } = await loadPlugins();
    for (const t of pluginTools) {
      toolMap.set(t.definition.function.name, t);
      toolDefinitions.push(t.definition);
    }
    if (loaded.length || failed.length) {
      logger.info(`Plugins: ${loaded.length} loaded, ${failed.length} failed`);
    }
  } catch (e) {
    logger.warn(e, 'plugin load skipped');
  }

  // When a scheduled task fires: run the agent, deliver to each operator with
  // per-operator isolation so one failure never starves the rest.
  setScheduleHandler(async (instruction) => {
    await Promise.allSettled(
      operatorJids.map(async (op) => {
        try {
          const reply = await runAgent(op, op, instruction, { isOperator: true, mode: 'dm' });
          await sendMessage(op, reply);
        } catch (e) {
          logger.error(e, `scheduled delivery to ${op} failed`);
        }
      }),
    );
  });

  // Re-register schedules persisted before the last restart.
  loadSchedules();

  // Shivani's built-in operating rhythm (off until founders are wired + flag set).
  if (cadenceEnabled) {
    addJob('builtin-checkin', config.CHECKIN_CRON, CHECKIN_INSTRUCTION);
    addJob('builtin-digest', config.DIGEST_CRON, DIGEST_INSTRUCTION);
    addJob('builtin-daily', config.DAILY_CRON, DAILY_INSTRUCTION);
    addJob('builtin-escalation', '0 9 * * *', ESCALATION_INSTRUCTION);
    addJob('builtin-memory-consolidation', '0 4 * * 1', MEMORY_CONSOLIDATION_INSTRUCTION);
    logger.info('Cadence enabled: check-in + daily updates + weekly digest + escalation + memory consolidation registered.');
  } else {
    logger.info('Cadence disabled (set ENABLE_CADENCE=true once founders are configured).');
  }

  await startWhatsApp(handleMessage);

  // Fire-once reminder loop (idempotent; no-ops when Postgres is absent).
  try {
    startReminderLoop();
  } catch (e) {
    logger.warn(e, 'reminder loop start skipped');
  }

  audit('system', 'boot');
  logger.info('Boot complete. Waiting for WhatsApp QR scan / messages.');
}

main().catch((e) => {
  logger.error(e, 'fatal');
  process.exit(1);
});
