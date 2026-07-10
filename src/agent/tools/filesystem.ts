import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

export const readFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the VM filesystem.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  async run(args) {
    const content = await readFile(String(args.path), 'utf8');
    return trim(content, 20_000);
  },
};

export const writeFileTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (create or overwrite) a UTF-8 text file on the VM filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async run(args, ctx) {
    const path = String(args.path);
    const content = String(args.content ?? '');
    audit(ctx.actor, 'write_file', path);
    await writeFile(path, content, 'utf8');
    return `Wrote ${content.length} bytes to ${path}`;
  },
};

export const listDirTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries in a directory on the VM (d = dir, - = file).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  async run(args) {
    const entries = await readdir(String(args.path), { withFileTypes: true });
    return (
      entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n') || '(empty)'
    );
  },
};

export const makeDirTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'make_dir',
      description: 'Create a directory (recursively) on the VM.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  async run(args, ctx) {
    const path = String(args.path);
    audit(ctx.actor, 'make_dir', path);
    await mkdir(path, { recursive: true });
    return `Created ${path}`;
  },
};

export const removePathTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'remove_path',
      description: 'Delete a file or directory (recursive, force) on the VM. Irreversible.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  async run(args, ctx) {
    const path = String(args.path);
    audit(ctx.actor, 'remove_path', path);
    await rm(path, { recursive: true, force: true });
    return `Removed ${path}`;
  },
};
