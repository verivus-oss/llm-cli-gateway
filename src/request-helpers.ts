/**
 * Pure, side-effect-free helpers for request argument planning.
 * Zero I/O, zero dependencies on index-scoped collaborators.
 */
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, isAbsolute } from "path";
import { randomUUID } from "crypto";
import { z } from "zod/v3";

/** Prefix for gateway-generated session IDs. Enforces provenance structurally. */
export const GATEWAY_SESSION_PREFIX = "gw-";

export interface SessionResumeResult {
  resumeArgs: string[];
  effectiveSessionId: string | undefined;
  userProvidedSession: boolean;
}

/**
 * Validate that a user-provided sessionId doesn't use the reserved gateway prefix.
 * Throws if the ID starts with "gw-" — this namespace is reserved for gateway-generated IDs.
 */
export function validateSessionId(sessionId: string): void {
  if (sessionId.startsWith(GATEWAY_SESSION_PREFIX)) {
    throw new Error(
      `Session ID "${sessionId}" uses reserved prefix "${GATEWAY_SESSION_PREFIX}". Gateway-generated session IDs cannot be used for --resume.`
    );
  }
}

/**
 * Pure function: determine --resume args and session provenance from request flags.
 * Does NOT perform any session I/O — callers handle create/update separately.
 */
/**
 * Reject CLI arg values that start with "-" to prevent argument injection.
 * spawn() doesn't invoke a shell so there's no shell injection, but a value
 * like "--dangerously-skip-permissions" passed as a tool name would be
 * interpreted as a flag by the child CLI.
 */
export function sanitizeCliArgValues(values: string[], fieldName: string): string[] {
  for (const v of values) {
    if (v.startsWith("-")) {
      throw new Error(
        `Invalid ${fieldName} value "${v}": values must not start with "-" (argument injection prevention)`
      );
    }
  }
  return values;
}

export function resolveSessionResumeArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return {
      resumeArgs: ["--resume", "latest"],
      effectiveSessionId: undefined,
      userProvidedSession: false,
    };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return {
      resumeArgs: ["--resume", opts.sessionId],
      effectiveSessionId: opts.sessionId,
      userProvidedSession: true,
    };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}

/**
 * Codex-specific resume planning.
 *
 * Codex CLI ≥ 0.30 exposes session resume as a subcommand (`codex exec resume`),
 * not a flag pair like Claude/Gemini/Grok. So we can't return a simple list of
 * args — we describe the *mode* and let the caller branch when building argv:
 *
 *   - "new"            → `codex exec [...flags] PROMPT`
 *   - "resume-by-id"   → `codex exec resume [...resume-safe flags] <SESSION_ID> PROMPT`
 *   - "resume-latest"  → `codex exec resume --last [...resume-safe flags] PROMPT`
 *
 * `codex exec resume` rejects sandbox/working-directory policy flags; the original session's approval
 * policy is inherited. Callers MUST filter those flags out of the flag set
 * when mode is one of the resume forms (see `prepareCodexRequest`).
 *
 * `sessionId` MUST be a real Codex session UUID (as recorded under
 * `~/.codex/sessions/`). Gateway-generated `gw-*` IDs are rejected, since
 * they are bookkeeping handles and would 404 against `codex resume`.
 */
export type CodexSessionMode = "new" | "resume-by-id" | "resume-latest";

export interface CodexSessionPlan {
  mode: CodexSessionMode;
  /** Real Codex session UUID. Present only when mode === "resume-by-id". */
  sessionId?: string;
}

export function resolveCodexSessionArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): CodexSessionPlan {
  if (opts.createNewSession) {
    return { mode: "new" };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return { mode: "resume-by-id", sessionId: opts.sessionId };
  }
  if (opts.resumeLatest) {
    return { mode: "resume-latest" };
  }
  return { mode: "new" };
}

/**
 * Grok-specific resume args. Grok accepts `--resume <id>` to resume a named session,
 * and `--continue` to resume the most recent session for the current working directory.
 * Unlike `resolveSessionResumeArgs`, "resume latest" maps to `--continue` (not `--resume latest`)
 * because Grok would interpret a literal "latest" as a session ID.
 */
export function resolveGrokSessionArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return {
      resumeArgs: ["--continue"],
      effectiveSessionId: undefined,
      userProvidedSession: false,
    };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return {
      resumeArgs: ["--resume", opts.sessionId],
      effectiveSessionId: opts.sessionId,
      userProvidedSession: true,
    };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}

/**
 * Mistral Vibe-specific resume args.
 *
 * Current Vibe defaults session logging on; older configs can explicitly set
 * `[session_logging] enabled = false`. The doctor checks that toggle before
 * callers rely on session continuity; this pure helper just emits the args.
 *
 * The args shape mirrors Grok (`--continue` for latest, `--resume <id>` for a
 * specific session) because Vibe exposes the same surface for its session log.
 */
