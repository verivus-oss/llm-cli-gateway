import { spawnSync } from "node:child_process";
import type { CliType } from "./session-manager.js";
import { envWithExtendedPath, getExtendedPath, resolveCommandForSpawn } from "./executor.js";

/**
 * `optional` (slice κ): consumes the next token as the flag's value
 * ONLY if that token does not start with `-`. Used for Claude's
 * `-p`/`--print`, which is a no-arg switch in claude-code 2.x but
 * also doubles as the legacy `-p <prompt>` positional shorthand that
 * the gateway has emitted since v0.x.
 */
export type CliFlagArity = "none" | "one" | "optional" | "variadic";

export interface CliFlagContract {
  arity: CliFlagArity;
  values?: readonly string[];
  pattern?: RegExp;
  description: string;
}

export interface CliContract {
  cli: CliType;
  executable: string;
  upstream: string;
  helpArgs: string[][];
  flags: Record<string, CliFlagContract>;
  env?: Record<string, CliFlagContract>;
  mcpTools: readonly string[];
  mcpParameters: readonly string[];
  conformanceFixtures: readonly CliContractFixture[];
  command?: {
    requiredFirstArg: string;
    optionalSecondArg?: string;
  };
  maxPositionals: number;
  resumeMaxPositionals?: number;
  resumeOnlyFlags?: readonly string[];
  resumeForbiddenFlags?: readonly string[];
}

export interface CliContractFixture {
  id: string;
  description: string;
  args: readonly string[];
  env?: Record<string, string>;
  expect: "pass" | "fail";
}

export interface ContractViolation {
  cli: CliType;
  arg?: string;
  index?: number;
  message: string;
}

export interface ContractValidationResult {
  ok: boolean;
  violations: ContractViolation[];
}

