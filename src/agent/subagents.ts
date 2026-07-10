import type OpenAI from 'openai';
import { llm, MODEL } from '../llm/openrouter.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { toolDefinitions, toolMap } from './tools/index.js';
import { toolAllowed, IN_PLACE_SEND_TOOLS } from './access.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface RawToolCall {
  id: string;
  type?: string;
  function?: { name: string; arguments?: string };
}

export interface SubagentOpts {
  /** Permission tier the worker runs at. Defaults to collaborate (safe). */
  isOperator?: boolean;
  model?: string;
  maxSteps?: number;
  actor?: string;
  chatJid?: string;
}

/**
 * Run a focused, stateless sub-agent for a self-contained task. It shares the
 * main toolbox but enforces the SAME two-tier permission model (so a worker
 * spawned by a collaborator can't touch the VM). Returns the worker's final text.
 */
export async function runSubagent(task: string, opts: SubagentOpts = {}): Promise<string> {
  const isOperator = opts.isOperator ?? false;
  const model = opts.model || config.SUBAGENT_MODEL || MODEL;
  const maxSteps = opts.maxSteps ?? 12;
  const actor = opts.actor ?? 'subagent';
  const chatJid = opts.chatJid ?? '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a focused sub-agent of ${config.AGENT_NAME}, ${config.COMPANY_NAME}'s chief of staff. Do exactly the task using your tools, then return a concise, useful result. Do not chat — just deliver.`,
    },
    { role: 'user', content: task },
  ];

  for (let step = 0; step < maxSteps; step++) {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await llm.chat.completions.create({
        model,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
      });
    } catch (e) {
      logger.error(e, 'subagent LLM request failed');
      return `Sub-agent error: ${(e as Error)?.message ?? String(e)}`;
    }

    const msg = completion.choices[0]?.message;
    if (!msg) return 'Sub-agent got an empty response.';
    messages.push(msg as ChatMessage);

    const calls = (msg.tool_calls ?? []) as unknown as RawToolCall[];
    if (calls.length === 0) {
      return (msg.content ?? '').trim() || '(no result)';
    }

    for (const call of calls) {
      let result: string;
      const name = call.function?.name;
      const tool = name ? toolMap.get(name) : undefined;
      if (!name || !tool) {
        result = `Unknown tool: ${name ?? '(none)'}`;
      } else if (!toolAllowed(name, isOperator) && !(IN_PLACE_SEND_TOOLS.has(name) && !isOperator)) {
        result = '🔒 Not permitted for this sub-agent (collaborate tier).';
      } else {
        try {
          const args = call.function?.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {};
          if (!isOperator && IN_PLACE_SEND_TOOLS.has(name)) args.to = chatJid;
          result = await tool.run(args, { actor, isOperator, chatJid });
        } catch (e) {
          result = `Tool error: ${(e as Error)?.message ?? String(e)}`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  return 'Sub-agent hit its step limit without finishing.';
}