export function resolveMistralSessionArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return {
      resumeArgs: ["--continue"],
      effectiveSessionId: undefined,
      userProvidedSession: false,
    };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return {
      resumeArgs: ["--resume", opts.sessionId],
      effectiveSessionId: opts.sessionId,
      userProvidedSession: true,
    };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}

/**
 * Vibe-specific permission mode mapping. Vibe replaces Grok's `--always-approve`
 * with an `--agent <name>` selector. When the caller does not set a permissionMode,
 * the gateway emits `--agent auto-approve` explicitly: omitting the flag would
 * let Vibe pick its own default which may not be auto-approve, surprising
 * programmatic callers.
 *
 * `--agent` takes an ARBITRARY name: Vibe resolves it against its own agent
 * registry — the always-available builtins below, plus install-gated builtins
 * (e.g. `lean`) and custom agents from `~/.vibe/agents/<name>.toml`. So the
 * gateway accepts any string and lets Vibe validate availability, rather than
 * pinning a closed list that would reject valid install-gated/custom agents.
 * The builtins are kept only for documentation and the request schema's example
 * text. (Verified against the installed Vibe 2.16.1 `BUILTIN_AGENTS`: `chat` is
 * not a selectable primary builtin and `explore` is a subagent, so neither is
 * listed; `lean` is an install-gated primary agent that callers may still pass.)
 */
export const MISTRAL_BUILTIN_AGENT_MODES = [
  "default",
  "plan",
  "accept-edits",
  "auto-approve",
] as const;
export type MistralAgentMode = string;
export const MISTRAL_DEFAULT_AGENT_MODE: MistralAgentMode = "auto-approve";

export interface PrepareMistralRequestInput {
  prompt: string;
  resolvedModel?: string;
  outputFormat?: string;
  permissionMode?: MistralAgentMode;
  allowedTools?: string[];
  /**
   * Vibe has no flag to deny tools; this is accepted in the schema for caller
   * parity with Grok/Claude but produces no CLI flag. The caller is expected to
   * emit a `logger.warn` when this is non-empty.
   */
  disallowedTools?: string[];
  /**
   * Phase 4 slice γ: emit `--trust` so non-interactive runs in fresh
   * workspaces skip Vibe's interactive trust prompt for this invocation
   * only (not persisted to `trusted_folders.toml`). Default undefined →
   * Vibe's prompt behaviour is preserved for existing callers.
   */
  trust?: boolean;
  /**
   * Phase 4 slice δ: emit `--max-turns N` to cap the agent-loop iteration
   * count (only applies in programmatic mode with `-p`).
   */
  maxTurns?: number;
  /**
   * Phase 4 slice δ: emit `--max-price DOLLARS` so the session is
   * interrupted when cumulative cost crosses the cap (programmatic mode
   * only).
   */
  maxPrice?: number;
  /**
   * Vibe 2.x supports `--max-tokens N` in programmatic mode, wired through to
   * `run_programmatic(max_session_tokens=...)`.
   */
  maxTokens?: number;
  /**
   * Phase 4 slice ζ: emit `--workdir <DIR>` so Vibe changes into the named
   * directory before running. Single value (Vibe accepts one --workdir).
   */
  workingDir?: string;
  /**
   * Phase 4 slice ζ: emit `--add-dir <DIR>` per directory. Vibe's `--help`
   * states the flag "Can be specified multiple times" — each entry is its
   * own argv pair.
   */
  addDir?: string[];
}

export interface PrepareMistralRequestResult {
  args: string[];
  env: Record<string, string>;
  ignoredDisallowedTools: boolean;
}

/**
 * Pure helper that builds Vibe's argv and env.
 *
 * - Model is selected via `VIBE_ACTIVE_MODEL` env var (NOT a `--model` flag).
 * - Permission mode emits `--agent <mode>` (defaults to `auto-approve` when unset).
 * - Allowed tools emit `--enabled-tools <tool>` once per tool (allowlist only).
 * - Output format emits `--output <text|json|streaming>` (legacy gateway
 *   aliases `plain` and `stream-json` are normalized before spawn).
 * - Disallowed tools are accepted but ignored at the CLI boundary.
 */
