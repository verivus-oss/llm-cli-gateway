/**
 * Phase 4 structural guards (FIX 5) so the "emitted flag missing from the
 * contract allowlist" class of bug cannot recur.
 *
 * (a) Emitted-argv-passes-contract: for every provider, the kitchen-sink argv
 *     produced by its prepare* builder must survive `assertUpstreamCliArgs`
 *     WITHOUT throwing. This is the direct guard for BLOCKER 1: a genuinely
 *     emitted flag that lives only in `acknowledgedUpstreamFlags` (not in the
 *     `flags` allowlist) makes assertUpstreamCliArgs throw here, failing the
 *     build. Test-veracity: move any emitted flag (e.g. Claude `--name`) back
 *     from the claude contract `flags` block into `acknowledgedUpstreamFlags`
 *     and the corresponding provider case throws -> red.
 *
 * (b) must_cover coverage-closure: for every provider, every flag listed in the
 *     DAG `must_cover_cli_flags` (parsed live from
 *     docs/plans/full-featured-cli-acp-provider-integrations.dag.toml) must be
 *     accounted for as EITHER a contract `flags` allowlist entry, a documented
 *     alias, an `acknowledgedUpstreamFlags` entry, or an entry in the provider's
 *     UNEXPOSED classification set. A flag in none of those is a silent
 *     omission and fails the test. Test-veracity: delete an unexposed entry
 *     (e.g. Codex `--search`) or drop a contract flag and its must_cover flag
 *     becomes uncovered -> red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assertUpstreamCliArgs, UPSTREAM_CLI_CONTRACTS } from "../upstream-contracts.js";
import {
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
  prepareDevinRequest,
  resolveGatewayServerRuntime,
} from "../index.js";
import type { CliType } from "../provider-types.js";
import {
  CLAUDE_UNEXPOSED_CLI_FLAGS,
  CODEX_UNEXPOSED_CLI_FLAGS,
  GEMINI_UNEXPOSED_CLI_FLAGS,
  MISTRAL_UNEXPOSED_CLI_FLAGS,
  type UnexposedCliFlag,
} from "../request-helpers.js";

// ── DAG must_cover parsing ───────────────────────────────────────────────────

const DAG_PATH = fileURLToPath(
  new URL("../../docs/plans/full-featured-cli-acp-provider-integrations.dag.toml", import.meta.url)
);
const DAG_TEXT = readFileSync(DAG_PATH, "utf8");

/**
 * Extract `must_cover_cli_flags` for a `[providers.<name>]` section by slicing
 * from that section header to the next top-level `[` section header, then
 * pulling the quoted flag literals out of the array. Reads the real DAG so the
 * coverage set is not a hand-maintained copy.
 */
