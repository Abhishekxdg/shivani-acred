/**
 * Watchdog — the survival supervisor that keeps Shivani alive across her own
 * self-deploys.
 *
 * Responsibilities:
 *   • Launch and keep the main process (dist/index.js) running; restart on crash
 *     with a small backoff.
 *   • Watch ./data/redeploy.request (written by selfDeploy in ./deploy.ts): on
 *     it, rebuild and restart the child onto the new version, then health-check.
 *   • AUTO-ROLLBACK: if the new version fails to come up, `git reset --hard` to
 *     the pre-deploy commit, rebuild, and restart — so a bad self-deploy can
 *     never brick her.
 *   • Snapshot the last-good commit after every healthy boot.
 *
 * This is a SEPARATE entry point from the app. In production it — not
 * dist/index.js — is the process systemd launches (see
 * deploy/shivani-watchdog.service). It deliberately avoids importing the app's
 * config module so a missing app env var can never take the supervisor down;
 * it reads only the couple of settings it needs directly from the environment.
 *
 * Health signal: with no HTTP endpoint on the app, "healthy" means the child
 * stays up for HEALTH_WINDOW_MS without exiting. (If the app is later made to
 * write a heartbeat file, this is where you'd also check its freshness.)
 */
import { spawn, exec, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const pexec = promisify(exec);

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const DATA_DIR = resolve(REPO_ROOT, process.env.DATA_DIR ?? './data');
const SENTINEL = join(DATA_DIR, 'redeploy.request');
const LAST_GOOD = join(DATA_DIR, 'last-good-commit');
const ENTRY = process.env.WATCHDOG_ENTRY ?? 'dist/index.js';
const NODE_BIN = process.execPath;

const HEALTH_WINDOW_MS = Number(process.env.HEALTH_WINDOW_MS ?? 20_000);
const RESTART_DELAY_MS = Number(process.env.RESTART_DELAY_MS ?? 3_000);
const POLL_MS = Number(process.env.WATCHDOG_POLL_MS ?? 3_000);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS ?? 10 * 60_000);

let child: ChildProcess | null = null;
let generation = 0; // increments on each intended (re)start
let shuttingDown = false; // set on SIGINT/SIGTERM
let busy = false; // a deploy/rollback cycle owns the child right now
let loopTimer: ReturnType<typeof setInterval> | null = null;

/** Single-quote a value for safe interpolation into a bash command. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runCmd(command: string): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd: REPO_ROOT,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      shell: '/bin/bash',
    });
    return { ok: true, out: `${stdout}\n${stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}` };
  }
}

async function currentCommit(): Promise<string> {
  const r = await runCmd('git rev-parse HEAD');
  return r.ok ? r.out.trim().split('\n')[0] ?? '' : '';
}

async function snapshotLastGood(): Promise<void> {
  const c = await currentCommit();
  if (!c) return;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(LAST_GOOD, c, 'utf8');
    logger.info(`watchdog: last-good = ${c.slice(0, 8)}`);
  } catch (err) {
    logger.warn(err, 'watchdog: could not write last-good marker');
  }
}

async function readLastGood(): Promise<string> {
  try {
    return (await readFile(LAST_GOOD, 'utf8')).trim();
  } catch {
    return '';
  }
}

/** Spawn dist/index.js. Auto-restarts on a crash UNLESS a deploy/shutdown owns it. */
function startChild(): ChildProcess {
  generation += 1;
  const gen = generation;
  logger.info(`watchdog: starting child (gen ${gen}): ${NODE_BIN} ${ENTRY}`);
  const proc = spawn(NODE_BIN, [ENTRY], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child = proc;
  proc.on('error', (err) => logger.error(err, 'watchdog: child spawn error'));
  proc.on('exit', (code, signal) => {
    logger.warn(`watchdog: child (gen ${gen}) exited code=${code} signal=${signal ?? ''}`);
    // Deploy/rollback and shutdown manage their own restarts; only the plain
    // crash path here restarts with a backoff.
    if (shuttingDown || busy || gen !== generation) return;
    if (child === proc) child = null;
    setTimeout(() => {
      if (!shuttingDown && !busy) startChild();
    }, RESTART_DELAY_MS);
  });
  return proc;
}

/** Stop the current child (SIGTERM, then SIGKILL) and wait for it to exit. */
async function stopChild(): Promise<void> {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolvePromise();
      }
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!done) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 8_000);
    setTimeout(finish, 12_000); // safety: never hang the supervisor
  });
}

/** Resolve true if the process stays up for the health window, false if it exits first. */
function waitHealthy(proc: ChildProcess): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(false); // exited before the window closed → unhealthy
    };
    proc.on('exit', onExit);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.off('exit', onExit);
      resolvePromise(proc.exitCode === null && proc.signalCode === null);
    }, HEALTH_WINDOW_MS);
  });
}