export function prepareMistralRequest(
  input: PrepareMistralRequestInput
): PrepareMistralRequestResult {
  const args: string[] = ["-p", input.prompt];
  const env: Record<string, string> = {};

  if (input.resolvedModel) {
    env.VIBE_ACTIVE_MODEL = input.resolvedModel;
  }

  if (input.outputFormat) {
    args.push("--output", normalizeMistralOutputFormat(input.outputFormat));
  }

  const mode = input.permissionMode ?? MISTRAL_DEFAULT_AGENT_MODE;
  args.push("--agent", mode);

  // No reasoning-effort surface on vibe: --effort / --reasoning-effort are not
  // emitted (the CLI rejects them; see upstream-contracts.ts mistral block).

  if (input.allowedTools && input.allowedTools.length > 0) {
    sanitizeCliArgValues(input.allowedTools, "allowedTools");
    for (const tool of input.allowedTools) {
      args.push("--enabled-tools", tool);
    }
  }

  if (input.trust) {
    args.push("--trust");
  }

  if (input.maxTurns !== undefined) {
    args.push("--max-turns", String(input.maxTurns));
  }
  if (input.maxPrice !== undefined) {
    args.push("--max-price", String(input.maxPrice));
  }
  if (input.maxTokens !== undefined) {
    args.push("--max-tokens", String(input.maxTokens));
  }
  if (input.workingDir) {
    args.push("--workdir", input.workingDir);
  }
  if (input.addDir && input.addDir.length > 0) {
    for (const dir of input.addDir) {
      args.push("--add-dir", dir);
    }
  }

  const ignoredDisallowedTools = Boolean(input.disallowedTools && input.disallowedTools.length > 0);

  return { args, env, ignoredDisallowedTools };
}

function normalizeMistralOutputFormat(format: string): string {
  if (format === "plain") return "text";
  if (format === "stream-json") return "streaming";
  return format;
}

//──────────────────────────────────────────────────────────────────────────────
// U24: Permission / approval mode parity helpers
//──────────────────────────────────────────────────────────────────────────────

/**
 * Claude `--permission-mode` values. `default` is a no-op (no flag emitted) —
 * matches the CLI's behavior when the flag is absent, and avoids hard-coding an
 * undocumented literal.
 */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export interface ClaudePermissionFlagsInput {
  permissionMode?: ClaudePermissionMode;
  /** Legacy parameter retained for one minor release. Maps to bypassPermissions. */
  dangerouslySkipPermissions?: boolean;
}

export interface ClaudePermissionFlagsResult {
  args: string[];
  /** Set when both legacy + new flag are passed; caller should logger.warn. */
  warning?: string;
}

/**
 * Resolve Claude's `--permission-mode` args.
 *
 * Precedence:
 *   1. If `permissionMode` is set, it wins. A warning is returned when
 *      `dangerouslySkipPermissions: true` is also set (legacy + new conflict).
 *   2. Else if `dangerouslySkipPermissions: true`, emit `--permission-mode
 *      bypassPermissions`.
 *   3. Else (or `permissionMode === "default"`) emit nothing.
 */
export function resolveClaudePermissionFlags(
  input: ClaudePermissionFlagsInput
): ClaudePermissionFlagsResult {
  const { permissionMode, dangerouslySkipPermissions } = input;
  let warning: string | undefined;

  if (permissionMode) {
    if (dangerouslySkipPermissions) {
      warning =
        "Both permissionMode and dangerouslySkipPermissions were provided; permissionMode wins. dangerouslySkipPermissions is deprecated.";
    }
    if (permissionMode === "default") {
      return { args: [], warning };
    }
    return { args: ["--permission-mode", permissionMode], warning };
  }

  if (dangerouslySkipPermissions) {
    return { args: ["--permission-mode", "bypassPermissions"] };
  }

  return { args: [] };
}

/**
 * Gemini `--approval-mode` values. Preserves existing values (`default`,
 * `auto_edit`, `yolo`) and adds `plan` for parity with Claude's plan mode.
 */
export const GEMINI_APPROVAL_MODES = ["default", "auto_edit", "yolo", "plan"] as const;
export type GeminiApprovalMode = (typeof GEMINI_APPROVAL_MODES)[number];

/**
 * Codex sandbox modes (for `--sandbox <mode>`).
 */
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/**
 * Deprecated Codex approval modes. Current Codex no longer exposes an
 * `--ask-for-approval` flag; the MCP input is temporarily retained so older
 * callers do not fail schema validation, but it emits no CLI argv.
 */
export const CODEX_ASK_FOR_APPROVAL_MODES = ["untrusted", "on-request", "never"] as const;
export type CodexAskForApproval = (typeof CODEX_ASK_FOR_APPROVAL_MODES)[number];

export interface CodexSandboxFlagsInput {
  /** Modern: explicit sandbox mode. */
  sandboxMode?: CodexSandboxMode;
  /** Deprecated compatibility input; current Codex exposes no approval-policy flag. */
  askForApproval?: CodexAskForApproval;
  /** Legacy: shorthand for sandbox=workspace-write. */
  fullAuto?: boolean;
  /**
   * Deprecated compatibility input. Current Codex rejects `--full-auto`, so
   * this no longer changes argv emission.
   */
  useLegacyFullAutoFlag?: boolean;
}