function mustCoverFlags(provider: string): string[] {
  const header = `[providers.${provider}]`;
  const start = DAG_TEXT.indexOf(header);
  if (start < 0) throw new Error(`DAG has no section ${header}`);
  const rest = DAG_TEXT.slice(start + header.length);
  const nextSection = rest.search(/\n\[[A-Za-z]/);
  const block = nextSection < 0 ? rest : rest.slice(0, nextSection);
  const arrayMatch = block.match(/must_cover_cli_flags\s*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) throw new Error(`DAG section ${header} has no must_cover_cli_flags`);
  return Array.from(arrayMatch[1].matchAll(/"([^"]+)"/g)).map(m => m[1]);
}

// ── Coverage classification inputs ───────────────────────────────────────────

const UNEXPOSED: Record<string, readonly UnexposedCliFlag[]> = {
  claude: CLAUDE_UNEXPOSED_CLI_FLAGS,
  codex: CODEX_UNEXPOSED_CLI_FLAGS,
  gemini: GEMINI_UNEXPOSED_CLI_FLAGS,
  grok: [],
  mistral: MISTRAL_UNEXPOSED_CLI_FLAGS,
  devin: [],
};

/**
 * Documented alias mappings: a must_cover token whose canonical contract flag
 * has a different spelling. The Claude DAG lists the MCP field spellings
 * `--allowedTools` / `--disallowedTools`; the emitted argv flags are the
 * kebab-case `--allowed-tools` / `--disallowed-tools`.
 */
const ALIASES: Record<string, Record<string, string>> = {
  claude: {
    "--allowedTools": "--allowed-tools",
    "--disallowedTools": "--disallowed-tools",
  },
};

const DAG_PROVIDERS = ["claude", "codex", "gemini", "grok", "mistral", "devin"] as const;

function isCovered(provider: string, flag: string): boolean {
  const contract = UPSTREAM_CLI_CONTRACTS[provider as CliType];
  const flags = contract.flags;
  const alias = ALIASES[provider]?.[flag];
  const acknowledged = new Set(contract.acknowledgedUpstreamFlags ?? []);
  const unexposed = new Set((UNEXPOSED[provider] ?? []).map(e => e.flag));
  return (
    Object.prototype.hasOwnProperty.call(flags, flag) ||
    (alias !== undefined && Object.prototype.hasOwnProperty.call(flags, alias)) ||
    acknowledged.has(flag) ||
    unexposed.has(flag)
  );
}

// ── FIX 5(a): emitted argv passes the contract ───────────────────────────────

const CLAUDE_BASE = {
  prompt: "PROMPT",
  outputFormat: "text" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};

function claudeKitchenSinkArgv(): string[] {
  const prev = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "emitted-argv-claude-"));
  process.env.HOME = home;
  try {
    const prep = prepareClaudeRequest({
      ...CLAUDE_BASE,
      includeHookEvents: true,
      replayUserMessages: true,
      systemPromptFile: "/tmp/sys.txt",
      appendSystemPromptFile: "/tmp/append.txt",
      name: "my-session",
      pluginDir: ["/tmp/plugA", "/tmp/plugB.zip"],
      pluginUrl: ["https://example.com/a.zip", "https://example.com/b.zip"],
      safeMode: true,
      bare: true,
      debug: "api,hooks",
      debugFile: "/tmp/debug.log",
    } as never);
    if (!("args" in prep)) throw new Error("prepareClaudeRequest returned an error response");
    return prep.args;
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function codexKitchenSinkArgv(): string[] {
  const prep = prepareCodexRequest({
    prompt: "hello codex",
    fullAuto: false,
    dangerouslyBypassApprovalsAndSandbox: false,
    approvalStrategy: "legacy",
    mcpServers: [],
    optimizePrompt: false,
    operation: "codex_request",
    enable: ["feat_a", "feat_b"],
    disable: ["feat_c"],
    strictConfig: true,
    oss: true,
    localProvider: "ollama",
    color: "never",
    outputLastMessage: "/tmp/last.txt",
    dangerouslyBypassHookTrust: true,
  } as never);
  if (!("args" in prep)) throw new Error("prepareCodexRequest returned an error response");
  return prep.args;
}

function geminiKitchenSinkArgv(): string[] {
  const prep = prepareGeminiRequest({
    prompt: "PROMPT",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    operation: "gemini_request",
    model: "gemini-3-pro-preview",
    includeDirs: ["/a", "/b"],
    sandbox: true,
    yolo: true,
    project: "proj-1",
  } as never);
  if (!("args" in prep)) throw new Error("prepareGeminiRequest returned an error response");
  return prep.args;
}

function grokKitchenSinkArgv(): string[] {
  const prep = prepareGrokRequest({
    prompt: "PROMPT",
    operation: "grok_request",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    model: "grok-4",
    outputFormat: "json",
    permissionMode: "acceptEdits",
    effort: "high",
    reasoningEffort: "medium",
    allowedTools: ["Read", "Edit"],
    disallowedTools: ["Bash"],
    maxTurns: 9,
    workingDir: "/tmp/wd",
    sandbox: "workspace-write",
    rules: "@rules.md",
    systemPromptOverride: "be terse",
    allow: ["read", "write"],
    deny: ["exec"],
    compactionMode: "segments",
    compactionDetail: "verbose",
    agent: "reviewer",
    bestOfN: 3,
    check: true,
    disableWebSearch: true,
    todoGate: true,
    verbatim: true,
    agents: '{"reviewer":{"description":"d","prompt":"p"}}',
    experimentalMemory: true,
    noAltScreen: true,
    noMemory: true,
    noPlan: true,
    noSubagents: true,
    oauth: true,
    restoreCode: true,
    leaderSocket: "/run/grok.sock",
    nativeWorktree: "feat",
    worktreeRef: "main",
  } as never);
  if (!("args" in prep)) throw new Error("prepareGrokRequest returned an error response");
  return prep.args;
}

function mistralKitchenSinkArgv(): string[] {
  const prep = prepareMistralRequest({
    prompt: "PROMPT",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    operation: "mistral_request",
    permissionMode: "accept-edits",
    outputFormat: "json",
    allowedTools: ["bash", "grep"],
    disallowedTools: ["network", "shell"],
    trust: true,
    maxTurns: 7,
    maxPrice: 1.5,
    maxTokens: 4096,
    workingDir: "/tmp/wd",
    addDir: ["/x", "/y"],
  } as never);
  if (!("args" in prep)) throw new Error("prepareMistralRequest returned an error response");
  return prep.args;
}

function devinKitchenSinkArgv(): string[] {
  const prep = prepareDevinRequest(
    {
      prompt: "PROMPT",
      optimizePrompt: false,
      operation: "devin_request",
      model: "opus",
      permissionMode: "accept-edits",
      promptFile: "/tmp/p.txt",
      config: "/tmp/devin.toml",
      sandbox: true,
      exportSession: "/tmp/session.json",
      respectWorkspaceTrust: true,
      agentConfig: "/tmp/agent.toml",
    } as never,
    resolveGatewayServerRuntime()
  );
  if (!("args" in prep)) throw new Error("prepareDevinRequest returned an error response");
  return prep.args;
}

const KITCHEN_SINKS: Record<CliType | string, () => string[]> = {
  claude: claudeKitchenSinkArgv,
  codex: codexKitchenSinkArgv,
  gemini: geminiKitchenSinkArgv,
  grok: grokKitchenSinkArgv,
  mistral: mistralKitchenSinkArgv,
  devin: devinKitchenSinkArgv,
};

describe("FIX 5(a): emitted kitchen-sink argv survives assertUpstreamCliArgs", () => {
  for (const provider of DAG_PROVIDERS) {
    it(`${provider}: prepare* emits only contract-allowlisted flags`, () => {
      const argv = KITCHEN_SINKS[provider]();
      expect(() => assertUpstreamCliArgs(provider as CliType, argv)).not.toThrow();
    });
  }
});

// ── FIX 5(b): must_cover coverage closure ────────────────────────────────────

describe("FIX 5(b): DAG must_cover_cli_flags coverage closure", () => {
  it("the DAG parser actually enumerates every provider's must_cover set", () => {
    for (const provider of DAG_PROVIDERS) {
      const flags = mustCoverFlags(provider);
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(flag.startsWith("-")).toBe(true);
    }
    // Spot-check specific flags are actually read from the DAG (guards against a
    // parser that silently returns an empty/partial list).
    expect(mustCoverFlags("claude")).toContain("--worktree");
    expect(mustCoverFlags("claude")).toContain("--resume");
    expect(mustCoverFlags("codex")).toContain("--search");
    expect(mustCoverFlags("codex")).toContain("--ask-for-approval");
  });

  for (const provider of DAG_PROVIDERS) {
    it(`${provider}: every must_cover flag is wired, aliased, acknowledged, or classified unexposed`, () => {
      const uncovered = mustCoverFlags(provider).filter(flag => !isCovered(provider, flag));
      expect(uncovered).toEqual([]);
    });
  }
});