const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const UPSTREAM_CLI_CONTRACTS: Record<CliType, CliContract> = {
  claude: {
    cli: "claude",
    executable: "claude",
    upstream: "Claude Code CLI",
    helpArgs: [["--help"]],
    maxPositionals: 0,
    mcpTools: ["claude_request", "claude_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "continueSession",
      "createNewSession",
      "allowedTools",
      "disallowedTools",
      "dangerouslySkipPermissions",
      "permissionMode",
      "agent",
      "agents",
      "forkSession",
      "systemPrompt",
      "appendSystemPrompt",
      "maxBudgetUsd",
      "maxTurns",
      "effort",
      "excludeDynamicSystemPromptSections",
      "fallbackModel",
      "jsonSchema",
      // Phase 4 slice ζ
      "addDir",
      "approvalStrategy",
      "mcpServers",
      "strictMcpConfig",
    ],
    flags: {
      "-p": {
        arity: "optional",
        description:
          "Print/non-interactive mode. Legacy gateway emission used `-p <prompt>` (consumed as positional in claude's grammar); slice κ emits `-p` standalone followed by `--input-format stream-json` so the prompt flows in on stdin.",
      },
      "--model": { arity: "one", description: "Model selector" },
      "--input-format": {
        arity: "one",
        values: ["text", "stream-json"],
        description:
          "Slice κ: realtime JSON stdin payload. `stream-json` enables Anthropic cache_control breakpoints from caller-supplied content blocks.",
      },
      "--output-format": {
        arity: "one",
        values: ["json", "stream-json"],
        description: "Machine-readable output format",
      },
      "--include-partial-messages": {
        arity: "none",
        description: "Include partial messages in stream-json output",
      },
      "--verbose": {
        arity: "none",
        description:
          "Claude CLI 2.x: required alongside --print + --output-format=stream-json; affects stderr only, stream-json stdout shape unchanged",
      },
      "--allowed-tools": { arity: "variadic", description: "Allowed tool names/patterns" },
      "--disallowed-tools": { arity: "variadic", description: "Disallowed tool names/patterns" },
      "--permission-mode": {
        arity: "one",
        values: PERMISSION_MODES,
        description: "Claude permission mode",
      },
      "--mcp-config": { arity: "one", description: "MCP config path" },
      "--strict-mcp-config": { arity: "none", description: "Restrict to MCP config" },
      "--agent": { arity: "one", description: "Named sub-agent" },
      "--agents": { arity: "one", description: "Inline agent definitions JSON" },
      "--fork-session": { arity: "none", description: "Fork current session" },
      "--system-prompt": { arity: "one", description: "Replacement system prompt" },
      "--append-system-prompt": { arity: "one", description: "Appended system prompt" },
      "--max-budget-usd": {
        arity: "one",
        pattern: /^[0-9]+(?:\.[0-9]+)?$/,
        description: "Budget cap in USD",
      },
      "--max-turns": { arity: "one", pattern: /^[1-9][0-9]*$/, description: "Turn cap" },
      "--effort": { arity: "one", values: EFFORT_LEVELS, description: "Reasoning effort" },
      "--exclude-dynamic-system-prompt-sections": {
        arity: "none",
        description: "Trim dynamic system prompt sections",
      },
      "--fallback-model": {
        arity: "one",
        description: "Auto-fallback model when default is overloaded (Claude --print only)",
      },
      "--json-schema": {
        arity: "one",
        description: "JSON Schema literal constraining structured output",
      },
      "--add-dir": {
        arity: "one",
        description: "Additional workspace directory (Phase 4 slice ζ; repeat once per directory)",
      },
      "--continue": { arity: "none", description: "Continue active session" },
      "--session-id": { arity: "one", description: "Session id" },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "claude-minimal",
        description: "Minimal prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "claude-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-claude-flag"],
        expect: "fail",
      },
      {
        // Phase 4 slice η: --fallback-model wired through prepareClaudeRequest.
        id: "claude-fallback-model",
        description: "Phase 4 slice η: --fallback-model accepted",
        args: ["-p", "hello", "--fallback-model", "claude-haiku-4-5-20251001"],
        expect: "pass",
      },
      {
        // Phase 4 slice η: --json-schema accepts an inline JSON Schema literal
        // (per `claude --help` example), not a path. Codex parity for
        // structured-output validation in one slice.
        id: "claude-json-schema",
        description: "Phase 4 slice η: --json-schema accepts inline JSON literal",
        args: [
          "-p",
          "hello",
          "--output-format",
          "json",
          "--json-schema",
          '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
        ],
        expect: "pass",
      },
      {
        // Phase 4 slice ζ: --add-dir wired through prepareClaudeHighImpactFlags.
        // Repeated once per directory; each instance has arity:"one".
        id: "claude-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir is accepted",
        args: ["-p", "hello", "--add-dir", "/tmp/a", "--add-dir", "/tmp/b"],
        expect: "pass",
      },
      {
        // Claude CLI 2.x: stream-json requires --verbose alongside --print.
        // The gateway emits all three together; this fixture pins the combo
        // so a future removal of --verbose breaks loudly here instead of
        // silently at runtime against the upstream CLI.
        id: "claude-stream-json-requires-verbose",
        description:
          "Claude CLI 2.x: --output-format stream-json + --include-partial-messages + --verbose accepted together",
        args: [
          "-p",
          "hello",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
        ],
        expect: "pass",
      },
      {
        // Slice κ: when caller marks promptParts with cache_control, the
        // gateway emits `-p` as a standalone flag and pipes the JSON
        // content-blocks payload over stdin via `--input-format
        // stream-json`. The fixture pins the exact argv combination so
        // a future regression (re-emitting a positional prompt, dropping
        // `--input-format`, etc.) trips loudly here.
        id: "claude-input-format-stream-json",
        description:
          "Slice κ: `-p` standalone + --input-format stream-json + --output-format stream-json + --include-partial-messages + --verbose",
        args: [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
        ],
        expect: "pass",
      },
    ],
  },
  codex: {
    cli: "codex",
    executable: "codex",
    upstream: "OpenAI Codex CLI",
    helpArgs: [
      ["exec", "--help"],
      ["exec", "resume", "--help"],
    ],
    command: { requiredFirstArg: "exec", optionalSecondArg: "resume" },
    maxPositionals: 1,
    resumeMaxPositionals: 2,
    mcpTools: ["codex_request", "codex_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "fullAuto",
      "sandboxMode",
      "askForApproval",
      "useLegacyFullAutoFlag",
      "dangerouslyBypassApprovalsAndSandbox",
      "approvalStrategy",
      "mcpServers",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "outputFormat",
      "outputSchema",
      "search",
      "profile",
      "configOverrides",
      "ephemeral",
      "images",
      "ignoreUserConfig",
      "ignoreRules",
      // Phase 4 slice ζ
      "workingDir",
      "addDir",
    ],
    resumeOnlyFlags: ["--last"],
    // Phase 4 slice α (v1.8.0) verified that `codex exec resume` accepts
    // `--output-schema` and `-c` (codex-cli 0.133.0 `exec resume --help`),
    // so they're no longer forbidden. `--search` stays forbidden (resume
    // inherits the original session's web-search state).
    resumeForbiddenFlags: ["--sandbox", "--ask-for-approval", "--full-auto", "--search"],
    flags: {
      "--last": { arity: "none", description: "Resume latest session" },
      "--model": { arity: "one", description: "Model selector" },
      "--sandbox": {
        arity: "one",
        values: ["read-only", "workspace-write", "danger-full-access"],
        description: "Sandbox policy",
      },
      "--ask-for-approval": {
        arity: "one",
        values: ["untrusted", "on-request", "never"],
        description: "Approval policy",
      },
      "--full-auto": { arity: "none", description: "Legacy full-auto shortcut" },
      "--dangerously-bypass-approvals-and-sandbox": {
        arity: "none",
        description: "Disable approvals and sandbox",
      },
      "--json": { arity: "none", description: "JSONL event stream" },
      "--skip-git-repo-check": { arity: "none", description: "Allow non-git cwd" },
      "--output-schema": { arity: "one", description: "Structured output JSON schema path" },
      "--search": { arity: "none", description: "Enable web search" },
      "--profile": { arity: "one", description: "Config profile" },
      "-c": {
        arity: "one",
        pattern: /^[a-zA-Z0-9._]+=([^\r\n]*)$/,
        description: "Config override key=value",
      },
      "--ephemeral": { arity: "none", description: "Do not persist session" },
      "-i": { arity: "one", description: "Image path" },
      "--ignore-user-config": { arity: "none", description: "Ignore user config" },
      "--ignore-rules": { arity: "none", description: "Ignore rule files" },
      // The gateway only ever emits the short form `-C` (codex 0.134.0 accepts
      // both `-C` and `--cd` as aliases). The contract registers exactly what
      // we emit; if a future code path emits `--cd` instead, the contract
      // check will fail loudly — which is the intended catch.
      "-C": {
        arity: "one",
        description: "Working root for the session (Phase 4 slice ζ; new sessions only)",
      },
      "--add-dir": {
        arity: "one",
        description:
          "Additional writable workspace directory (Phase 4 slice ζ; repeat once per directory; new sessions only)",
      },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "codex-minimal",
        description: "Minimal exec prompt",
        args: ["exec", "--skip-git-repo-check", "hello"],
        expect: "pass",
      },
      {
        id: "codex-invalid-sandbox",
        description: "Unsupported sandbox enum is rejected",
        args: ["exec", "--sandbox", "workspace", "hello"],
        expect: "fail",
      },
      {
        // Phase 4 slice α: --output-schema IS accepted on resume per
        // codex-cli 0.133.0; this fixture pins the new behaviour so future
        // contract changes can't silently regress.
        id: "codex-resume-output-schema",
        description: "Phase 4 slice α: --output-schema accepted on resume (codex-cli 0.133.0)",
        args: ["exec", "resume", "--output-schema", "/tmp/schema.json", "session-id", "hello"],
        expect: "pass",
      },
      {
        id: "codex-resume-config-override",
        description: "Phase 4 slice α: -c key=value accepted on resume",
        args: ["exec", "resume", "-c", "model.foo=bar", "session-id", "hello"],
        expect: "pass",
      },
      {
        id: "codex-resume-search-still-forbidden",
        description: "Phase 4 slice α: --search remains forbidden on resume",
        args: ["exec", "resume", "--search", "session-id", "hello"],
        expect: "fail",
      },
      {
        id: "codex-working-dir",
        description: "Phase 4 slice ζ: -C <DIR> accepted on a new session",
        args: ["exec", "--skip-git-repo-check", "-C", "/tmp/work", "hello"],
        expect: "pass",
      },
      {
        id: "codex-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir accepted on a new session",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--add-dir",
          "/tmp/a",
          "--add-dir",
          "/tmp/b",
          "hello",
        ],
        expect: "pass",
      },
    ],
  },
  gemini: {
    cli: "gemini",
    executable: "gemini",
    upstream: "Google Gemini CLI",
    helpArgs: [["--help"]],
    maxPositionals: 0,
    mcpTools: ["gemini_request", "gemini_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "approvalMode",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "includeDirs",
      "outputFormat",
      "sandbox",
      "policyFiles",
      "adminPolicyFiles",
      "attachments",
      // Phase 4 slice γ
      "skipTrust",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--model": { arity: "one", description: "Model selector" },
      "--approval-mode": {
        arity: "one",
        values: ["default", "auto_edit", "yolo", "plan"],
        description: "Approval mode",
      },
      "--allowed-tools": { arity: "one", description: "Allowed tool" },
      "--allowed-mcp-server-names": { arity: "one", description: "Allowed MCP server" },
      "--include-directories": { arity: "one", description: "Included directory" },
      "-s": { arity: "none", description: "Sandbox mode" },
      "--policy": { arity: "one", description: "Policy file path" },
      "--admin-policy": { arity: "one", description: "Admin policy file path" },
      "-o": {
        arity: "one",
        values: ["json", "stream-json"],
        description: "Output format (Phase 4 slice ε adds stream-json)",
      },
      "--resume": { arity: "one", description: "Resume session" },
      "--skip-trust": {
        arity: "none",
        description: "Trust workspace for this session (Phase 4 slice γ)",
      },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "gemini-minimal",
        description: "Minimal prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "gemini-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-gemini-flag"],
        expect: "fail",
      },
      {
        id: "gemini-skip-trust",
        description: "Phase 4 slice γ: --skip-trust is accepted",
        args: ["-p", "hello", "--skip-trust"],
        expect: "pass",
      },
      {
        id: "gemini-stream-json",
        description: "Phase 4 slice ε: -o stream-json is accepted",
        args: ["-p", "hello", "-o", "stream-json"],
        expect: "pass",
      },
      {
        id: "gemini-output-format-invalid",
        description: "Phase 4 slice ε: -o ndjson is rejected (not in contract enum)",
        args: ["-p", "hello", "-o", "ndjson"],
        expect: "fail",
      },
    ],
  },
  grok: {
    cli: "grok",
    executable: "grok",
    upstream: "xAI Grok CLI",
    helpArgs: [["--help"]],
    maxPositionals: 0,
    mcpTools: ["grok_request", "grok_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "alwaysApprove",
      "permissionMode",
      "effort",
      "reasoningEffort",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "disallowedTools",
      // Phase 4 slice δ
      "maxTurns",
      // Phase 4 slice ζ
      "workingDir",
      // Phase 4 slice θ — Grok HIGH parity
      "sandbox",
      "rules",
      "systemPromptOverride",
      "allow",
      "deny",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--model": { arity: "one", description: "Model selector" },
      "--output-format": {
        arity: "one",
        values: ["plain", "json", "streaming-json"],
        description: "Output format",
      },
      "--always-approve": { arity: "none", description: "Approve tool use automatically" },
      "--permission-mode": {
        arity: "one",
        values: PERMISSION_MODES,
        description: "Permission mode",
      },
      "--effort": { arity: "one", values: EFFORT_LEVELS, description: "Reasoning effort" },
      "--reasoning-effort": { arity: "one", description: "Reasoning effort override" },
      "--tools": { arity: "one", description: "Comma-separated allowed tools" },
      "--disallowed-tools": {
        arity: "one",
        description: "Comma-separated disallowed tools",
      },
      "--resume": { arity: "one", description: "Resume session" },
      "--continue": { arity: "none", description: "Continue latest session" },
      "--max-turns": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Agent-loop iteration cap (Phase 4 slice δ)",
      },
      "--cwd": {
        arity: "one",
        description: "Working directory for the invocation (Phase 4 slice ζ)",
      },
      // Phase 4 slice θ — Grok HIGH parity. `--sandbox` is freeform per
      // `grok --help` on 0.1.210 (no `[possible values: …]` list, unlike
      // --effort / --permission-mode / --output-format), so we register
      // it without a `values` constraint.
      "--sandbox": {
        arity: "one",
        description:
          "Sandbox profile for filesystem + network access (Phase 4 slice θ; freeform passthrough; env: GROK_SANDBOX)",
      },
      "--rules": {
        arity: "one",
        description:
          "Extra rules appended to the system prompt; supports `@file` prefix (Phase 4 slice θ)",
      },
      "--system-prompt-override": {
        arity: "one",
        description: "Replace the agent's system prompt entirely (Phase 4 slice θ)",
      },
      "--allow": {
        arity: "one",
        description:
          "Permission allow rule (Phase 4 slice θ; repeat once per rule per `grok --help`)",
      },
      "--deny": {
        arity: "one",
        description:
          "Permission deny rule (Phase 4 slice θ; repeat once per rule per `grok --help`)",
      },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "grok-minimal",
        description: "Minimal prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "grok-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-grok-flag"],
        expect: "fail",
      },
      {
        id: "grok-max-turns",
        description: "Phase 4 slice δ: --max-turns N is accepted",
        args: ["-p", "hello", "--max-turns", "5"],
        expect: "pass",
      },
      {
        id: "grok-max-turns-invalid-zero",
        description: "Phase 4 slice δ: --max-turns 0 is rejected by contract pattern",
        args: ["-p", "hello", "--max-turns", "0"],
        expect: "fail",
      },
      {
        id: "grok-working-dir",
        description: "Phase 4 slice ζ: --cwd <DIR> is accepted",
        args: ["-p", "hello", "--cwd", "/tmp/work"],
        expect: "pass",
      },
      {
        id: "grok-sandbox",
        description: "Phase 4 slice θ: --sandbox <PROFILE> accepted (freeform)",
        args: ["-p", "hello", "--sandbox", "workspace-write"],
        expect: "pass",
      },
      {
        id: "grok-rules",
        description: "Phase 4 slice θ: --rules <RULES> accepted (@file prefix preserved)",
        args: ["-p", "hello", "--rules", "@./rules.md"],
        expect: "pass",
      },
      {
        id: "grok-system-prompt-override",
        description: "Phase 4 slice θ: --system-prompt-override <PROMPT> accepted",
        args: ["-p", "hello", "--system-prompt-override", "You are a tester"],
        expect: "pass",
      },
      {
        id: "grok-allow-repeated",
        description: "Phase 4 slice θ: repeated --allow <RULE> accepted",
        args: ["-p", "hello", "--allow", "bash", "--allow", "edit"],
        expect: "pass",
      },
      {
        id: "grok-deny-repeated",
        description: "Phase 4 slice θ: repeated --deny <RULE> accepted",
        args: ["-p", "hello", "--deny", "write", "--deny", "kill"],
        expect: "pass",
      },
    ],
  },
  mistral: {
    cli: "mistral",
    executable: "vibe",
    upstream: "Mistral Vibe CLI",
    helpArgs: [["--help"]],
    maxPositionals: 0,
    mcpTools: ["mistral_request", "mistral_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "permissionMode",
      "effort",
      "reasoningEffort",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "disallowedTools",
      // Phase 4 slice γ
      "trust",
      // Phase 4 slice δ
      "maxTurns",
      "maxPrice",
      "maxTokens",
      // Phase 4 slice ζ
      "workingDir",
      "addDir",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--output": {
        arity: "one",
        values: ["text", "json", "streaming"],
        description: "Output format",
      },
      "--agent": {
        arity: "one",
        values: ["default", "plan", "accept-edits", "auto-approve", "chat", "explore", "lean"],
        description: "Agent/permission mode",
      },
      "--effort": { arity: "one", description: "Reasoning effort" },
      "--reasoning-effort": { arity: "one", description: "Reasoning effort override" },
      "--enabled-tools": { arity: "one", description: "Enabled tool" },
      "--resume": { arity: "one", description: "Resume session" },
      "--continue": { arity: "none", description: "Continue latest session" },
      "--trust": {
        arity: "none",
        description: "Trust cwd for this invocation only (Phase 4 slice γ)",
      },
      "--max-turns": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Agent-loop iteration cap (Phase 4 slice δ, programmatic mode only)",
      },
      "--max-price": {
        arity: "one",
        // Decimal-only: matches the MAX_PRICE_SCHEMA min(1e-6) lower bound
        // that keeps String(N) in decimal form (no scientific notation).
        pattern: /^(0|[1-9][0-9]*)(\.[0-9]+)?$/,
        description: "Cumulative cost cap in USD (Phase 4 slice δ, programmatic mode only)",
      },
      "--max-tokens": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Cumulative prompt + completion token cap (Vibe 2.x programmatic mode)",
      },
      "--workdir": {
        arity: "one",
        description: "Working directory for the invocation (Phase 4 slice ζ)",
      },
      "--add-dir": {
        arity: "one",
        description:
          "Additional writable workspace directory (Phase 4 slice ζ; repeat once per directory)",
      },
    },
    env: {
      VIBE_ACTIVE_MODEL: {
        arity: "one",
        pattern: /^[^\s\u0000-\u001f\u007f]+$/,
        description: "Active model selector; Vibe uses env instead of a --model flag",
      },
    },
    conformanceFixtures: [
      {
        id: "mistral-minimal",
        description: "Minimal prompt request with env-selected model",
        args: ["-p", "hello", "--agent", "auto-approve"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-unsupported-env",
        description: "Unsupported env var is rejected before spawn",
        args: ["-p", "hello"],
        env: { CODEX_MODEL: "gpt-5.5" },
        expect: "fail",
      },
      {
        id: "mistral-trust",
        description: "Phase 4 slice γ: --trust is accepted",
        args: ["-p", "hello", "--agent", "auto-approve", "--trust"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-max-turns-and-price",
        description: "Phase 4 slice δ: --max-turns + --max-price are accepted together",
        args: ["-p", "hello", "--agent", "auto-approve", "--max-turns", "3", "--max-price", "0.01"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-output-streaming-and-max-tokens",
        description: "Vibe 2.x: --output streaming and --max-tokens are accepted",
        args: [
          "-p",
          "hello",
          "--agent",
          "auto-approve",
          "--output",
          "streaming",
          "--max-tokens",
          "1000",
        ],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-max-price-scientific-notation",
        description:
          "Phase 4 slice δ: scientific-notation --max-price is rejected by contract pattern (matches MAX_PRICE_SCHEMA bounds)",
        args: ["-p", "hello", "--agent", "auto-approve", "--max-price", "1e-7"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-working-dir",
        description: "Phase 4 slice ζ: --workdir <DIR> is accepted",
        args: ["-p", "hello", "--agent", "auto-approve", "--workdir", "/tmp/work"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir is accepted",
        args: [
          "-p",
          "hello",
          "--agent",
          "auto-approve",
          "--add-dir",
          "/tmp/a",
          "--add-dir",
          "/tmp/b",
        ],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
    ],
  },
};

export function validateUpstreamCliArgs(
  cli: CliType,
  args: readonly string[]
): ContractValidationResult {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const violations: ContractViolation[] = [];
  let i = 0;
  let resumeContext = false;
  const positionals: string[] = [];

  if (contract.command) {
    if (args[0] !== contract.command.requiredFirstArg) {
      violations.push({
        cli,
        arg: args[0],
        index: 0,
        message: `${cli} argv must start with "${contract.command.requiredFirstArg}"`,
      });
      return { ok: false, violations };
    }
    i = 1;
    if (args[i] === contract.command.optionalSecondArg) {
      resumeContext = true;
      i += 1;
    }
  }

  for (; i < args.length; i++) {
    const arg = args[i];
    const flag = contract.flags[arg];
    if (!flag) {
      if (arg.startsWith("-")) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `Unsupported ${cli} CLI flag "${arg}" for bundled upstream contract`,
        });
      } else {
        positionals.push(arg);
      }
      continue;
    }

    if (resumeContext && contract.resumeForbiddenFlags?.includes(arg)) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" is not accepted by the resume command contract`,
      });
    }
    if (!resumeContext && contract.resumeOnlyFlags?.includes(arg)) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" is only valid with the resume command contract`,
      });
    }

    if (flag.arity === "none") {
      continue;
    }

    if (flag.arity === "one") {
      const value = args[i + 1];
      if (value === undefined) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `${cli} flag "${arg}" requires one value`,
        });
        continue;
      }
      validateFlagValue(cli, arg, flag, value, i + 1, violations);
      i += 1;
      continue;
    }

    if (flag.arity === "optional") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        validateFlagValue(cli, arg, flag, value, i + 1, violations);
        i += 1;
      }
      continue;
    }

    let consumed = 0;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      validateFlagValue(cli, arg, flag, args[i + 1], i + 1, violations);
      i += 1;
      consumed += 1;
    }
    if (consumed === 0) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" requires at least one value`,
      });
    }
  }

  const maxPositionals =
    resumeContext && contract.resumeMaxPositionals !== undefined
      ? contract.resumeMaxPositionals
      : contract.maxPositionals;
  if (positionals.length > maxPositionals) {
    violations.push({
      cli,
      message: `${cli} argv has ${positionals.length} positional values; upstream contract allows ${maxPositionals}`,
    });
  }

  return { ok: violations.length === 0, violations };
}