export interface CodexSandboxFlagsResult {
  args: string[];
  /** Set when deprecated/no-op compatibility inputs are supplied. */
  warning?: string;
}

/**
 * Resolve current Codex sandbox args from the modern params + legacy
 * `fullAuto` shorthand. Current Codex exposes `--sandbox`, but no longer
 * exposes `--ask-for-approval` or `--full-auto`.
 *
 * Precedence:
 *   1. Explicit `sandboxMode` emits `--sandbox <mode>`.
 *   2. Else if `fullAuto: true`, expand to `--sandbox workspace-write`.
 *   3. Deprecated `askForApproval` and `useLegacyFullAutoFlag` emit no argv
 *      and return warnings for callers to surface/log.
 *   4. Else emit nothing.
 */
export function resolveCodexSandboxFlags(input: CodexSandboxFlagsInput): CodexSandboxFlagsResult {
  const { sandboxMode, askForApproval, fullAuto, useLegacyFullAutoFlag } = input;
  const args: string[] = [];
  const warnings: string[] = [];

  if (useLegacyFullAutoFlag) {
    warnings.push(
      "useLegacyFullAutoFlag is deprecated and ignored because current Codex no longer accepts --full-auto."
    );
  }

  if (askForApproval) {
    warnings.push(
      "askForApproval is deprecated and ignored because current Codex no longer accepts --ask-for-approval."
    );
  }

  if (sandboxMode) {
    args.push("--sandbox", sandboxMode);
    if (fullAuto) {
      warnings.push(
        "fullAuto was set alongside explicit sandboxMode; sandboxMode wins. fullAuto is deprecated."
      );
    }
  } else if (fullAuto) {
    args.push("--sandbox", "workspace-write");
  }

  return { args, warning: warnings.length > 0 ? warnings.join(" ") : undefined };
}

/**
 * Flags that `codex exec resume` rejects (the original session's policy is
 * inherited). Callers must drop these when building resume argv.
 *
 * Verified against `codex exec resume --help` (codex-cli 0.135.0):
 * `--sandbox`, `--add-dir`, `-C`, `--cd`, `--profile`, and `--search` are rejected.
 * Deprecated `--full-auto` / `--ask-for-approval` are kept here defensively so
 * legacy pre-filtered segments are stripped instead of reaching spawn.
 * `--output-schema` and `-c key=value` ARE accepted on resume and therefore are
 * NOT in this filter (Phase 4 slice α restored the previously-silent drop of those two).
 */
export const CODEX_RESUME_FILTERED_FLAGS: ReadonlySet<string> = new Set([
  "--full-auto",
  "--sandbox",
  "--ask-for-approval",
  "--add-dir",
  "-C",
  "--cd",
  "--profile",
  "--search",
]);

/**
 * Codex flags that take exactly one value (consumed together with the flag).
 * `--full-auto` and `--search` are bare booleans and intentionally absent.
 */
const CODEX_RESUME_FILTERED_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--sandbox",
  "--ask-for-approval",
  "--add-dir",
  "-C",
  "--cd",
  "--profile",
]);

/**
 * Strip resume-incompatible flag/value pairs from a Codex argv segment.
 *
 * Bare flags (`--full-auto`, `--search`) drop without consuming a value.
 * Value-taking flags (`--sandbox`, `--ask-for-approval`, `--add-dir`, `-C`, `--cd`,
 * `--profile`) drop together with their immediately-following value.
 */
export function filterCodexResumeFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!CODEX_RESUME_FILTERED_FLAGS.has(a)) {
      out.push(a);
      continue;
    }
    if (CODEX_RESUME_FILTERED_FLAGS_WITH_VALUE.has(a)) {
      i += 1; // also skip the value
    }
  }
  return out;
}

//──────────────────────────────────────────────────────────────────────────────
// U25: Claude high-impact features
//──────────────────────────────────────────────────────────────────────────────

/**
 * Claude `--effort` enum values. Mirrors the model-side effort axis.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * Standalone Zod object for U25's high-impact param subset. Enforces the
 * `systemPrompt` / `appendSystemPrompt` mutual-exclusion via `.refine(...)`.
 *
 * The MCP SDK's `server.tool` takes a raw shape (no top-level refine), so the
 * tool callback re-checks the constraint and returns an error response. This
 * exported schema is what tests use to verify Zod-level enforcement.
 */
export const CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA = z
  .object({
    agent: z.string().optional(),
    agents: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    forkSession: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    effort: z.enum(CLAUDE_EFFORT_LEVELS).optional(),
    excludeDynamicSystemPromptSections: z.boolean().optional(),
  })
  .refine(data => !(data.systemPrompt !== undefined && data.appendSystemPrompt !== undefined), {
    message:
      "systemPrompt and appendSystemPrompt are mutually exclusive; use one or the other (not both).",
    path: ["appendSystemPrompt"],
  });

