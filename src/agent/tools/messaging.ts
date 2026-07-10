import {
  sendMessage,
  sendPoll,
  sendImage,
  sendDocument,
  sendLocation,
} from '../../whatsapp/gateway.js';
import { resolveTarget } from '../../whatsapp/targets.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

const TO_DESC =
  'Recipient: "me"/"operator" (the current chat, default), "ceo", "group"/"founders", ' +
  'a founder name, a raw JID, or a bare number.';

export const sendMessageTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        'Proactively send a WhatsApp text to someone other than the current reply (e.g. a ' +
        'founder or the founders group). To just answer the operator, return text normally.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: TO_DESC },
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  async run(args, ctx) {
    const to = resolveTarget(args.to ? String(args.to) : undefined, ctx.actor);
    audit(ctx.actor, 'send_message', to);
    await sendMessage(to, String(args.text));
    return `Sent to ${to}`;
  },
};

export const sendPollTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_poll',
      description: 'Send a WhatsApp poll. Use for clean either/or decisions among founders.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: TO_DESC },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2-12 options.' },
          selectable_count: { type: 'number', description: 'How many options a voter may pick (default 1).' },
        },
        required: ['question', 'options'],
      },
    },
  },
  async run(args, ctx) {
    const to = resolveTarget(args.to ? String(args.to) : undefined, ctx.actor);
    const options = (args.options as unknown[]).map((o) => String(o));
    const selectable = args.selectable_count ? Number(args.selectable_count) : 1;
    audit(ctx.actor, 'send_poll', `${to}: ${String(args.question)}`);
    await sendPoll(to, String(args.question), options, selectable);
    return `Poll sent to ${to}`;
  },
};

export const sendDocumentTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_document',
      description: 'Send a file from the VM (or a URL) as a WhatsApp document.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: TO_DESC },
          path: { type: 'string', description: 'Local file path on the VM, or an http(s) URL.' },
          file_name: { type: 'string', description: 'Display filename (optional).' },
          caption: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  async run(args, ctx) {
    const to = resolveTarget(args.to ? String(args.to) : undefined, ctx.actor);
    const source = String(args.path);
    const fileName = args.file_name ? String(args.file_name) : source.split('/').pop() || 'file';
    audit(ctx.actor, 'send_document', `${to}: ${source}`);
    await sendDocument(to, source, fileName, 'application/octet-stream', args.caption ? String(args.caption) : undefined);
    return `Document sent to ${to}`;
  },
};

export const sendImageTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_image',
      description: 'Send an image from the VM (or a URL) over WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: TO_DESC },
          path: { type: 'string', description: 'Local image path on the VM, or an http(s) URL.' },
          caption: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  async run(args, ctx) {
    const to = resolveTarget(args.to ? String(args.to) : undefined, ctx.actor);
    audit(ctx.actor, 'send_image', `${to}: ${String(args.path)}`);
    await sendImage(to, String(args.path), args.caption ? String(args.caption) : undefined);
    return `Image sent to ${to}`;
  },
};

export const sendLocationTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_location',
      description: 'Send a WhatsApp location pin (e.g. a site or the studio).',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: TO_DESC },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
        },
        required: ['latitude', 'longitude'],
      },
    },
  },
  async run(args, ctx) {
    const to = resolveTarget(args.to ? String(args.to) : undefined, ctx.actor);
    audit(ctx.actor, 'send_location', to);
    await sendLocation(to, Number(args.latitude), Number(args.longitude));
    return `Location sent to ${to}`;
  },
};
