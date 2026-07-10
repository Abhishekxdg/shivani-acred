/**
 * Two-tier tool access — enforced in the agent loop, not just the prompt.
 *
 * The controlling number (operator) may run everything. Everyone else gets the
 * "collaborate tier": only read/coordinate/advise tools. Anything that touches
 * the VM/system, the outside world, or is destructive is operator-only. This is
 * DENY-BY-DEFAULT: a tool is public only if it is explicitly listed here, so any
 * new or dynamically-loaded plugin tool is operator-only until whitelisted.
 */
export const PUBLIC_TOOLS = new Set<string>([
  // memory (read + record)
  'remember',
  'recall',
  'remember_fact',
  'search_memory',
  // coordination (record/read only)
  'log_commitment',
  'list_commitments',
  'add_person',
  'list_people',
  'assign_task',
  'list_tasks',
  'update_task',
  'record_report',
  'who_is_behind',
  // knowledge + drafting (read/produce, no side effects on the world)
  'web_search',
  'web_read',
  'draft_document',
  // harmless reads
  'list_schedules',
  'list_groups',
  'list_skills',
  // personalization + delegation (a worker inherits the caller's tier)
  'set_agent_name',
  'spawn_subagent',
  // workflows (read/compose; request_daily_update stays operator-only as it messages people)
  'focus_report',
  // customer outreach (contact_customer self-guards to operator/founders + known customers)
  'add_customer',
  'list_customers',
  'customer_note',
  'contact_customer',
  // lead pipeline (lead_followup stays operator-only — it messages leads)
  'add_lead',
  'list_leads',
  'qualify_lead',
  'assign_lead',
  'update_lead',
  // escalation (escalate_overdue stays operator-only — it messages the CEO)
  'list_overdue',
  // reserved-matter voting (founders act directly)
  'open_vote',
  'record_vote',
  'tally_vote',
  'close_vote',
  // collections (due_reminders stays operator-only — it messages people)
  'add_receivable',
  'list_receivables',
  'mark_paid',
  'receivables_summary',
  // one-shot reminders
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  // new-project intake
  'start_project',
  'list_projects',
  'project_detail',
  'add_project_milestone',
  'update_project',
  // branded proposals
  'generate_proposal',
]);

/**
 * send_* tools a collaborator may use ONLY to reply into the CURRENT chat (so
 * group polls / replies work, but a collaborator can't make her message third
 * parties). The core loop forces `to = chatJid` for these when the actor is not
 * the operator.
 */
export const IN_PLACE_SEND_TOOLS = new Set<string>(['send_message', 'send_poll']);

export function toolAllowed(name: string, isOperator: boolean): boolean {
  if (isOperator) return true;
  return PUBLIC_TOOLS.has(name);
}