export function assertUpstreamCliArgs(cli: CliType, args: readonly string[]): void {
  const result = validateUpstreamCliArgs(cli, args);
  if (!result.ok) {
    const details = result.violations.map(v => v.message).join("; ");
    throw new Error(`Upstream ${cli} CLI contract violation: ${details}`);
  }
}

export function validateUpstreamCliEnv(
  cli: CliType,
  env: Record<string, string> | undefined
): ContractValidationResult {
  if (!env || Object.keys(env).length === 0) return { ok: true, violations: [] };
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const violations: ContractViolation[] = [];
  for (const [key, value] of Object.entries(env)) {
    const envContract = contract.env?.[key];
    if (!envContract) {
      violations.push({
        cli,
        arg: key,
        message: `Unsupported ${cli} CLI environment variable "${key}" for bundled upstream contract`,
      });
      continue;
    }
    validateFlagValue(cli, key, envContract, value, undefined, violations);
  }
  return { ok: violations.length === 0, violations };
}

export function assertUpstreamCliEnv(cli: CliType, env: Record<string, string> | undefined): void {
  const result = validateUpstreamCliEnv(cli, env);
  if (!result.ok) {
    const details = result.violations.map(v => v.message).join("; ");
    throw new Error(`Upstream ${cli} CLI environment contract violation: ${details}`);
  }
}

