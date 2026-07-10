/**
 * Emergency stop. Not a guardrail on normal operation — it is an operator
 * command. When engaged: the agent stops starting new steps, refuses further
 * tool calls, and aborts any in-flight shell command via the shared signal.
 */
let stopped = false;
let controller = new AbortController();

export const killSwitch = {
  isStopped: (): boolean => stopped,
  /** Passed into child_process exec so a running command is killed on stop(). */
  signal: (): AbortSignal => controller.signal,
  stop: (): void => {
    stopped = true;
    controller.abort();
  },
  resume: (): void => {
    stopped = false;
    controller = new AbortController();
  },
};
