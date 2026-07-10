import { shellTool } from './shell.js';
import {
  readFileTool,
  writeFileTool,
  listDirTool,
  makeDirTool,
  removePathTool,
} from './filesystem.js';
import { spawnBackgroundTool, killProcessTool } from './process.js';
import { scheduleTool, listSchedulesTool, cancelScheduleTool } from './schedule.js';
import { rememberTool, recallTool } from './memory.js';
import {
  sendMessageTool,
  sendPollTool,
  sendDocumentTool,
  sendImageTool,
  sendLocationTool,
} from './messaging.js';
import { logCommitmentTool, listCommitmentsTool, closeCommitmentTool } from './commitments.js';
import { spawnSubagentTool } from './subagent.js';
import { setAgentNameTool } from './profile.js';
import { focusReportTool, requestDailyUpdateTool } from './workflows.js';
import {
  addCustomerTool,
  listCustomersTool,
  customerNoteTool,
  contactCustomerTool,
} from './outreach.js';
import { rememberFactTool, searchMemoryTool } from './memory-advanced.js';
import {
  addPersonTool,
  listPeopleTool,
  assignTaskTool,
  listTasksTool,
  updateTaskTool,
  recordReportTool,
  whoIsBehindTool,
} from './people.js';
import { evolveTools } from './evolve.js';
import { webSearchTool, webReadTool } from './web.js';
import { draftDocumentTool } from './docs.js';
import { gmailSearchTool, gmailReadTool, gmailDraftTool, gmailSendTool } from './gmail.js';
import { notionSearchTool, notionReadTool, notionWriteTool } from './notion.js';
import { createGroupTool, addToGroupTool, listGroupsTool, broadcastTool } from './groups.js';
import {
  addLeadTool,
  listLeadsTool,
  qualifyLeadTool,
  assignLeadTool,
  updateLeadTool,
  leadFollowupTool,
} from './leads.js';
import { listOverdueTool, escalateOverdueTool } from './escalation.js';
import { openVoteTool, recordVoteTool, tallyVoteTool, closeVoteTool } from './voting.js';
import {
  addReceivableTool,
  listReceivablesTool,
  markPaidTool,
  receivablesSummaryTool,
  dueRemindersTool,
} from './collections.js';
import { setReminderTool, listRemindersTool, cancelReminderTool } from './reminders.js';
import { acredosBookingsTool, acredosInventoryTool, acredosQueryTool } from './acredos.js';
import {
  startProjectTool,
  listProjectsTool,
  projectDetailTool,
  addProjectMilestoneTool,
  updateProjectTool,
} from './projects.js';
import { consolidateMemoryTool } from './memory-consolidate.js';
import { generateProposalTool } from './proposals.js';
import { type AgentTool } from './types.js';

/** The agent's full toolbox. Add a tool here and it is instantly available. */
export const tools: AgentTool[] = [
  // VM control
  shellTool,
  readFileTool,
  writeFileTool,
  listDirTool,
  makeDirTool,
  removePathTool,
  spawnBackgroundTool,
  killProcessTool,
  // Cadence + memory
  scheduleTool,
  listSchedulesTool,
  cancelScheduleTool,
  rememberTool,
  recallTool,
  // WhatsApp (rich messaging)
  sendMessageTool,
  sendPollTool,
  sendDocumentTool,
  sendImageTool,
  sendLocationTool,
  // Chief-of-staff coordination
  logCommitmentTool,
  listCommitmentsTool,
  closeCommitmentTool,
  // Super-memory (Postgres/pgvector)
  rememberFactTool,
  searchMemoryTool,
  // People, tasks & reports
  addPersonTool,
  listPeopleTool,
  assignTaskTool,
  listTasksTool,
  updateTaskTool,
  recordReportTool,
  whoIsBehindTool,
  // Personalization + sub-agents
  setAgentNameTool,
  spawnSubagentTool,
  // Workflows (daily rhythm + focus)
  focusReportTool,
  requestDailyUpdateTool,
  // Customer outreach
  addCustomerTool,
  listCustomersTool,
  customerNoteTool,
  contactCustomerTool,
  // Self-evolution (skills, plugins, self-deploy, diagnostics)
  ...evolveTools,
  // Web + documents
  webSearchTool,
  webReadTool,
  draftDocumentTool,
  // Gmail
  gmailSearchTool,
  gmailReadTool,
  gmailDraftTool,
  gmailSendTool,
  // Notion
  notionSearchTool,
  notionReadTool,
  notionWriteTool,
  // WhatsApp groups & broadcast
  createGroupTool,
  addToGroupTool,
  listGroupsTool,
  broadcastTool,
  // Lead pipeline
  addLeadTool,
  listLeadsTool,
  qualifyLeadTool,
  assignLeadTool,
  updateLeadTool,
  leadFollowupTool,
  // Escalation (overdue sweep)
  listOverdueTool,
  escalateOverdueTool,
  // Reserved-matter voting
  openVoteTool,
  recordVoteTool,
  tallyVoteTool,
  closeVoteTool,
  // Collections (receivables)
  addReceivableTool,
  listReceivablesTool,
  markPaidTool,
  receivablesSummaryTool,
  dueRemindersTool,
  // One-shot reminders
  setReminderTool,
  listRemindersTool,
  cancelReminderTool,
  // acred OS (Supabase reads)
  acredosBookingsTool,
  acredosInventoryTool,
  acredosQueryTool,
  // New-project intake
  startProjectTool,
  listProjectsTool,
  projectDetailTool,
  addProjectMilestoneTool,
  updateProjectTool,
  // Memory consolidation
  consolidateMemoryTool,
  // Branded proposals
  generateProposalTool,
];

export const toolDefinitions = tools.map((t) => t.definition);
export const toolMap = new Map(tools.map((t) => [t.definition.function.name, t]));

export type { AgentTool };