function validateFlagValue(
  cli: CliType,
  arg: string,
  flag: CliFlagContract,
  value: string,
  index: number | undefined,
  violations: ContractViolation[]
): void {
  if (flag.values && !flag.values.includes(value)) {
    violations.push({
      cli,
      arg: value,
      ...(index === undefined ? {} : { index }),
      message: `${cli} flag "${arg}" does not accept value "${value}"`,
    });
  }
  if (flag.pattern && !flag.pattern.test(value)) {
    violations.push({
      cli,
      arg: value,
      ...(index === undefined ? {} : { index }),
      message: `${cli} flag "${arg}" value "${value}" does not match required shape`,
    });
  }
}

export interface InstalledCliContractProbe {
  cli: CliType;
  executable: string;
  resolvedCommand?: string;
  resolvedArgs?: string[];
  available: boolean;
  checkedHelpCommands: string[][];
  missingFlags: string[];
  warnings: string[];
}

export function probeInstalledCliContract(
  cli: CliType,
  timeoutMs = 5_000
): InstalledCliContractProbe {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const outputs: string[] = [];
  const warnings: string[] = [];
  let resolvedCommand: string | undefined;
  let resolvedArgs: string[] | undefined;

  for (const helpArgs of contract.helpArgs) {
    const extendedPath = getExtendedPath();
    const env = envWithExtendedPath(process.env, extendedPath);
    const resolved = resolveCommandForSpawn(contract.executable, helpArgs, {
      envPath: extendedPath,
    });
    resolvedCommand ??= resolved.command;
    resolvedArgs ??= resolved.args;
    const result = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    if (result.error) {
      return {
        cli,
        executable: contract.executable,
        resolvedCommand: resolved.command,
        resolvedArgs: resolved.args,
        available: false,
        checkedHelpCommands: contract.helpArgs,
        missingFlags: [],
        warnings: [result.error.message],
      };
    }
    outputs.push(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.status !== 0) {
      warnings.push(
        `${contract.executable} ${helpArgs.join(" ")} exited with status ${result.status}`
      );
    }
  }

  const helpText = outputs.join("\n");
  const missingFlags = Object.keys(contract.flags).filter(flag => !helpText.includes(flag));
  return {
    cli,
    executable: contract.executable,
    resolvedCommand,
    resolvedArgs,
    available: true,
    checkedHelpCommands: contract.helpArgs,
    missingFlags,
    warnings,
  };
}

