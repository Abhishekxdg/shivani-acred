import { logger } from '../logger.js';

/**
 * Outbound pacing for WhatsApp — a single global serial queue that all bulk
 * sends flow through so we never trip WhatsApp's spam heuristics.
 *
 * Two independent guards, both enforced before every send:
 *   1. A minimum gap between sends, plus random jitter, so traffic never looks
 *      metronomic (a classic bot tell).
 *   2. A rolling per-hour cap, so a large broadcast can't burst past a safe
 *      hourly volume even if the min-gap alone would allow it.
 *
 * Tunables (env, all optional — sane ban-avoidance defaults):
 *   WA_MIN_GAP_MS   min ms between two sends           (default 4000)
 *   WA_MAX_PER_HOUR max sends in any rolling 60 min     (default 60)
 *   WA_JITTER_MS    extra random 0..N ms added to gap   (default 2000)
 */

const HOUR_MS = 3_600_000;

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const MIN_GAP_MS = intEnv('WA_MIN_GAP_MS', 4000);
const MAX_PER_HOUR = Math.max(1, intEnv('WA_MAX_PER_HOUR', 60));
const JITTER_MS = intEnv('WA_JITTER_MS', 2000);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Serial tail: every enqueued task chains off the previous one so the guards
// below run against a stable, single-threaded view of the send history.
let tail: Promise<unknown> = Promise.resolve();
let lastSentAt = 0;
let queueDepth = 0;
const sentTimestamps: number[] = []; // send times within the last hour (ascending)

function pruneWindow(now: number): void {
  const cutoff = now - HOUR_MS;
  while (sentTimestamps.length > 0 && sentTimestamps[0]! <= cutoff) {
    sentTimestamps.shift();
  }
}

/** Block until it is safe (gap + hourly cap) to perform the next send. */
async function acquireSlot(): Promise<void> {
  // 1. Hourly cap: if we're at the ceiling, wait for the oldest send in the
  //    window to age out, then re-check.
  for (;;) {
    pruneWindow(Date.now());
    if (sentTimestamps.length < MAX_PER_HOUR) break;
    const oldest = sentTimestamps[0]!;
    const waitMs = oldest + HOUR_MS - Date.now();
    logger.warn(
      { waitMs, maxPerHour: MAX_PER_HOUR },
      'WA pacing: hourly cap reached, holding send',
    );
    await sleep(Math.max(waitMs, 1000));
  }

  // 2. Min gap + jitter since the previous send.
  if (lastSentAt > 0) {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * (JITTER_MS + 1));
    const elapsed = Date.now() - lastSentAt;
    if (elapsed < gap) await sleep(gap - elapsed);
  }

  // Reserve the slot up front so a throwing send still costs pacing budget
  // (the message may well have reached WhatsApp before it errored back).
  const now = Date.now();
  lastSentAt = now;
  sentTimestamps.push(now);
}

/**
 * Run `fn` through the global pacing queue. Resolves/rejects with `fn`'s own
 * result; the queue keeps flowing regardless of individual failures. ALL bulk
 * outbound sends must go through this.
 */
export function enqueueSend<T>(fn: () => Promise<T>): Promise<T> {
  queueDepth++;
  const run = tail.then(async () => {
    try {
      await acquireSlot();
      return await fn();
    } finally {
      queueDepth--;
    }
  });
  // Swallow rejection on the shared tail so one failed send doesn't poison the
  // queue; the original `run` promise still surfaces the error to its caller.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface PacingStatus {
  minGapMs: number;
  maxPerHour: number;
  jitterMs: number;
  sentLastHour: number;
  remainingThisHour: number;
  queueDepth: number;
}

/** Snapshot of the pacer, for tool summaries and diagnostics. */
export function pacingStatus(): PacingStatus {
  pruneWindow(Date.now());
  return {
    minGapMs: MIN_GAP_MS,
    maxPerHour: MAX_PER_HOUR,
    jitterMs: JITTER_MS,
    sentLastHour: sentTimestamps.length,
    remainingThisHour: Math.max(0, MAX_PER_HOUR - sentTimestamps.length),
    queueDepth,
  };
}

/**
 * Rough wall-clock estimate (ms) to drain `count` sends at the current gap,
 * ignoring hourly-cap stalls. Handy for warning an operator before a big blast.
 */
export function estimateDrainMs(count: number): number {
  if (count <= 0) return 0;
  const avgGap = MIN_GAP_MS + JITTER_MS / 2;
  return Math.round((count - 1) * avgGap);
}
