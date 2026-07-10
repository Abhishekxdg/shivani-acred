import cron from 'node-cron';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../store/db.js';

type ScheduledTask = ReturnType<typeof cron.schedule>;

interface Job {
  id: string;
  expr: string;
  instruction: string;
  task: ScheduledTask;
}

const jobs = new Map<string, Job>();

/** Set by index.ts: runs the agent with a prompt and delivers the result. */
let handler: ((instruction: string) => Promise<void>) | null = null;

export function setScheduleHandler(fn: (instruction: string) => Promise<void>): void {
  handler = fn;
}

function stopTask(id: string): void {
  const job = jobs.get(id);
  if (job) {
    job.task.stop();
    jobs.delete(id);
  }
}

/** Register a live cron job (does NOT persist — used by both addJob and reload). */
function register(id: string, expr: string, instruction: string): void {
  if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
  stopTask(id);
  const task = cron.schedule(
    expr,
    () => {
      logger.info({ id, expr }, 'cron fired');
      handler?.(instruction).catch((e) => logger.error(e, 'schedule handler error'));
    },
    { timezone: config.TZ },
  );
  jobs.set(id, { id, expr, instruction, task });
}

export function addJob(id: string, expr: string, instruction: string): string {
  register(id, expr, instruction);
  store.upsertSchedule(id, expr, instruction);
  return id;
}

export function removeJob(id: string): void {
  stopTask(id);
  store.deleteSchedule(id);
}

export function listJobs(): { id: string; expr: string; instruction: string }[] {
  return [...jobs.values()].map(({ id, expr, instruction }) => ({ id, expr, instruction }));
}

/** Re-register all persisted schedules on startup. Call after setScheduleHandler. */
export function loadSchedules(): void {
  for (const s of store.allSchedules()) {
    try {
      register(s.id, s.expr, s.instruction);
    } catch (e) {
      logger.error(e, `skipping invalid persisted schedule ${s.id}`);
    }
  }
  logger.info(`Reloaded ${jobs.size} scheduled task(s) from store.`);
}