export function buildUpstreamContractReport(
  options: {
    cli?: CliType;
    probeInstalled?: boolean;
  } = {}
): Record<string, unknown> {
  const selected = options.cli ? [options.cli] : (Object.keys(UPSTREAM_CLI_CONTRACTS) as CliType[]);
  const contracts = Object.fromEntries(
    selected.map(cli => {
      const contract = UPSTREAM_CLI_CONTRACTS[cli];
      return [
        cli,
        {
          executable: contract.executable,
          upstream: contract.upstream,
          command: contract.command ?? null,
          helpArgs: contract.helpArgs,
          mcpTools: contract.mcpTools,
          mcpParameters: contract.mcpParameters,
          flags: Object.fromEntries(
            Object.entries(contract.flags).map(([name, flag]) => [
              name,
              {
                arity: flag.arity,
                values: flag.values ?? null,
                pattern: flag.pattern?.source ?? null,
                description: flag.description,
              },
            ])
          ),
          env: Object.fromEntries(
            Object.entries(contract.env ?? {}).map(([name, envContract]) => [
              name,
              {
                values: envContract.values ?? null,
                pattern: envContract.pattern?.source ?? null,
                description: envContract.description,
              },
            ])
          ),
          maxPositionals: contract.maxPositionals,
          resumeMaxPositionals: contract.resumeMaxPositionals ?? null,
          resumeOnlyFlags: contract.resumeOnlyFlags ?? [],
          resumeForbiddenFlags: contract.resumeForbiddenFlags ?? [],
          conformanceFixtures: contract.conformanceFixtures.map(fixture => ({
            id: fixture.id,
            description: fixture.description,
            expect: fixture.expect,
          })),
        },
      ];
    })
  );

  return {
    schemaVersion: "upstream-cli-contracts.v1",
    generatedAt: new Date().toISOString(),
    contracts,
    installedProbe: options.probeInstalled
      ? Object.fromEntries(selected.map(cli => [cli, probeInstalledCliContract(cli)]))
      : null,
  };
}
