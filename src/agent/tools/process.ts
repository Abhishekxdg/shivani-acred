import { spawn } from 'node:child_process';
import { audit } from '../../control/audit.js';
import { logger } from '../../logger.js';
import { type AgentTool } from './types.js';

export const spawnBackgroundTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'spawn_background',
      description:
        'Start a long-running command in the background (detached) and return its PID. ' +
        'Use for servers/daemons that must keep running after this call returns. ' +
        'For short commands use the shell tool instead.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional working directory.' },
        },
        required: ['command'],
      },
    },
  },
  async run(args, ctx) {
    const command = String(args.command);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    audit(ctx.actor, 'spawn_background', command);
    return await new Promise<string>((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd,
        detached: true,
        stdio: 'ignore',
      });
      // spawn errors (bad cwd -> ENOENT, EMFILE, ...) surface asynchronously.
      // Without this listener Node re-throws them as an uncaughtException and
      // crashes the whole service.
      child.on('error', (e) => {
        logger.error(e, 'spawn_background failed');
        resolve(`Failed to start background process: ${(e as Error).message}`);
      });
      child.on('spawn', () => {
        child.unref();
        resolve(`Started background process pid=${child.pid}`);
      });
    });
  },
};

export const killProcessTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Send a signal to a process by PID (default SIGTERM).',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number' },
          signal: { type: 'string', description: 'e.g. SIGTERM, SIGKILL, SIGHUP.' },
        },
        required: ['pid'],
      },
    },
  },
  async run(args, ctx) {
    const pid = Number(args.pid);
    // Reject pid <= 0 (0 = own process group, negative = arbitrary group) and NaN.
    if (!Number.isInteger(pid) || pid <= 0) {
      return `Refusing to signal invalid pid: ${String(args.pid)} (must be a positive integer).`;
    }
    const signal = (args.signal ? String(args.signal) : 'SIGTERM') as NodeJS.Signals;
    audit(ctx.actor, 'kill_process', `${pid} ${signal}`);
    try {
      process.kill(pid, signal);
      return `Sent ${signal} to pid ${pid}`;
    } catch (e) {
      return `Could not signal pid ${pid}: ${(e as Error).message}`;
    }
  },
};
