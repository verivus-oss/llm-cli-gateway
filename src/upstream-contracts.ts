import { spawnSync } from "node:child_process";
import type { CliType } from "./session-manager.js";

export type CliFlagArity = "none" | "one" | "variadic";

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
      "approvalStrategy",
      "mcpServers",
      "strictMcpConfig",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--model": { arity: "one", description: "Model selector" },
      "--output-format": {
        arity: "one",
        values: ["json", "stream-json"],
        description: "Machine-readable output format",
      },
      "--include-partial-messages": {
        arity: "none",
        description: "Include partial messages in stream-json output",
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
    ],
    resumeOnlyFlags: ["--last"],
    resumeForbiddenFlags: [
      "--sandbox",
      "--ask-for-approval",
      "--full-auto",
      "--output-schema",
      "--search",
      "-c",
    ],
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
        id: "codex-resume-output-schema",
        description: "Resume-incompatible output schema flag is rejected",
        args: ["exec", "resume", "--output-schema", "/tmp/schema.json", "session-id", "hello"],
        expect: "fail",
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
      "-o": { arity: "one", values: ["json"], description: "Output format" },
      "--resume": { arity: "one", description: "Resume session" },
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
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--output-format": {
        arity: "one",
        values: ["plain", "json", "stream-json"],
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

  for (const helpArgs of contract.helpArgs) {
    const result = spawnSync(contract.executable, helpArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      return {
        cli,
        executable: contract.executable,
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
