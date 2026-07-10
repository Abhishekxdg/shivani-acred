import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { audit } from '../../control/audit.js';
import { killSwitch } from '../../control/killswitch.js';
import { type AgentTool, trim } from './types.js';

const pexec = promisify(exec);

export const shellTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a shell command on the Ubuntu VM and return stdout, stderr and exit code. ' +
        'Use for any system task: inspect the system, install packages, run scripts, ' +
        'manage services, query databases via CLIs, etc. Runs with the privileges of the ' +
        'agent process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute (run via bash -c).' },
          cwd: { type: 'string', description: 'Optional working directory.' },
        },
        required: ['command'],
      },
    },
  },
  async run(args, ctx) {
    const command = String(args.command ?? '');
    const cwd = args.cwd ? String(args.cwd) : undefined;
    audit(ctx.actor, 'shell', command);
    try {
      const { stdout, stderr } = await pexec(command, {
        cwd,
        timeout: config.SHELL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        shell: '/bin/bash',
        signal: killSwitch.signal(), // `!stop` aborts an in-flight command
      });
      return trim(`exit: 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    } catch (e) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return trim(
        `exit: ${err.code ?? 'error'}\nstdout:\n${err.stdout ?? ''}\nstderr:\n${err.stderr ?? err.message ?? ''}`,
      );
    }
  },
};
