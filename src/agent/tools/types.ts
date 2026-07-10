import type OpenAI from 'openai';

export interface ToolContext {
  /** WhatsApp JID of the person who triggered this run (for the audit log). */
  actor: string;
  /** Is the actor the controlling number? Gates operator-only tools. */
  isOperator: boolean;
  /** The chat this run is happening in (DM or group JID). */
  chatJid: string;
}

export interface AgentTool {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** Clamp tool output so a huge stdout never blows the model context window. */
export function trim(s: string, max = 12_000): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
