import { store } from '../store/db.js';
import { logger } from '../logger.js';

/**
 * Patterns for inline secrets that must not land in the (often off-box) log
 * stream. The FULL, unredacted detail is still written to the access-controlled
 * SQLite audit table — only the log-stream copy is scrubbed.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization:\s*bearer\s+)\S+/gi, '$1***'],
  [/(pgpassword=)\S+/gi, '$1***'],
  [/(\bpassword=)\S+/gi, '$1***'],
  [/(\bapi[_-]?key=)\S+/gi, '$1***'],
  [/(\btoken=)\S+/gi, '$1***'],
  [/\bsk-[a-zA-Z0-9-]{8,}\b/g, 'sk-***'],
  [/(-p\s+)\S+/g, '$1***'],
];

function redact(detail?: string): string | undefined {
  if (!detail) return detail;
  let out = detail;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/**
 * Append-only audit log. Passive: it never blocks or gates the agent. It exists
 * so a runaway or a bad command is always traceable after the fact.
 */
export function audit(actor: string, action: string, detail?: string): void {
  store.audit(actor, action, detail); // full detail persisted (access-controlled DB)
  logger.info({ actor, action, detail: redact(detail) }, 'audit'); // redacted in log stream
}