/**
 * Minimal Anthropic agent-definition schema. Mirrors the shape expected by
 * Claude CLI's `--agents` inline JSON argument. We validate the *required*
 * keys (`description`, `prompt`) up-front so a malformed payload fails fast
 * with an actionable error instead of producing an opaque CLI exit.
 */
export const CLAUDE_AGENT_DEFINITION_SCHEMA = z
  .object({
    description: z.string().min(1, "agent.description must be a non-empty string"),
    prompt: z.string().min(1, "agent.prompt must be a non-empty string"),
    tools: z.array(z.string()).optional(),
    model: z.string().optional(),
  })
  .passthrough();

export type ClaudeAgentDefinition = z.infer<typeof CLAUDE_AGENT_DEFINITION_SCHEMA>;

/**
 * Validate an `agents` map against {@link CLAUDE_AGENT_DEFINITION_SCHEMA}.
 *
 * Returns `{ ok: true, value }` on success and `{ ok: false, agentKey, message }`
 * on the first failing entry. The caller is responsible for turning the failure
 * into a tool-level error response (e.g. via `createErrorResponse`).
 */
export function validateClaudeAgentsMap(
  agents: Record<string, unknown>
):
  | { ok: true; value: Record<string, ClaudeAgentDefinition> }
  | { ok: false; agentKey: string; message: string } {
  const validated: Record<string, ClaudeAgentDefinition> = {};
  for (const [key, raw] of Object.entries(agents)) {
    const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.length ? `.${issue.path.join(".")}` : "";
      return {
        ok: false,
        agentKey: key,
        message: `Invalid agent definition for "${key}"${path}: ${issue?.message ?? "schema validation failed"}`,
      };
    }
    validated[key] = parsed.data;
  }
  return { ok: true, value: validated };
}

export interface ClaudeHighImpactFlagsInput {
  agent?: string;
  /** Pre-validated agents map (call {@link validateClaudeAgentsMap} first). */
  agents?: Record<string, ClaudeAgentDefinition>;
  forkSession?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  effort?: ClaudeEffortLevel;
  excludeDynamicSystemPromptSections?: boolean;
  /**
   * Phase 4 slice η — Claude `--fallback-model <model>`. Routes overloaded-model
   * requests to the named fallback. Only effective with `--print` (we always pass
   * `-p`, so no extra gating required here).
   */
  fallbackModel?: string;
  /**
   * Phase 4 slice η — Claude `--json-schema <schema>`. Per `claude --help`, the
   * argument is the JSON Schema *literal*, not a path. Object values are
   * `JSON.stringify`-d; string values are passed verbatim (caller already wrote
   * a JSON literal). No temp file lifecycle needed (contrast with Codex
   * `--output-schema`, which takes a path).
   */
  jsonSchema?: string | Record<string, unknown>;
  /**
   * Phase 4 slice ζ — Claude `--add-dir <dirs...>`. Additional directories the
   * Claude CLI is allowed to read/write beyond the process cwd. The CLI accepts
   * a single variadic flag (space-separated values) per `claude --help`; we
   * emit one `--add-dir` instance per directory so each path is its own argv
   * token (survives any future tightening of the variadic parser without
   * changing the call site).
   */
  addDir?: string[];
  /**
   * Claude `--no-session-persistence`: do not write this session to disk
   * (one-shot / ephemeral runs; mirrors Codex `--ephemeral`).
   */
  noSessionPersistence?: boolean;
  /**
   * Claude `--setting-sources <user,project,local>`: comma-separated list of
   * setting sources to load, for reproducible / isolated headless runs.
   * Passed through verbatim.
   */
  settingSources?: string;
  /**
   * Claude `--settings <file-or-json>`: load additional settings from a JSON
   * file path or a JSON literal. Powerful: settings can define hooks,
   * permissions, and model; the value is passed through verbatim.
   */
  settings?: string;
  /**
   * Claude `--tools <tools...>`: restrict the available built-in tool set
   * (distinct from `--allowed-tools` permission gating). Emitted as a single
   * variadic flag mirroring `--allowed-tools`; pass `[""]` to disable all
   * tools per `claude --help`. An empty array emits nothing.
   */
  tools?: string[];
}

/**
 * Emit Claude high-impact feature flags (U25) as a flat argv segment.
 *
 * Mutual-exclusion of `systemPrompt`/`appendSystemPrompt` is enforced upstream
 * at the Zod schema (`.refine(...)`); this helper does *not* re-check it, so
 * tests can exercise either flag in isolation.
 */
