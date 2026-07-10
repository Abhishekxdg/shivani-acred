/**
 * Self-deploy pipeline — Shivani ships her own code changes, guarded so a bad
 * change can never brick her.
 *
 * Flow (all run from the repo root):
 *   1. selfTest()  — `npm run typecheck`. HARD GATE: never deploys if it fails.
 *   2. git add -A && git commit
 *   3. npm run build
 *   4. write ./data/redeploy.request — a sentinel the watchdog picks up to
 *      rebuild + restart the live process and health-check the new version.
 *
 * Survival guardrails:
 *   • On typecheck failure the working changes are stashed (recoverable via
 *     `git stash pop`) and the tree is left at the last-good commit — nothing
 *     ships.
 *   • On build failure we hard-reset back to the pre-deploy commit and rebuild
 *     it, so the on-disk dist stays consistent with a known-good source.
 *   • The watchdog (see ./watchdog.ts) performs the actual restart and an
 *     automatic rollback if the new build fails to come up after restart.
 *
 * Never throws for expected failures — it reports them as a status string.
 */
import { exec } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { audit } from '../control/audit.js';
import { logger } from '../logger.js';

const pexec = promisify(exec);

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const DATA_DIR = resolve(REPO_ROOT, config.DATA_DIR);
const SENTINEL = join(DATA_DIR, 'redeploy.request');
const COMMIT_MSG_FILE = join(DATA_DIR, 'commit-msg.txt');
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS ?? 10 * 60_000);

/** Single-quote a value for safe interpolation into a bash command. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunResult {
  ok: boolean;
  code: number | string;
  stdout: string;
  stderr: string;
}

async function run(command: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd: REPO_ROOT,
      timeout: DEPLOY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      shell: '/bin/bash',
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (e) {
    const err = e as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      ok: false,
      code: err.code ?? 'error',
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    };
  }
}

function tail(s: string, n = 2_000): string {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

async function headCommit(): Promise<string> {
  const r = await run('git rev-parse HEAD');
  return r.ok ? r.stdout.trim().split('\n')[0] ?? '' : '';
}

/** Run `npm run typecheck`. The gate: no deploy ever ships if this fails. */
export async function selfTest(): Promise<{ ok: boolean; output: string }> {
  const r = await run('npm run typecheck');
  return { ok: r.ok, output: tail(`${r.stdout}\n${r.stderr}`) };
}

/** Written into ./data/redeploy.request for the watchdog to act on. */
export interface SentinelPayload {
  changeDescription: string;
  /** Commit to roll back to if the new version fails to come up. */
  fromCommit: string;
  /** The freshly committed version being deployed. */
  toCommit: string;
  requestedAt: string;
}

/**
 * Test → commit → build → signal the watchdog. Returns a human-readable status.
 */
export async function selfDeploy(changeDescription: string): Promise<string> {
  const desc = changeDescription.trim() || 'self-deploy: unspecified change';
  audit('shivani', 'self_deploy.start', desc);

  await mkdir(DATA_DIR, { recursive: true });
  const fromCommit = await headCommit();

  // 1) HARD GATE: typecheck. On failure, stash the changes (recoverable) & stop.
  const test = await selfTest();
  if (!test.ok) {
    const stash = await run('git stash push --include-untracked -m "shivani-failed-deploy"');
    audit('shivani', 'self_deploy.aborted', 'typecheck failed');
    return (
      'Deploy ABORTED — typecheck failed, nothing shipped.\n' +
      (stash.ok
        ? 'Your working changes were stashed (recover with: git stash pop).\n'
        : 'Could not stash the changes; working tree left as-is.\n') +
      `\ntypecheck output:\n${test.output}`
    );
  }

  // 2) Commit everything in the working tree.
  await run('git add -A');
  const status = await run('git status --porcelain');
  if (status.ok && !status.stdout.trim()) {
    audit('shivani', 'self_deploy.noop', 'no changes to commit');
    return 'Nothing to deploy: the working tree is clean (no changes to commit).';
  }
  await writeFile(COMMIT_MSG_FILE, `shivani self-deploy: ${desc}\n`, 'utf8');
  const commit = await run(`git commit -F ${q(COMMIT_MSG_FILE)}`);
  if (!commit.ok) {
    audit('shivani', 'self_deploy.failed', 'git commit failed');
    return `Deploy failed at git commit (nothing shipped):\n${tail(commit.stderr || commit.stdout)}`;
  }
  const toCommit = await headCommit();

  // 3) Build. On failure, hard-reset to the pre-deploy commit and rebuild it so
  //    the on-disk dist stays consistent with known-good source.
  const build = await run('npm run build');
  if (!build.ok) {
    logger.error('self-deploy build failed; rolling source back to last good');
    await run(`git reset --hard ${q(fromCommit || 'HEAD~1')}`);
    await run('npm run build');
    audit('shivani', 'self_deploy.rolledback', `build failed; reset to ${fromCommit.slice(0, 8)}`);
    return (
      'Deploy FAILED at build — rolled the source back to the last good commit and rebuilt it.\n' +
      `Rolled back to: ${fromCommit.slice(0, 8) || '(unknown)'}\n` +
      `\nbuild output:\n${tail(`${build.stdout}\n${build.stderr}`)}`
    );
  }

  // 4) Signal the watchdog to restart the live process onto the new build.
  const payload: SentinelPayload = {
    changeDescription: desc,
    fromCommit,
    toCommit,
    requestedAt: new Date().toISOString(),
  };
  await writeFile(SENTINEL, JSON.stringify(payload, null, 2), 'utf8');
  audit('shivani', 'self_deploy.requested', `${fromCommit.slice(0, 8)} -> ${toCommit.slice(0, 8)}`);

  return (
    'Deploy staged successfully.\n' +
    `Committed ${toCommit.slice(0, 8)} and rebuilt. The watchdog will restart me on the new ` +
    'version and auto-roll-back if I fail to come up.\n' +
    `Change: ${desc}`
  );
}
