/**
 * Pure, side-effect-free helpers for request argument planning.
 * Zero I/O, zero dependencies on index-scoped collaborators.
 */
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, isAbsolute } from "path";
import { randomUUID } from "crypto";
import { z } from "zod/v3";
import { CLAUDE_WIRE_PERMISSION_MODES } from "./upstream-contracts.js";
import { assertCliArgUtf8Size, assertCliArgvUtf8Size } from "./cli-input-limits.js";

/** Prefix for gateway-generated session IDs. Enforces provenance structurally. */
export const GATEWAY_SESSION_PREFIX = "gw-";

export interface SessionResumeResult {
  resumeArgs: string[];
  effectiveSessionId: string | undefined;
  userProvidedSession: boolean;
}

/**
 * Validate that a user-provided sessionId does not use the reserved gateway
 * prefix or resemble a CLI option. Throws if the ID starts with "gw-" or "-".
 */
export function validateSessionId(sessionId: string, provider = "provider CLI"): void {
  assertCliArgUtf8Size(sessionId, { provider, inputName: "sessionId" });
  if (sessionId.startsWith(GATEWAY_SESSION_PREFIX)) {
    throw new Error(
      `Session ID "${sessionId}" uses reserved prefix "${GATEWAY_SESSION_PREFIX}". Gateway-generated session IDs cannot be used for --resume.`
    );
  }
  if (sessionId.startsWith("-")) {
    throw new Error(
      `Session ID "${sessionId}" must not start with "-" (argument injection prevention)`
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
        `Invalid ${fieldName}: values must not start with "-" (argument injection prevention)`
      );
    }
  }
  return values;
}

/** Reject one option value that could otherwise be parsed as another flag. */
export function sanitizeCliArgValue(value: string, fieldName: string): string {
  sanitizeCliArgValues([value], fieldName);
  return value;
}

/**
 * Place a caller-controlled positional prompt after the CLI end-of-options
 * marker. This prevents a leading dash in prompt text from being parsed as an
 * additional provider flag.
 */
export function appendCliPrompt(args: string[], prompt: string): void {
  args.push("--", prompt);
}

/**
 * Some handlers resolve native session flags after building provider argv.
 * Keep those flags before the prompt terminator rather than turning them into
 * prompt text after `--`.
 */