export function prepareClaudeHighImpactFlags(input: ClaudeHighImpactFlagsInput): string[] {
  const args: string[] = [];

  if (input.agent) {
    args.push("--agent", input.agent);
  }
  if (input.agents && Object.keys(input.agents).length > 0) {
    args.push("--agents", JSON.stringify(input.agents));
  }
  if (input.forkSession) {
    args.push("--fork-session");
  }
  if (input.systemPrompt !== undefined) {
    args.push("--system-prompt", input.systemPrompt);
  }
  if (input.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", input.appendSystemPrompt);
  }
  if (input.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(input.maxBudgetUsd));
  }
  if (input.maxTurns !== undefined) {
    args.push("--max-turns", String(input.maxTurns));
  }
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  if (input.excludeDynamicSystemPromptSections) {
    args.push("--exclude-dynamic-system-prompt-sections");
  }
  if (input.fallbackModel !== undefined) {
    args.push("--fallback-model", input.fallbackModel);
  }
  if (input.jsonSchema !== undefined) {
    const schemaArg =
      typeof input.jsonSchema === "string" ? input.jsonSchema : JSON.stringify(input.jsonSchema);
    args.push("--json-schema", schemaArg);
  }
  if (input.addDir && input.addDir.length > 0) {
    for (const dir of input.addDir) {
      args.push("--add-dir", dir);
    }
  }
  if (input.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (input.settingSources !== undefined) {
    args.push("--setting-sources", input.settingSources);
  }
  if (input.settings !== undefined) {
    args.push("--settings", input.settings);
  }
  if (input.tools && input.tools.length > 0) {
    // Single variadic flag (mirrors --allowed-tools emission). `[""]` → `--tools ""`
    // which disables all built-in tools per `claude --help`.
    args.push("--tools", ...input.tools);
  }

  return args;
}

//──────────────────────────────────────────────────────────────────────────────
// U26: Codex high-impact features
//──────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for Codex `configOverrides` map.
 *
 * Hard requirements (argv-injection prevention):
 *   - Keys MUST match /^[a-zA-Z0-9._]+$/ (no whitespace, no equals, no flag-like prefixes).
 *   - Values MUST NOT contain CR or LF — newlines could be re-interpreted by the
 *     CLI's TOML parser as new keys.
 *
 * The CLI consumes overrides as `-c key=value`. We rely on `spawn(..., args)`
 * passing argv directly without a shell, so we forbid shape-breaking
 * characters rather than shell-escaping values.
 */
export const CODEX_CONFIG_OVERRIDES_SCHEMA = z
  .record(
    z
      .string()
      .regex(
        /^[a-zA-Z0-9._]+$/,
        "configOverrides keys must match /^[a-zA-Z0-9._]+$/ (no whitespace, '=', or flag-like prefixes)"
      ),
    z.string().refine(v => !/[\n\r]/.test(v), {
      message: "configOverrides values must not contain CR or LF characters",
    })
  )
  .optional();

export type CodexConfigOverrides = z.infer<typeof CODEX_CONFIG_OVERRIDES_SCHEMA>;

/**
 * Emit `-c key=value` pairs for each override. Caller MUST have validated the
 * map with {@link CODEX_CONFIG_OVERRIDES_SCHEMA} first.
 */
export function emitCodexConfigOverrideArgs(
  overrides: Record<string, string> | undefined
): string[] {
  if (!overrides) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    args.push("-c", `${key}=${value}`);
  }
  return args;
}

/**
 * Materialize `outputSchema` into a CLI path.
 *
 * If `outputSchema` is a string, treat it as a pre-existing path and pass it
 * through verbatim (no temp file, no cleanup needed).
 *
 * If it is an object, JSON-serialize it into a 0o600-mode temp file under
 * `os.tmpdir()` and return both the path and a cleanup function. The caller
 * MUST invoke `cleanup()` in a `finally` block (no matter the exit path) so
 * the temp file does not leak.
 *
 * Returns `null` when `outputSchema` is undefined.
 */
export interface CodexOutputSchemaResult {
  path: string;
  /** No-op when schema came in as a string. Idempotent. */
  cleanup: () => void;
}

export function prepareCodexOutputSchema(
  outputSchema: string | Record<string, unknown> | undefined
): CodexOutputSchemaResult | null {
  if (outputSchema === undefined) return null;

  if (typeof outputSchema === "string") {
    return { path: outputSchema, cleanup: () => {} };
  }

  const filename = `codex-schema-${randomUUID()}.json`;
  const path = join(tmpdir(), filename);
  writeFileSync(path, JSON.stringify(outputSchema), { mode: 0o600 });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      unlinkSync(path);
    } catch {
      // Best-effort: if the file is already gone, ignore.
    }
  };

  return { path, cleanup };
}