/** Reset source to a commit, rebuild, and restart. Used for auto-rollback. */
async function rollback(toCommit: string): Promise<void> {
  await stopChild();
  if (toCommit) {
    logger.warn(`watchdog: rolling back — git reset --hard ${toCommit.slice(0, 8)}`);
    await runCmd(`git reset --hard ${q(toCommit)}`);
  } else {
    logger.warn('watchdog: no rollback target known; rebuilding current tree');
  }
  const build = await runCmd('npm run build');
  if (!build.ok) {
    logger.error(`watchdog: rebuild after rollback FAILED:\n${build.out.slice(-1500)}`);
  }
  const proc = startChild();
  const healthy = await waitHealthy(proc);
  if (healthy) {
    await snapshotLastGood();
    logger.info('watchdog: rollback version is healthy');
  } else {
    logger.error(
      'watchdog: rollback version ALSO failed health check; leaving crash-restart to keep retrying',
    );
  }
}

/** Consume ./data/redeploy.request: rebuild, restart, health-check, auto-rollback. */
async function handleRedeploy(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    let payload: { fromCommit?: string; toCommit?: string; changeDescription?: string } = {};
    try {
      payload = JSON.parse(await readFile(SENTINEL, 'utf8')) as typeof payload;
    } catch {
      /* malformed or bare sentinel — proceed with a plain redeploy */
    }
    // Always consume the sentinel so we never loop on it.
    await rm(SENTINEL, { force: true }).catch(() => {});

    const rollbackTo =
      payload.fromCommit && payload.fromCommit.length >= 7
        ? payload.fromCommit
        : await readLastGood();
    logger.info(`watchdog: redeploy requested (${payload.changeDescription ?? 'no description'})`);

    // Rebuild the new version. If it won't even build, roll back immediately.
    const build = await runCmd('npm run build');
    if (!build.ok) {
      logger.error(`watchdog: build of new version failed; rolling back\n${build.out.slice(-1500)}`);
      await rollback(rollbackTo);
      return;
    }

    // Restart onto the new build and health-check it.
    await stopChild();
    const proc = startChild();
    const healthy = await waitHealthy(proc);
    if (healthy) {
      logger.info('watchdog: new version healthy; snapshotting last-good');
      await snapshotLastGood();
      return;
    }

    // New version failed to come up → auto-rollback.
    logger.error('watchdog: new version failed health check; auto-rolling-back');
    await rollback(rollbackTo);
  } finally {
    busy = false;
  }
}

async function sentinelExists(): Promise<boolean> {
  try {
    await stat(SENTINEL);
    return true;
  } catch {
    return false;
  }
}

function installSignalHandlers(): void {
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`watchdog: received ${sig}, shutting down child`);
    if (loopTimer) clearInterval(loopTimer);
    const proc = child;
    if (proc && proc.exitCode === null) {
      proc.once('exit', () => process.exit(0));
      try {
        proc.kill('SIGTERM');
      } catch {
        process.exit(0);
      }
      setTimeout(() => process.exit(0), 8_000);
    } else {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // The supervisor must survive its own stray async errors.
  process.on('unhandledRejection', (reason) =>
    logger.error(reason, 'watchdog: unhandledRejection'),
  );
  process.on('uncaughtException', (err) => logger.error(err, 'watchdog: uncaughtException'));
}

/** Start supervising. Launches the child, then polls for redeploy requests. */
export async function startWatchdog(): Promise<void> {
  logger.info(`watchdog: supervising ${ENTRY} from ${REPO_ROOT}`);
  await mkdir(DATA_DIR, { recursive: true });

  // Clear any stale sentinel from a previous run so we don't redeploy on boot.
  await rm(SENTINEL, { force: true }).catch(() => {});

  installSignalHandlers();

  // Baseline last-good = whatever is currently checked out.
  await snapshotLastGood();

  const proc = startChild();
  // Treat the first boot as the health baseline (best-effort re-snapshot).
  void waitHealthy(proc).then((ok) => {
    if (ok) void snapshotLastGood();
  });

  loopTimer = setInterval(() => {
    if (busy || shuttingDown) return;
    void (async () => {
      if (await sentinelExists()) {
        await handleRedeploy().catch((err) => {
          logger.error(err, 'watchdog: redeploy cycle failed');
          busy = false;
        });
      }
    })();
  }, POLL_MS);
}

// Runnable entry: `node dist/evolve/watchdog.js`.
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  startWatchdog().catch((err) => {
    logger.error(err, 'watchdog: fatal');
    process.exit(1);
  });
}
