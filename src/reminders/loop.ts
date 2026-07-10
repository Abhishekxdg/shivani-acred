/**
 * Reminder delivery loop — a lightweight poller that fires one-shot reminders
 * when their due time arrives. Runs every ~30s: loads due, unfired reminders,
 * sends each through the paced WhatsApp queue, then marks it fired so it never
 * repeats.
 *
 * No-ops safely when Postgres is absent (listDue() returns [] in that case), and
 * a single overlap guard means a slow paced drain never lets the next tick
 * enqueue the same reminder twice.
 */
import { logger } from '../logger.js';
import { getPool } from '../db/pg.js';
import { sendMessage } from '../whatsapp/gateway.js';
import { enqueueSend } from '../whatsapp/pacing.js';
import { listDue, markFired } from './store.js';

const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // a previous (paced) drain is still in flight
  if (!getPool()) return; // Postgres absent → nothing to deliver
  running = true;
  try {
    const due = await listDue(new Date());
    for (const r of due) {
      try {
        await enqueueSend(() => sendMessage(r.target_jid, `⏰ Reminder: ${r.text}`));
        await markFired(r.id);
      } catch (e) {
        // Leave it unfired so the next tick retries; log and move on.
        logger.error(e, `reminder #${r.id} failed to deliver`);
      }
    }
  } catch (e) {
    logger.warn(e, 'reminder loop: could not load due reminders');
  } finally {
    running = false;
  }
}

/** Start the reminder poller. Idempotent — repeated calls are no-ops. */
export function startReminderLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Don't keep the process alive just for the poller.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('reminder loop started (~30s tick)');
}

/** Stop the poller (for graceful shutdown / tests). */
export function stopReminderLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
