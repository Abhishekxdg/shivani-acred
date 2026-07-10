import type OpenAI from 'openai';
import { llm, MODEL } from '../llm/openrouter.js';
import { systemPrompt } from './personas.js';
import { toolDefinitions, toolMap } from './tools/index.js';
import { store } from '../store/db.js';
import { config, numberFromJid } from '../config.js';
import { logger } from '../logger.js';
import { killSwitch } from '../control/killswitch.js';
import { recallContext } from '../memory/store.js';
import { getProfile } from '../profiles.js';
import { toolAllowed, IN_PLACE_SEND_TOOLS } from './access.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface RawToolCall {
  id: string;
  type?: string;
  function?: { name: string; arguments?: string };
}

/**
 * Run the agent for one turn: LLM -> tool calls -> LLM -> ... until a final text
 * answer (or MAX_AGENT_STEPS). Only the user message and the final answer are
 * persisted; the intermediate tool transcript lives only for this call.
 */
export interface RunOpts {
  /** Is the sender the controlling number? Defaults true (operator DM / scheduled). */
  isOperator?: boolean;
  /** 'dm' (default), 'group', or 'customer' — changes her posture/persona. */
  mode?: 'dm' | 'group' | 'customer';
  /** Display name of the sender, for a personalized greeting. */
  senderName?: string;
  /** Skip storing the user message (the group path stores it itself). Default true. */
  recordUser?: boolean;
}

export async function runAgent(
  conversation: string,
  actor: string,
  userText: string,
  opts: RunOpts = {},
): Promise<string> {
  const isOperator = opts.isOperator ?? true;
  const mode = opts.mode ?? 'dm';
  const recordUser = opts.recordUser ?? true;

  if (killSwitch.isStopped()) {
    return '🛑 Agent is stopped (kill switch active). Send "!resume" to reactivate.';
  }

  if (recordUser) store.addMessage(conversation, 'user', userText);

  // Personalized face (per-founder) + memory scope. getProfile() returns null
  // (no personalization) when Postgres is absent, so this stays safe locally.
  const profile = mode === 'dm' ? await getProfile(actor) : null;
  const scopes =
    mode === 'dm' && !isOperator
      ? ['company', `profile:${numberFromJid(actor) ?? actor}`]
      : ['company'];

  const history = store.recentMessages(conversation, 30);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt({
        isOperator,
        mode,
        senderName: opts.senderName,
        profile: profile
          ? {
              agentName: profile.agent_name,
              ownerName: profile.owner_name,
              role: profile.role,
              lane: profile.lane,
            }
          : null,
      }),
    },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  // Super-memory: prepend the most relevant long-term memories for this turn,
  // scoped to the company brain + (for a founder DM) their private space.
  const memCtx = await recallContext(userText, 8, scopes);
  if (memCtx) messages.splice(1, 0, { role: 'system', content: memCtx });

  for (let step = 0; step < config.MAX_AGENT_STEPS; step++) {
    if (killSwitch.isStopped()) return '🛑 Stopped mid-task by kill switch.';

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await llm.chat.completions.create({
        model: MODEL,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
      });
    } catch (e) {
      logger.error(e, 'OpenRouter request failed');
      const errText = `⚠️ Model/API error: ${(e as Error)?.message ?? String(e)}`;
      store.addMessage(conversation, 'assistant', errText);
      return errText;
    }

    const msg = completion.choices[0]?.message;
    if (!msg) return '⚠️ Empty response from model.';
    messages.push(msg as ChatMessage);

    const toolCalls = (msg.tool_calls ?? []) as unknown as RawToolCall[];
    if (toolCalls.length > 0) {
      // Every tool_call MUST get a matching tool message, or the next request
      // 400s ("tool_calls must be followed by a tool message for each id").
      for (const call of toolCalls) {
        let result: string;
        if (killSwitch.isStopped()) {
          result = '🛑 Aborted by kill switch.';
        } else if (call.type && call.type !== 'function') {
          result = `Unsupported tool call type: ${call.type}`;
        } else if (!call.function) {
          result = 'Malformed tool call (no function).';
        } else {
          const name = call.function.name;
          const tool = toolMap.get(name);
          if (!tool) {
            result = `Unknown tool: ${name}`;
          } else if (!toolAllowed(name, isOperator) && !(IN_PLACE_SEND_TOOLS.has(name) && !isOperator)) {
            // Collaborate tier: refuse operator-only tools. Enforced HERE, in code,
            // not just asked of the model — so no one can talk her into a root shell.
            result =
              '🔒 Only the principal (the controlling number) can authorize that. I can advise or coordinate instead.';
          } else {
            try {
              const parsedArgs = call.function.arguments
                ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
                : {};
              // In-place exception: a collaborator may only send into the current chat.
              if (!isOperator && IN_PLACE_SEND_TOOLS.has(name)) parsedArgs.to = conversation;
              result = await tool.run(parsedArgs, { actor, isOperator, chatJid: conversation });
            } catch (e) {
              result = `Tool error: ${(e as Error)?.message ?? String(e)}`;
              logger.error(e, `tool ${name} failed`);
            }
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      if (killSwitch.isStopped()) return '🛑 Stopped mid-task by kill switch.';
      continue; // feed tool results back to the model
    }

    const text = (msg.content ?? '').trim() || '(no response)';
    store.addMessage(conversation, 'assistant', text);
    return text;
  }

  const bail = '⚠️ Reached the max reasoning steps without finishing. Reply "continue" or add detail.';
  store.addMessage(conversation, 'assistant', bail);
  return bail;
}