/**
 * Validate that every image path exists on disk. Returns the first missing
 * path on failure; `null` on success.
 */
export function findMissingImagePath(images: string[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  for (const p of images) {
    if (!existsSync(p)) return p;
  }
  return null;
}

/**
 * Zod schema for the U26 Codex high-impact feature subset. Used by the
 * `codex_request` / `codex_request_async` tool schemas to validate the new
 * params before they reach `prepareCodexRequest`.
 */
export const CODEX_HIGH_IMPACT_PARAMS_SCHEMA = z.object({
  outputSchema: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  search: z.boolean().optional(),
  profile: z.string().optional(),
  configOverrides: CODEX_CONFIG_OVERRIDES_SCHEMA,
  ephemeral: z.boolean().optional(),
  images: z.array(z.string()).optional(),
  ignoreUserConfig: z.boolean().optional(),
  ignoreRules: z.boolean().optional(),
});

export interface CodexHighImpactFlagsInput {
  outputSchema?: string | Record<string, unknown>;
  search?: boolean;
  profile?: string;
  configOverrides?: Record<string, string>;
  ephemeral?: boolean;
  images?: string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface CodexHighImpactFlagsResult {
  args: string[];
  /** Cleanup hook for the `outputSchema` temp file. Caller MUST invoke in `finally`. */
  cleanup: () => void;
  /** First missing image path, if any. When set, the caller should bail before spawning. */
  missingImagePath: string | null;
  /** Set when deprecated/no-op compatibility inputs are supplied. */
  warning?: string;
}

/**
 * Build the U26 argv segment AND any required side-effect handles.
 *
 * IMPORTANT: When this function writes a temp file for `outputSchema`, the
 * returned `cleanup` function MUST be invoked by the caller (typically in a
 * `finally` block around the spawn). Failing to do so leaks `0o600` temp
 * files into `os.tmpdir()`.
 */
export function prepareCodexHighImpactFlags(
  input: CodexHighImpactFlagsInput
): CodexHighImpactFlagsResult {
  const missingImagePath = findMissingImagePath(input.images);
  if (missingImagePath) {
    return { args: [], cleanup: () => {}, missingImagePath };
  }

  const args: string[] = [];
  let cleanup: () => void = () => {};

  const schema = prepareCodexOutputSchema(input.outputSchema);
  if (schema) {
    args.push("--output-schema", schema.path);
    cleanup = schema.cleanup;
  }

  const warnings: string[] = [];

  if (input.search) {
    warnings.push(
      "search is deprecated and ignored because current Codex exec no longer accepts --search."
    );
  }

  if (input.profile) {
    args.push("--profile", input.profile);
  }

  args.push(...emitCodexConfigOverrideArgs(input.configOverrides));

  if (input.ephemeral) {
    args.push("--ephemeral");
  }

  if (input.images) {
    for (const img of input.images) {
      args.push("-i", img);
    }
  }

  if (input.ignoreUserConfig) {
    args.push("--ignore-user-config");
  }

  if (input.ignoreRules) {
    args.push("--ignore-rules");
  }

  return {
    args,
    cleanup,
    missingImagePath: null,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

/**
 * Pure helper for `codex_fork_session`. Builds `codex fork ...` argv from a
 * mutually-exclusive (sessionId | forkLast) selector and a prompt.
 *
 * Mutual exclusion is also enforced at the Zod schema in `index.ts`; this
 * helper re-checks defensively so callers exercising it in isolation get the
 * same guarantees.
 */
export interface CodexForkRequestInput {
  prompt: string;
  sessionId?: string;
  forkLast?: boolean;
}

export function prepareCodexForkRequest(input: CodexForkRequestInput): {
  args: string[];
} {
  const { prompt, sessionId, forkLast } = input;
  const bothSet = Boolean(sessionId) && Boolean(forkLast);
  const neitherSet = !sessionId && !forkLast;
  if (bothSet) {
    throw new Error("codex_fork_session: sessionId and forkLast are mutually exclusive");
  }
  if (neitherSet) {
    throw new Error("codex_fork_session: one of sessionId or forkLast is required");
  }

  if (forkLast) {
    return { args: ["fork", "--last", prompt] };
  }
  // sessionId path
  validateSessionId(sessionId as string);
  return { args: ["fork", sessionId as string, prompt] };
}

//──────────────────────────────────────────────────────────────────────────────
// U27: Gemini high-impact features
//──────────────────────────────────────────────────────────────────────────────

/**
 * Prepend `@<abs-path>` tokens to a Gemini prompt so the CLI's attachment
 * resolver picks them up. Each path MUST be absolute and exist on disk.
 *
 * Returns the mutated prompt. Throws on validation failure so the caller can
 * convert to a `createErrorResponse`.
 */
export function prependGeminiAttachments(prompt: string, attachments: string[]): string {
  if (!attachments || attachments.length === 0) return prompt;
  for (const p of attachments) {
    if (!isAbsolute(p)) {
      throw new Error(`attachments: path is not absolute: ${p}`);
    }
    if (!existsSync(p)) {
      throw new Error(`attachments: path does not exist: ${p}`);
    }
    validateGeminiAttachmentTokenPath(p);
  }
  const tokens = attachments.map(p => `@${p}`).join(" ");
  // Gemini attachments are prompt-level @path tokens rather than shell
  // commands. Paths are absolute, existing, and token-safe before this join.
  //
  // codeql[js/shell-command-constructed-from-input]
  return `${tokens} ${prompt}`;
}

function validateGeminiAttachmentTokenPath(path: string): void {
  for (const ch of path) {
    if (ch === "@" || ch <= " ") {
      throw new Error(
        `attachments: path cannot be represented as a Gemini @path token without escaping: ${path}`
      );
    }
  }
}

/**
 * Zod schema for the U27 Gemini high-impact feature subset. Used by the
 * `gemini_request` / `gemini_request_async` tool schemas to validate the new
 * params before they reach `prepareGeminiRequest`.
 *
 * `attachments` paths are validated to be absolute at the Zod layer; existence
 * is enforced at execution time via `prependGeminiAttachments`.
 */
export const GEMINI_HIGH_IMPACT_PARAMS_SCHEMA = z.object({
  sandbox: z.boolean().optional(),
  policyFiles: z.array(z.string()).optional(),
  adminPolicyFiles: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.string().refine(p => isAbsolute(p), {
        message: "attachments paths must be absolute",
      })
    )
    .optional(),
});

export interface GeminiHighImpactFlagsInput {
  sandbox?: boolean;
  policyFiles?: string[];
  adminPolicyFiles?: string[];
}

export interface GeminiHighImpactFlagsResult {
  args: string[];
  /** First missing policy path, if any. When set, the caller should bail. */
  missingPolicyPath: string | null;
  /** Which field the missing path came from (for actionable error messages). */
  missingPolicyField: "policyFiles" | "adminPolicyFiles" | null;
}

/**
 * Emit Gemini U27 high-impact flags. Policy paths are existence-checked here
 * so a missing file fails fast with an actionable error rather than producing
 * an opaque CLI exit.
 *
 * Does NOT handle `attachments` — those are mutated into the prompt string
 * via {@link prependGeminiAttachments} BEFORE the `-p <prompt>` pair is
 * emitted, preserving the U21 `-p` ordering invariant.
 */
export function prepareGeminiHighImpactFlags(
  input: GeminiHighImpactFlagsInput
): GeminiHighImpactFlagsResult {
  if (input.policyFiles) {
    for (const p of input.policyFiles) {
      if (!existsSync(p)) {
        return { args: [], missingPolicyPath: p, missingPolicyField: "policyFiles" };
      }
    }
  }
  if (input.adminPolicyFiles) {
    for (const p of input.adminPolicyFiles) {
      if (!existsSync(p)) {
        return {
          args: [],
          missingPolicyPath: p,
          missingPolicyField: "adminPolicyFiles",
        };
      }
    }
  }

  const args: string[] = [];
  if (input.sandbox) {
    args.push("-s");
  }
  if (input.policyFiles) {
    for (const p of input.policyFiles) {
      args.push("--policy", p);
    }
  }
  if (input.adminPolicyFiles) {
    for (const p of input.adminPolicyFiles) {
      args.push("--admin-policy", p);
    }
  }
  return { args, missingPolicyPath: null, missingPolicyField: null };
}

/**
 * Result of resolving Gemini's session strategy.
 */
export interface GeminiSessionPlan {
  /** Flag pair to inject into argv (one of `["--conversation", id]`, `["--continue"]`, or `[]`). */
  args: string[];
  /** True iff `--conversation <id>` was emitted with a user-supplied id. */
  resumed: boolean;
}

/**
 * Resolve Antigravity session args for the gateway's Gemini-compatible tool
 * surface. Antigravity exposes `--conversation <id>` and `--continue`, but no
 * supported fresh session-id flag, so new-session requests intentionally emit
 * no session flag and let the CLI create its own session.
 */
export function resolveGeminiSessionPlan(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): GeminiSessionPlan {
  if (opts.sessionId && !opts.createNewSession) {
    validateSessionId(opts.sessionId);
    return {
      args: ["--conversation", opts.sessionId],
      resumed: true,
    };
  }

  if (opts.resumeLatest && !opts.createNewSession) {
    return { args: ["--continue"], resumed: false };
  }

  return { args: [], resumed: false };
}
