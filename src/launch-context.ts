/**
 * Identifiers the gateway stamps into a provider child's environment so any
 * launcher, sandbox or shim downstream can correlate its own artefacts (a
 * container name, a per-call tmp directory, a log line) with the gateway's
 * request, job and session records. Only defined, non-empty fields are
 * exported.
 *
 * Every provider child, on both transports, is expected to receive these: the
 * CLI executor merges them at `spawnCliProcess`, and the ACP process manager
 * merges them when it resolves a provider spawn. Probe spawns (version and
 * help discovery, kit prompt discovery) are not requests and carry none.
 *
 * The merge is always applied LAST, after any caller-supplied env, so a caller
 * cannot masquerade as a different gateway request. The values are exported
 * verbatim: a correlation id is caller-supplied and unconstrained, so a
 * consumer must treat it as untrusted text.
 */
export interface LaunchContext {
  correlationId?: string;
  jobId?: string;
  sessionId?: string;
  provider?: string;
}

const LAUNCH_CONTEXT_ENV: ReadonlyArray<[keyof LaunchContext, string]> = [
  ["correlationId", "LLM_GATEWAY_CORRELATION_ID"],
  ["jobId", "LLM_GATEWAY_JOB_ID"],
  ["sessionId", "LLM_GATEWAY_SESSION_ID"],
  ["provider", "LLM_GATEWAY_PROVIDER"],
];

/** Project a LaunchContext onto the LLM_GATEWAY_* environment variables. */
export function launchContextEnv(context: LaunchContext | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!context) return env;
  for (const [field, name] of LAUNCH_CONTEXT_ENV) {
    const value = context[field];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return env;
}