export function insertCliArgsBeforePrompt(args: string[], values: readonly string[]): void {
  if (values.length === 0) return;
  // appendCliPrompt always leaves the boundary as the penultimate token.
  // Looking for the first or last "--" is unsafe: a caller value before the
  // boundary, or the literal prompt itself, may also equal "--".
  const terminatorIndex = args.length >= 2 && args.at(-2) === "--" ? args.length - 2 : -1;
  if (terminatorIndex === -1) {
    args.push(...values);
    return;
  }
  args.splice(terminatorIndex, 0, ...values);
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
    validateSessionId(opts.sessionId, "claude");
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
    validateSessionId(opts.sessionId, "codex");
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
  provider?: "grok" | "devin" | "cursor";
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
    validateSessionId(opts.sessionId, opts.provider ?? "grok");
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
    validateSessionId(opts.sessionId, "mistral");
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
 * the gateway emits `--agent accept-edits` explicitly (see `resolveMistralAgentMode`
 * for the policy-layer default and the auto-approve opt-in): omitting the flag
 * would let Vibe pick its own default, surprising programmatic callers.
 *
 * `--agent` takes an ARBITRARY name: Vibe resolves it against its own agent
 * registry — the always-available builtins below, plus install-gated builtins
 * (e.g. `lean`) and custom agents from `~/.vibe/agents/<name>.toml`. So the
 * gateway accepts any string and lets Vibe validate availability, rather than
 * pinning a closed list that would reject valid install-gated/custom agents.
 * The builtins are kept only for documentation and the request schema's example
 * text. (Verified against the installed Vibe 2.17.1 `BUILTIN_AGENTS`: `chat` is
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
// Safe default for the raw argv builder (#155): auto-accept file edits, gate
// dangerous ops (shell), which Vibe DENIES rather than hangs on in programmatic
// mode. auto-approve ("YOLO") is reached only through an explicit caller mode.
// The Mistral adapter rejects mcp_managed before this argv builder runs.
export const MISTRAL_DEFAULT_AGENT_MODE: MistralAgentMode = "accept-edits";

export interface PrepareMistralRequestInput {
  prompt: string;
  resolvedModel?: string;
  outputFormat?: string;
  permissionMode?: MistralAgentMode;
  allowedTools?: string[];
  /**
   * Vibe 2.19.1 supports repeatable `--disabled-tools <tool>` entries. They
   * are applied after the enabled-tool filter when both lists are supplied.
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
}

/**
 * Pure helper that builds Vibe's argv and env.
 *
 * - Model is selected via `VIBE_ACTIVE_MODEL` env var (NOT a `--model` flag).
 * - Permission mode emits `--agent <mode>` (defaults to `accept-edits` when unset).
 * - Allowed and disallowed tools emit `--enabled-tools <tool>` and
 *   `--disabled-tools <tool>` once per tool.
 * - Output format emits `--output <text|json|streaming>` (legacy gateway
 *   aliases `plain` and `stream-json` are normalized before spawn).
 */
export function prepareMistralRequest(
  input: PrepareMistralRequestInput
): PrepareMistralRequestResult {
  // Vibe does not honor an end-of-options marker after `-p`. Keep the
  // caller-controlled prompt in the flag's inline value so a leading dash
  // cannot become a second CLI option.
  const promptArg = `-p=${input.prompt}`;
  assertCliArgUtf8Size(promptArg, { provider: "mistral", inputName: "prompt" });
  const args: string[] = [promptArg];
  const env: Record<string, string> = {};

  if (input.resolvedModel) {
    env.VIBE_ACTIVE_MODEL = input.resolvedModel;
  }

  if (input.outputFormat) {
    args.push("--output", normalizeMistralOutputFormat(input.outputFormat));
  }

  const mode = input.permissionMode ?? MISTRAL_DEFAULT_AGENT_MODE;
  assertCliArgUtf8Size(mode, { provider: "mistral", inputName: "permissionMode" });
  args.push("--agent", mode);

  // No reasoning-effort surface on vibe: --effort / --reasoning-effort are not
  // emitted (the CLI rejects them; see upstream-contracts.ts mistral block).

  if (input.allowedTools && input.allowedTools.length > 0) {
    sanitizeCliArgValues(input.allowedTools, "allowedTools");
    for (const [index, tool] of input.allowedTools.entries()) {
      assertCliArgUtf8Size(tool, {
        provider: "mistral",
        inputName: `allowedTools[${index}]`,
      });
      args.push("--enabled-tools", tool);
    }
  }
  if (input.disallowedTools && input.disallowedTools.length > 0) {
    sanitizeCliArgValues(input.disallowedTools, "disallowedTools");
    for (const [index, tool] of input.disallowedTools.entries()) {
      assertCliArgUtf8Size(tool, {
        provider: "mistral",
        inputName: `disallowedTools[${index}]`,
      });
      args.push("--disabled-tools", tool);
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
    assertCliArgUtf8Size(input.workingDir, { provider: "mistral", inputName: "workingDir" });
    args.push("--workdir", input.workingDir);
  }
  if (input.addDir && input.addDir.length > 0) {
    sanitizeCliArgValues(input.addDir, "addDir");
    for (const [index, dir] of input.addDir.entries()) {
      assertCliArgUtf8Size(dir, { provider: "mistral", inputName: `addDir[${index}]` });
      args.push("--add-dir", dir);
    }
  }

  assertCliArgvUtf8Size("vibe", args, { provider: "mistral" });
  return { args, env };
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
 * Gateway-facing Claude permission modes. `default` is a gateway-only no-op
 * (no flag emitted); all other values are sourced from the upstream contract.
 */
export const CLAUDE_PERMISSION_MODES = ["default", ...CLAUDE_WIRE_PERMISSION_MODES] as const;
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

/**
 * Codex local OSS provider selector (for `--local-provider <p>`, used with
 * `--oss`). Values verified against `codex exec --help` (lmstudio | ollama).
 */
export const CODEX_LOCAL_PROVIDERS = ["lmstudio", "ollama"] as const;
export type CodexLocalProvider = (typeof CODEX_LOCAL_PROVIDERS)[number];

/**
 * Codex color mode (for `--color <mode>`). Values verified against
 * `codex exec --help` (always | never | auto).
 */
export const CODEX_COLOR_MODES = ["always", "never", "auto"] as const;
export type CodexColorMode = (typeof CODEX_COLOR_MODES)[number];

/**
 * Closed taxonomy for a must_cover CLI flag the gateway intentionally does NOT
 * wire as a passthrough request field.
 *   - "interactive-only": only meaningful in an attached TTY / interactive
 *     session, incompatible with the headless run mode the gateway drives.
 *   - "gateway-managed": manages detached/remote/background sessions that
 *     conflict with the gateway's own async-job + session model.
 *   - "admin-deferred": an admin/remote surface deferred to a later phase, or a
 *     flag not present in the installed headless help.
 */
export type UnexposedFlagReason = "interactive-only" | "gateway-managed" | "admin-deferred";

export interface UnexposedCliFlag {
  flag: string;
  reason: UnexposedFlagReason;
  detail: string;
}

/**
 * Phase 4 Part A: Claude `must_cover` flags that are deliberately NOT exposed as
 * passthrough request fields. The DRY contract forbids silent omission, so each
 * omission is recorded here (typed capability fact) and asserted by
 * `provider-part-a-flag-classification.test.ts`.
 */
export const CLAUDE_UNEXPOSED_CLI_FLAGS: readonly UnexposedCliFlag[] = [
  {
    flag: "--tmux",
    reason: "interactive-only",
    detail:
      "Creates an attached tmux/iTerm2 session for a worktree (requires --worktree); incompatible with headless --print.",
  },
  {
    flag: "--background",
    reason: "gateway-managed",
    detail:
      "Starts a detached background agent (managed via `claude agents`); conflicts with the gateway's own async-job model.",
  },
  {
    flag: "--remote-control",
    reason: "gateway-managed",
    detail:
      "Starts an interactive Remote Control session; a stateful/remote surface deferred to the gateway-managed transport.",
  },
  {
    flag: "--remote",
    reason: "admin-deferred",
    detail:
      "No bare --remote exists in installed Claude help; the only remote surface is --remote-control (gateway-managed).",
  },
  {
    flag: "--worktree",
    reason: "gateway-managed",
    detail:
      "claude --help advertises -w, --worktree [name], but gateway worktrees are owned by slice λ (worktree-manager); the native --worktree is intentionally never emitted so the gateway owns the checkout lifecycle.",
  },
  {
    flag: "--resume",
    reason: "gateway-managed",
    detail:
      "claude --help advertises -r, --resume [value] for interactive resume; the gateway session model maps continuity onto --continue (continueSession) and --session-id (sessionId), so the raw --resume passthrough is intentionally not wired.",
  },
] as const;

/**
 * Phase 4 Part A: Codex `must_cover` flags deliberately NOT exposed as
 * passthrough request fields. Same DRY contract as the Claude list above.
 */
export const CODEX_UNEXPOSED_CLI_FLAGS: readonly UnexposedCliFlag[] = [
  {
    flag: "--remote",
    reason: "admin-deferred",
    detail:
      "TUI-only (top-level `codex` help, not `codex exec`): connects the TUI to a remote app-server endpoint; not a headless exec flag.",
  },
  {
    flag: "--remote-auth-token-env",
    reason: "admin-deferred",
    detail:
      "TUI-only companion to --remote (bearer-token env var for the remote app-server websocket); not a headless exec flag.",
  },
  {
    flag: "--ask-for-approval",
    reason: "admin-deferred",
    detail:
      "Removed from the installed `codex exec` upstream: current codex exec no longer accepts --ask-for-approval. The askForApproval MCP input is retained for back-compat but warns and emits no argv (accepted-but-ignored); classified here because the flag is not present in the installed headless help.",
  },
  {
    flag: "--search",
    reason: "admin-deferred",
    detail:
      "Removed from the installed `codex exec` upstream: current codex exec no longer accepts --search. The search MCP input is retained for back-compat but warns and emits no argv (accepted-but-ignored); classified here because the flag is not present in the installed headless help.",
  },
] as const;

/**
 * Phase 4 Part B: Gemini (Antigravity `agy`) `must_cover` flags deliberately
 * NOT exposed as passthrough request fields. Same DRY contract as the Claude /
 * Codex lists above: every non-wired must_cover flag carries a typed capability
 * fact with a closed-taxonomy reason (asserted by
 * `provider-part-b-flag-classification.test.ts`). These are also carried in the
 * gemini contract's `acknowledgedUpstreamFlags` for drift-probe quieting; this
 * list adds the human-readable classification + rationale. (`--print-timeout`
 * graduated to a wired request field, so it is no longer listed here.)
 */
export const GEMINI_UNEXPOSED_CLI_FLAGS: readonly UnexposedCliFlag[] = [
  {
    flag: "--prompt-interactive",
    reason: "interactive-only",
    detail:
      "Runs an initial prompt then continues in an attached interactive session (short alias -i); incompatible with the headless --print run mode the gateway drives.",
  },
  {
    flag: "--log-file",
    reason: "admin-deferred",
    detail:
      "Overrides agy's internal CLI log file path (a diagnostic/maintenance surface); the gateway flight recorder is the request-logging surface, so this is deferred to a later admin phase.",
  },
] as const;

/**
 * Phase 4 Part B: Mistral (Vibe) `must_cover` flags deliberately NOT exposed as
 * passthrough request fields. Both are setup/maintenance operations, not
 * headless run flags, and are deferred to the phase-6 admin surface. Same DRY
 * contract as the lists above.
 */
export const MISTRAL_UNEXPOSED_CLI_FLAGS: readonly UnexposedCliFlag[] = [
  {
    flag: "--setup",
    reason: "admin-deferred",
    detail:
      "Vibe `--setup` configures the API key and exits; a credential/setup maintenance op, not a headless run flag. Deferred to the phase-6 admin surface.",
  },
  {
    flag: "--check-upgrade",
    reason: "admin-deferred",
    detail:
      "Vibe `--check-upgrade` checks for a Vibe update, prompts to install, and exits; a maintenance op, not a headless run flag. Deferred to the phase-6 admin surface.",
  },
] as const;

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

const AGENT_MAP_KEY_ENVELOPE = "agent-name:";

function isPlainAgentMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeAgentMapKeys(value: unknown): unknown {
  if (!isPlainAgentMap(value)) return value;
  const encoded = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(encoded, `${AGENT_MAP_KEY_ENVELOPE}${JSON.stringify(key)}`, {
      value: entry,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return encoded;
}

function decodeAgentMapKeys(value: Record<string, unknown>): Record<string, unknown> {
  const decoded = Object.create(null) as Record<string, unknown>;
  for (const [encodedKey, entry] of Object.entries(value)) {
    const key = JSON.parse(encodedKey.slice(AGENT_MAP_KEY_ENVELOPE.length)) as string;
    Object.defineProperty(decoded, key, {
      value: entry,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return decoded;
}

/**
 * Preserve every caller-owned agent-name key until bounded manual validation.
 * `z.record` reconstructs through an ordinary object and cannot directly carry
 * an own `__proto__` key. The preprocess step uses an injective safe envelope,
 * then the transform restores all names on a null-prototype record. Keeping the
 * record as the inner schema also publishes the truthful object-map JSON shape.
 */
export const CLAUDE_AGENTS_MAP_INPUT_SCHEMA = z
  .preprocess(encodeAgentMapKeys, z.record(z.string(), z.unknown()))
  .transform(decodeAgentMapKeys);

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
    // Keep the outer tool/input boundary opaque. Definition validation happens
    // in validateClaudeAgentsMap, which reports bounded ordinal paths instead
    // of allowing Zod to echo a caller-controlled map key.
    agents: CLAUDE_AGENTS_MAP_INPUT_SCHEMA.optional(),
    forkSession: z.boolean().optional(),
    systemPrompt: z.string().min(1).optional(),
    appendSystemPrompt: z.string().min(1).optional(),
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
 * on the first failing entry. For failures, `agentKey` is a bounded ordinal
 * path such as `agents[1]`, never the caller-controlled map key. The caller is
 * responsible for turning the failure into a tool-level error response (e.g.
 * via `createErrorResponse`).
 */
export function validateClaudeAgentsMap(
  agents: Record<string, unknown>
):
  | { ok: true; value: Record<string, ClaudeAgentDefinition> }
  | { ok: false; agentKey: string; message: string } {
  const validated = Object.create(null) as Record<string, ClaudeAgentDefinition>;
  for (const [index, [key, raw]] of Object.entries(agents).entries()) {
    const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const agentPath = `agents[${index}]`;
      // This schema can report only its fixed field names and numeric array
      // indexes. Keep future schema changes fail-closed so a caller-controlled
      // path segment cannot reintroduce key disclosure through validation text.
      const path = (issue?.path ?? [])
        .map(segment => {
          if (typeof segment === "number") return `[${segment}]`;
          if (["description", "prompt", "tools", "model"].includes(segment)) {
            return `.${segment}`;
          }
          return ".field";
        })
        .join("");
      return {
        ok: false,
        agentKey: agentPath,
        message: `Invalid agent definition at ${agentPath}${path}: ${issue?.message ?? "schema validation failed"}`,
      };
    }
    Object.defineProperty(validated, key, {
      value: parsed.data,
      enumerable: true,
      configurable: false,
      writable: false,
    });
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
  // Phase 4 Part A: remaining headless-safe Claude CLI modifiers (traced to
  // `claude --help`). Interactive-only (`--tmux`) and gateway-managed
  // (`--background`, `--remote-control`) flags are intentionally NOT here; see
  // the provider capability facts + tests for that classification.
  /**
   * Claude `--include-hook-events`: include all hook lifecycle events in the
   * output stream. Only meaningful with `--output-format=stream-json` (the
   * gateway's default output format), per `claude --help`.
   */
  includeHookEvents?: boolean;
  /**
   * Claude `--replay-user-messages`: re-emit user messages from stdin back on
   * stdout for acknowledgment. Only works with `--input-format=stream-json`
   * AND `--output-format=stream-json` (the slice κ cacheControl path), per
   * `claude --help`.
   */
  replayUserMessages?: boolean;
  /**
   * Claude `--system-prompt-file <path>`: replace the system prompt from a
   * file (path variant of `--system-prompt`, advertised in the `--bare` help
   * text as `--system-prompt[-file]`). Passed through verbatim as a path.
   */
  systemPromptFile?: string;
  /**
   * Claude `--append-system-prompt-file <path>`: append a system prompt from a
   * file (path variant of `--append-system-prompt`, advertised in the `--bare`
   * help text as `--append-system-prompt[-file]`). Passed through verbatim.
   */
  appendSystemPromptFile?: string;
  /**
   * Claude `--name <name>`: set a display name for this session. Pure
   * per-run modifier, safe in headless `--print` mode.
   */
  name?: string;
  /**
   * Claude `--plugin-dir <path>`: load a plugin from a directory or `.zip` for
   * this session only (repeatable). One `--plugin-dir` instance per entry.
   */
  pluginDir?: string[];
  /**
   * Claude `--plugin-url <url>`: load a plugin `.zip` from a URL for this
   * session only (repeatable). One `--plugin-url` instance per entry.
   */
  pluginUrl?: string[];
  /**
   * Claude `--safe-mode`: start with all customizations disabled (for
   * troubleshooting a broken config). Explicit opt-in; never defaulted on.
   */
  safeMode?: boolean;
  /**
   * Claude `--bare`: minimal mode (skip hooks, LSP, plugin sync, attribution,
   * auto-memory, keychain reads, and CLAUDE.md auto-discovery). Explicit
   * opt-in; never defaulted on.
   */
  bare?: boolean;
  /**
   * Claude `-d, --debug [filter]`: enable debug mode with optional category
   * filter (e.g. "api,hooks"). `true` emits a bare `--debug`; a string emits
   * `--debug <filter>`. Debug output goes to stderr only, so it does not
   * pollute the parsed stdout stream.
   */
  debug?: string | boolean;
  /**
   * Claude `--debug-file <path>`: write debug logs to a specific file path
   * (implicitly enables debug mode). Passed through verbatim.
   */
  debugFile?: string;
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
  const admit = (value: string, inputName: string): string => {
    assertCliArgUtf8Size(value, { provider: "claude", inputName });
    return value;
  };

  if (input.agent) {
    args.push("--agent", admit(input.agent, "agent"));
  }
  if (input.agents && Object.keys(input.agents).length > 0) {
    args.push("--agents", admit(JSON.stringify(input.agents), "agents"));
  }
  if (input.forkSession) {
    args.push("--fork-session");
  }
  if (input.systemPrompt !== undefined) {
    args.push("--system-prompt", admit(input.systemPrompt, "systemPrompt"));
  }
  if (input.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", admit(input.appendSystemPrompt, "appendSystemPrompt"));
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
    args.push("--fallback-model", admit(input.fallbackModel, "fallbackModel"));
  }
  if (input.jsonSchema !== undefined) {
    const schemaArg =
      typeof input.jsonSchema === "string" ? input.jsonSchema : JSON.stringify(input.jsonSchema);
    args.push("--json-schema", admit(schemaArg, "jsonSchema"));
  }
  if (input.addDir && input.addDir.length > 0) {
    sanitizeCliArgValues(input.addDir, "addDir");
    for (const [index, dir] of input.addDir.entries()) {
      args.push("--add-dir", admit(dir, `addDir[${index}]`));
    }
  }
  if (input.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (input.settingSources !== undefined) {
    args.push("--setting-sources", admit(input.settingSources, "settingSources"));
  }
  if (input.settings !== undefined) {
    args.push("--settings", admit(input.settings, "settings"));
  }
  if (input.tools && input.tools.length > 0) {
    // Single variadic flag (mirrors --allowed-tools emission). `[""]` → `--tools ""`
    // which disables all built-in tools per `claude --help`.
    sanitizeCliArgValues(input.tools, "tools");
    args.push("--tools", ...input.tools.map((tool, index) => admit(tool, `tools[${index}]`)));
  }

  // Phase 4 Part A: additional headless-safe modifiers.
  if (input.includeHookEvents) {
    args.push("--include-hook-events");
  }
  if (input.replayUserMessages) {
    args.push("--replay-user-messages");
  }
  if (input.systemPromptFile !== undefined) {
    args.push("--system-prompt-file", admit(input.systemPromptFile, "systemPromptFile"));
  }
  if (input.appendSystemPromptFile !== undefined) {
    args.push(
      "--append-system-prompt-file",
      admit(input.appendSystemPromptFile, "appendSystemPromptFile")
    );
  }
  if (input.name !== undefined) {
    args.push("--name", admit(input.name, "name"));
  }
  if (input.pluginDir && input.pluginDir.length > 0) {
    sanitizeCliArgValues(input.pluginDir, "pluginDir");
    for (const [index, dir] of input.pluginDir.entries()) {
      args.push("--plugin-dir", admit(dir, `pluginDir[${index}]`));
    }
  }
  if (input.pluginUrl && input.pluginUrl.length > 0) {
    sanitizeCliArgValues(input.pluginUrl, "pluginUrl");
    for (const [index, url] of input.pluginUrl.entries()) {
      args.push("--plugin-url", admit(url, `pluginUrl[${index}]`));
    }
  }
  if (input.safeMode) {
    args.push("--safe-mode");
  }
  if (input.bare) {
    args.push("--bare");
  }
  if (input.debug !== undefined && input.debug !== false) {
    if (typeof input.debug === "string") {
      if (input.debug.startsWith("-")) {
        throw new Error("debug must not start with '-' (argument injection prevention)");
      }
      args.push("--debug", admit(input.debug, "debug"));
    } else {
      args.push("--debug");
    }
  }
  if (input.debugFile !== undefined) {
    args.push("--debug-file", admit(input.debugFile, "debugFile"));
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
 *
 * Gateway request handlers additionally reject this control for remote
 * HTTP/OAuth callers because it changes the host-local Codex configuration.
 */
const CODEX_CONFIG_OVERRIDE_KEY_PATTERN = /^[a-zA-Z0-9._]+$/;
const CODEX_CONFIG_OVERRIDE_KEY_ERROR =
  "configOverrides keys must match /^[a-zA-Z0-9._]+$/ (no whitespace, '=', or flag-like prefixes)";
const CODEX_CONFIG_OVERRIDE_VALUE_SCHEMA = z.string().refine(v => !/[\n\r]/.test(v), {
  message: "configOverrides values must not contain CR or LF characters",
});

export const CODEX_CONFIG_OVERRIDES_SCHEMA = z
  .record(z.string(), z.unknown())
  .superRefine((overrides, ctx) => {
    for (const [index, [key, value]] of Object.entries(overrides).entries()) {
      // A Zod record key schema copies the complete caller-controlled key into
      // each issue path. Validate manually so even a very large invalid key is
      // represented by a bounded ordinal name in public errors.
      const path = [`configOverrides[${index}]`];
      if (!CODEX_CONFIG_OVERRIDE_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: CODEX_CONFIG_OVERRIDE_KEY_ERROR,
        });
      }

      const parsedValue = CODEX_CONFIG_OVERRIDE_VALUE_SCHEMA.safeParse(value);
      if (!parsedValue.success) {
        for (const issue of parsedValue.error.issues) {
          ctx.addIssue({ ...issue, path });
        }
      }
    }
  })
  .transform(overrides => overrides as Record<string, string>)
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
  for (const [index, [key, value]] of Object.entries(overrides).entries()) {
    const argument = `${key}=${value}`;
    assertCliArgUtf8Size(argument, {
      provider: "codex",
      inputName: `configOverrides[${index}]`,
    });
    args.push("-c", argument);
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
    assertCliArgUtf8Size(outputSchema, { provider: "codex", inputName: "outputSchema" });
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
  // Phase 4 Part A: feature toggles. `--enable`/`--disable` are equivalent to
  // `-c features.<name>=true|false`, and `-c` is accepted on `codex exec
  // resume`, so these are safe in both new and resume branches. Gateway request
  // handlers restrict them to local callers with configOverrides.
  enable: z.array(z.string()).optional(),
  disable: z.array(z.string()).optional(),
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
  /**
   * Codex `--enable <FEATURE>` (repeatable): enable a feature for this run
   * (equivalent to `-c features.<name>=true`). Emitted once per entry.
   */
  enable?: string[];
  /**
   * Codex `--disable <FEATURE>` (repeatable): disable a feature for this run
   * (equivalent to `-c features.<name>=false`). Emitted once per entry.
   */
  disable?: string[];
}

export interface CodexHighImpactFlagsResult {
  args: string[];
  /** Cleanup hook for the `outputSchema` temp file. Caller MUST invoke in `finally`. */
  cleanup: () => void;
  /** First missing image path, if any. When set, the caller should bail before spawning. */
  missingImagePath: string | null;
  /** Set when deprecated/no-op compatibility inputs are supplied. */
  warning?: string;
  /** True when pure planning deferred an image check or schema temp-file write. */
  filesystemDeferred?: boolean;
}

export interface CodexHighImpactFlagsOptions {
  /** Build byte-exact argv shape without filesystem reads or writes. */
  deferFilesystem?: boolean;
}

const CODEX_SCHEMA_UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/** Exact-length stand-in for the random schema path used during pure planning. */
export function plannedCodexOutputSchemaPath(): string {
  return join(tmpdir(), `codex-schema-${CODEX_SCHEMA_UUID_PLACEHOLDER}.json`);
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
  input: CodexHighImpactFlagsInput,
  options: CodexHighImpactFlagsOptions = {}
): CodexHighImpactFlagsResult {
  if (typeof input.outputSchema === "string") {
    assertCliArgUtf8Size(input.outputSchema, {
      provider: "codex",
      inputName: "outputSchema",
    });
  }
  if (input.profile) {
    assertCliArgUtf8Size(input.profile, { provider: "codex", inputName: "profile" });
  }
  const configOverrideArgs = emitCodexConfigOverrideArgs(input.configOverrides);
  for (const [field, values] of [
    ["images", input.images],
    ["enable", input.enable],
    ["disable", input.disable],
  ] as const) {
    if (!values) continue;
    sanitizeCliArgValues(values, field);
    for (const [index, value] of values.entries()) {
      assertCliArgUtf8Size(value, { provider: "codex", inputName: `${field}[${index}]` });
    }
  }

  const missingImagePath = options.deferFilesystem ? null : findMissingImagePath(input.images);
  if (missingImagePath) {
    return { args: [], cleanup: () => {}, missingImagePath };
  }

  const args: string[] = [];
  let cleanup: () => void = () => {};

  const schema =
    options.deferFilesystem && typeof input.outputSchema === "object"
      ? { path: plannedCodexOutputSchemaPath(), cleanup: () => {} }
      : prepareCodexOutputSchema(input.outputSchema);
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

  args.push(...configOverrideArgs);

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

  // Phase 4 Part A: feature toggles (repeatable). One flag instance per entry
  // so each feature name is its own argv token.
  if (input.enable && input.enable.length > 0) {
    for (const feature of input.enable) {
      args.push("--enable", feature);
    }
  }
  if (input.disable && input.disable.length > 0) {
    for (const feature of input.disable) {
      args.push("--disable", feature);
    }
  }

  return {
    args,
    cleanup,
    missingImagePath: null,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    filesystemDeferred:
      options.deferFilesystem === true &&
      (typeof input.outputSchema === "object" || (input.images?.length ?? 0) > 0),
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

  // The installed contract verifies stdin for `codex exec` and `exec resume`,
  // not for the distinct `codex fork` subcommand. Keep fork on argv and fail
  // before spawn when its final positional prompt cannot fit.
  assertCliArgUtf8Size(prompt, { provider: "codex fork", inputName: "prompt" });

  if (forkLast) {
    return { args: ["fork", "--last", "--", prompt] };
  }
  // sessionId path
  validateSessionId(sessionId as string, "codex fork");
  return { args: ["fork", sessionId as string, "--", prompt] };
}

//──────────────────────────────────────────────────────────────────────────────
// U27: Gemini high-impact features
//──────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for the U27 Gemini high-impact feature subset. Used by the
 * `gemini_request` / `gemini_request_async` tool schemas to validate the new
 * params before they reach `prepareGeminiRequest`.
 *
 * `attachments` paths remain absolute at the schema boundary for compatibility,
 * then the Antigravity request path rejects non-empty attachment input because
 * agy has no supported attachment-token contract.
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
    validateSessionId(opts.sessionId, "gemini");
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
