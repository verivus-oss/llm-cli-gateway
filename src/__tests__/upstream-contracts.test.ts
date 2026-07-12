import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../index.js";
import {
  ACP_ENTRYPOINT_CONTRACTS,
  UPSTREAM_CLI_CONTRACTS,
  buildProviderSubcommandsCompactCatalog,
  buildUpstreamContractReport,
  computeFlagDrift,
  computeSubcommandFlagDrift,
  probeInstalledAcpEntrypoint,
  validateUpstreamCliEnv,
  validateUpstreamCliArgs,
  validateUpstreamCliSubcommandArgs,
  extractDiscoveredFlags,
  flattenCliSubcommands,
  getCliSubcommandContract,
  listProviderSubcommands,
} from "../upstream-contracts.js";
import type { CliContract } from "../upstream-contracts.js";
import { CLI_TYPES, type CliType } from "../provider-types.js";

describe("upstream CLI contracts", () => {
  it("accepts a valid Claude argv emitted by the gateway", () => {
    // Claude CLI 2.x requires --verbose alongside --print + stream-json;
    // the gateway emits all three together — pin the combo here so a
    // future removal trips this test before reaching the upstream CLI.
    const result = validateUpstreamCliArgs("claude", [
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--continue",
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects unsupported flags before they reach an upstream CLI", () => {
    const result = validateUpstreamCliArgs("gemini", ["-p", "hello", "--not-a-gemini-flag"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported gemini CLI flag/);
  });

  it("rejects enum values outside the provider contract", () => {
    const result = validateUpstreamCliArgs("codex", ["exec", "--sandbox", "workspace", "prompt"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/does not accept value "workspace"/);
  });

  it("rejects Codex approval flags removed from the installed CLI", () => {
    const ask = validateUpstreamCliArgs("codex", ["exec", "--ask-for-approval", "never", "prompt"]);
    expect(ask.ok).toBe(false);
    expect(ask.violations[0]?.message).toMatch(/Unsupported codex CLI flag/);

    const fullAuto = validateUpstreamCliArgs("codex", ["exec", "--full-auto", "prompt"]);
    expect(fullAuto.ok).toBe(false);
    expect(fullAuto.violations[0]?.message).toMatch(/Unsupported codex CLI flag/);
  });

  it("rejects Codex search because current codex exec no longer accepts it", () => {
    const result = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "--search",
      "session-id",
      "prompt",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported codex CLI flag/);
  });

  it("rejects Codex working-directory policy flags on resume", () => {
    const cd = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "-C",
      "/tmp/work",
      "session-id",
      "prompt",
    ]);
    expect(cd.ok).toBe(false);
    expect(cd.violations[0]?.message).toMatch(/not accepted by the resume command contract/);

    const addDir = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "--add-dir",
      "/tmp/extra",
      "session-id",
      "prompt",
    ]);
    expect(addDir.ok).toBe(false);
    expect(addDir.violations[0]?.message).toMatch(/not accepted by the resume command contract/);
  });

  it("rejects Codex profile selection on resume", () => {
    const result = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "--profile",
      "research",
      "session-id",
      "prompt",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/not accepted by the resume command contract/);
  });

  it("rejects Codex resume-only flags outside resume", () => {
    const result = validateUpstreamCliArgs("codex", ["exec", "--all", "prompt"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/only valid with the resume command contract/);
  });

  it("accepts --output-schema + -c on Codex resume (Phase 4 slice α)", () => {
    const result = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "--output-schema",
      "/tmp/schema.json",
      "-c",
      "model.foo=bar",
      "session-id",
      "prompt",
    ]);
    expect(result.ok).toBe(true);
  });

  it("exposes a stable report for MCP and CLI callers", () => {
    const report = buildUpstreamContractReport({ cli: "mistral" });
    expect(report).toMatchObject({
      schemaVersion: "upstream-cli-contracts.v1",
      installedProbe: null,
    });
    expect(JSON.stringify(report)).toContain("VIBE_ACTIVE_MODEL");
  });

  it("acknowledges Vibe's upstream-only --auto-approve shortcut without allowing it", () => {
    expect(UPSTREAM_CLI_CONTRACTS.mistral.acknowledgedUpstreamFlags).toContain("--auto-approve");

    const result = validateUpstreamCliArgs("mistral", ["-p", "hello", "--auto-approve"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported mistral CLI flag/);
  });

  it("ignores wrapped help fragments when extracting advertised flags", () => {
    const helpText = [
      "options:",
      "  -p, --prompt [TEXT]   Run in programmatic mode. Tool approval follows the selected",
      "                        --agent (or config); pass --auto-",
      "                        approve to allow all tool calls.",
      "  --agent NAME          Agent to use.",
      "  --auto-approve        Shortcut for --agent auto-approve.",
    ].join("\n");

    expect(extractDiscoveredFlags(helpText)).toEqual(["--agent", "--auto-approve", "--prompt"]);
  });

  it("keeps public Mistral permission mode descriptions listing the real builtins only", () => {
    // The stale seven-mode string must never reappear: chat/explore/lean are not
    // selectable primary builtins. The four real builtins stay documented as the
    // example set even though --agent is open (install-gated/custom names allowed).
    const staleSevenModePattern =
      /default\s*\|\s*plan\s*\|\s*accept-edits\s*\|\s*auto-approve\s*\|\s*chat\s*\|\s*explore\s*\|\s*lean/;
    const builtinFourPattern = /default\s*\|\s*plan\s*\|\s*accept-edits\s*\|\s*auto-approve/;
    const readme = readFileSync("README.md", "utf8");
    const index = readFileSync("src/index.ts", "utf8");

    expect(readme).not.toMatch(staleSevenModePattern);
    expect(index).not.toMatch(staleSevenModePattern);
    expect(readme).toMatch(builtinFourPattern);
    expect(index).toMatch(builtinFourPattern);
  });

  it("accepts arbitrary Vibe --agent names (install-gated builtins + custom agents)", () => {
    // Vibe resolves --agent against its own registry, so the gateway must not pin
    // a closed value set — `lean` (install-gated builtin) and custom agent names
    // are valid argv. (Regression guard: a fixed `values` list rejected `lean`.)
    for (const agent of ["lean", "my-custom-agent", "explore"]) {
      const result = validateUpstreamCliArgs("mistral", ["-p", "hello", "--agent", agent]);
      expect(result.ok, `--agent ${agent}`).toBe(true);
    }
  });

  it("declares subcommand metadata for all providers and an explicit empty Vibe tree", () => {
    for (const [cli, contract] of Object.entries(UPSTREAM_CLI_CONTRACTS)) {
      expect(contract.subcommands, `${cli} subcommands field`).toBeDefined();
      for (const subcommand of flattenCliSubcommands(contract.subcommands)) {
        expect(subcommand.commandPath.length, `${cli} commandPath`).toBeGreaterThan(0);
        expect(
          subcommand.helpArgs.length,
          `${cli} ${subcommand.commandPath.join(" ")} helpArgs`
        ).toBeGreaterThan(0);
        expect(
          subcommand.summary.length,
          `${cli} ${subcommand.commandPath.join(" ")} summary`
        ).toBeGreaterThan(10);
        expect(subcommand.exposure, `${cli} ${subcommand.commandPath.join(" ")} exposure`).toMatch(
          /^(tracked_only|mcp_readonly|mcp_requires_approval|not_exposed)$/
        );
        expect(subcommand.tier, `${cli} ${subcommand.commandPath.join(" ")} tier`).toMatch(
          /^(catalog|inspect|execute_candidate|diagnostic)$/
        );
        expect(
          subcommand.tokenCost,
          `${cli} ${subcommand.commandPath.join(" ")} tokenCost`
        ).toMatch(/^(tiny|small|medium|large)$/);
      }
    }
    expect(flattenCliSubcommands(UPSTREAM_CLI_CONTRACTS.mistral.subcommands)).toEqual([]);
  });

  it("validates subcommand argv through a separate API without loosening request argv", () => {
    const subcommand = validateUpstreamCliSubcommandArgs(
      "codex",
      ["review"],
      ["--base", "origin/master"]
    );
    expect(subcommand.ok).toBe(true);
    expect(subcommand.risk).toBe("executes_agent");
    expect(subcommand.exposure).toBe("tracked_only");

    const requestSurface = validateUpstreamCliArgs("codex", ["review", "--base", "origin/master"]);
    expect(requestSurface.ok).toBe(false);
    expect(requestSurface.violations[0]?.message).toMatch(/must start with "exec"/);
  });

  it("rejects unknown subcommand paths and subcommand-only flags outside their path", () => {
    const unknown = validateUpstreamCliSubcommandArgs("grok", ["not-real"], []);
    expect(unknown.ok).toBe(false);
    expect(unknown.violations[0]?.message).toMatch(/not declared/);

    const wrongPath = validateUpstreamCliSubcommandArgs("grok", ["models"], ["--json"]);
    expect(wrongPath.ok).toBe(false);
    expect(wrongPath.violations[0]?.message).toMatch(/Unsupported grok subcommand flag/);

    const noVibeSubcommands = validateUpstreamCliSubcommandArgs("mistral", ["doctor"], []);
    expect(noVibeSubcommands.ok).toBe(false);
    expect(noVibeSubcommands.violations[0]?.message).toMatch(/not declared/);
  });

  it("builds compact catalog rows and detailed one-command contracts without raw help", () => {
    const catalog = listProviderSubcommands();
    const compactCatalog = buildProviderSubcommandsCompactCatalog();
    const catalogJson = JSON.stringify(compactCatalog);
    expect(catalog.length).toBeGreaterThan(50);
    expect(catalogJson.length).toBeLessThan(12 * 1024);
    expect(catalogJson).not.toMatch(/Usage:|Options:/);
    expect(compactCatalog.columns).toContain("resourceUri");
    expect(compactCatalog.columns as readonly string[]).not.toContain("flags");

    const contract = getCliSubcommandContract("grok", ["agent", "serve"]);
    expect(contract).toBeDefined();
    const inspectJson = JSON.stringify(contract);
    expect(inspectJson.length).toBeLessThan(8 * 1024);
    expect(inspectJson).not.toMatch(/Usage:|Options:/);
  });

  it("keeps upstream_contracts subcommand data compact by default", () => {
    const report = buildUpstreamContractReport() as {
      contracts: Record<
        string,
        {
          subcommandCount: number;
          subcommandsCatalog: { columns: readonly string[]; rows: readonly unknown[] };
          subcommands?: unknown;
        }
      >;
    };
    const reportJson = JSON.stringify(report);
    expect(reportJson.length).toBeLessThan(70 * 1024);
    expect(report.contracts.grok.subcommandCount).toBeGreaterThan(20);
    expect(report.contracts.grok.subcommands).toBeUndefined();
    expect(report.contracts.grok.subcommandsCatalog.columns).toContain("resourceUri");
    expect(report.contracts.grok.subcommandsCatalog.columns).not.toContain("flags");
    expect(reportJson).not.toMatch(/Usage:|Options:/);
  });

  it("computes subcommand drift without using top-level request flags", () => {
    const contract = getCliSubcommandContract("grok", ["agent", "serve"]);
    expect(contract).toBeDefined();
    const drift = computeSubcommandFlagDrift(
      contract!,
      "grok",
      "Options:\n  --bind <ADDR>\n  --brand-new\n",
      ["--bind", "--brand-new"]
    );
    expect(drift.extraFlags).toEqual(["--brand-new"]);
    expect(drift.missingFlags).toEqual([
      "--grok-ws-origin",
      "--grok-ws-url",
      "--leader-socket",
      "--remote",
      "--secret",
    ]);
  });

  it("registers read-only MCP subcommand tools with compact responses", async () => {
    const { AsyncJobManager } = await import("../async-job-manager.js");
    const { MemoryJobStore } = await import("../job-store.js");
    const { noopLogger } = await import("../logger.js");
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: {
        backend: "sqlite",
        logsDbPath: ":memory:",
        jobsDbPath: ":memory:",
        jobRetentionDays: 7,
        dedupWindowMs: 0,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      },
    });
    const registry = (
      server as unknown as Record<
        string,
        Record<
          string,
          { annotations?: { readOnlyHint?: boolean }; handler?: (args: never) => unknown }
        >
      >
    )._registeredTools;
    for (const name of [
      "provider_subcommands_list",
      "provider_subcommand_contract",
      "provider_subcommand_drift",
    ]) {
      expect(registry[name], `${name} registered`).toBeDefined();
      expect(registry[name].annotations?.readOnlyHint, `${name} read-only`).toBe(true);
    }

    const listResult = (await registry.provider_subcommands_list.handler?.({
      provider: "grok",
    } as never)) as { content: { text: string }[] };
    const listText = listResult.content[0].text;
    expect(listText.length).toBeLessThan(12 * 1024);
    expect(listText).not.toMatch(/Usage:|Options:/);
    expect(listText).not.toContain('"flags"');

    const inspectResult = (await registry.provider_subcommand_contract.handler?.({
      provider: "grok",
      commandPath: ["agent", "serve"],
    } as never)) as { content: { text: string }[] };
    const inspectText = inspectResult.content[0].text;
    expect(inspectText.length).toBeLessThan(8 * 1024);
    expect(inspectText).toContain('"flags"');
    expect(inspectText).not.toMatch(/Usage:|Options:/);

    const templates = (
      server as unknown as Record<
        string,
        Record<
          string,
          {
            resourceTemplate: {
              uriTemplate: { toString: () => string; match: (uri: string) => unknown };
            };
          }
        >
      >
    )._registeredResourceTemplates;
    const template = templates["provider-subcommand-contract"].resourceTemplate.uriTemplate;
    expect(template.toString()).toBe("provider-subcommands://{provider}/{+commandPath}");
    expect(template.match("provider-subcommands://grok/models")).not.toBeNull();
    expect(template.match("provider-subcommands://grok/agent/serve")).not.toBeNull();
  });

  it("exposes provider_subcommands resources without raw help", async () => {
    const { ResourceProvider } = await import("../resources.js");
    const { PerformanceMetrics } = await import("../metrics.js");
    const sessionManagerStub = {
      listSessions: async () => [],
      getActiveSession: async () => null,
    };
    const provider = new ResourceProvider(sessionManagerStub as never, new PerformanceMetrics());

    const catalog = await provider.readResource("provider-subcommands://catalog");
    expect(catalog?.text.length).toBeLessThan(12 * 1024);
    expect(catalog?.text).not.toMatch(/Usage:|Options:/);

    const detail = await provider.readResource("provider-subcommands://grok/agent/serve");
    expect(detail?.text.length).toBeLessThan(8 * 1024);
    expect(detail?.text).toContain('"commandPath"');
    expect(detail?.text).not.toMatch(/Usage:|Options:/);

    const legacyCatalog = await provider.readResource("provider_subcommands://catalog");
    const legacyDetail = await provider.readResource("provider_subcommands://grok/agent/serve");
    expect(legacyCatalog).not.toBeNull();
    expect(legacyDetail).not.toBeNull();
  });

  it("validates provider-specific env contracts", () => {
    expect(validateUpstreamCliEnv("mistral", { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" }).ok).toBe(
      true
    );
    const result = validateUpstreamCliEnv("codex", { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported codex CLI environment variable/);
  });

  it("rejects whitespace and Unicode control characters in Vibe model selectors", () => {
    for (const model of [
      "contains space",
      "contains\u0000nul",
      "contains\u007fdel",
      "contains\u0085c1",
    ]) {
      const result = validateUpstreamCliEnv("mistral", { VIBE_ACTIVE_MODEL: model });
      expect(result.ok, JSON.stringify(model)).toBe(false);
      expect(result.violations[0]?.message).toMatch(/does not match required shape/);
    }
  });

  it("runs bundled static conformance fixtures mechanically", () => {
    for (const [cli, contract] of Object.entries(UPSTREAM_CLI_CONTRACTS)) {
      for (const fixture of contract.conformanceFixtures) {
        const args = validateUpstreamCliArgs(contract.cli, fixture.args);
        const env = validateUpstreamCliEnv(contract.cli, fixture.env);
        const ok = args.ok && env.ok;
        expect(ok, `${cli} fixture ${fixture.id}`).toBe(fixture.expect === "pass");
      }
    }
  });

  it("MCP request schemas expose the provider contract parameters (sync AND async)", async () => {
    // Post-test-veracity-audit (slice δ): previously this iteration
    // filtered out `_async` tools, so async-only schema drift would
    // pass silently. Per Codex/Grok's P-C4 finding, we now walk every
    // registered tool — including the `_async` variants, which only
    // register when persistence.asyncJobsEnabled === true AND the
    // manager has a real store. See test-veracity-regressions.test.ts
    // for the explicit slice-α/γ/δ allowlist assertion that backs this
    // up.
    const { AsyncJobManager } = await import("../async-job-manager.js");
    const { MemoryJobStore } = await import("../job-store.js");
    const { noopLogger } = await import("../logger.js");
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: {
        backend: "sqlite",
        logsDbPath: ":memory:",
        jobsDbPath: ":memory:",
        jobRetentionDays: 7,
        dedupWindowMs: 0,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      },
    });
    const registry = (
      server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>
    )._registeredTools;

    for (const contract of Object.values(UPSTREAM_CLI_CONTRACTS)) {
      for (const toolName of contract.mcpTools) {
        const tool = registry[toolName];
        expect(tool, `${toolName} registered`).toBeDefined();
        const schema = tool.inputSchema as { _def?: { shape?: () => Record<string, unknown> } };
        const shape = schema._def?.shape?.() ?? {};
        for (const param of contract.mcpParameters) {
          expect(Object.keys(shape), `${toolName} exposes ${param}`).toContain(param);
        }
      }
    }
  });

  it("MCP tool callbacks actually forward every contract parameter (sync AND async)", async () => {
    // Post-Grok-0.2.32 review (Codex finding): `leaderSocket` was present in
    // the Zod schema, the handler params, and the argv builder — but the MCP
    // tool callback destructures the inputs explicitly and rebuilds the object
    // passed to the handler, and that layer silently dropped the param. The
    // schema-exposure test above cannot catch that class of bug, so this test
    // asserts every contract mcpParameter name appears in the registered
    // callback's source for both the sync and async tools.
    //
    // ≥2 occurrences required, not ≥1: the 2.1.0 release mutation-probe audit
    // (P8, docs/reviews/release-2.1.0-test-veracity-audit.md) showed that an
    // includes() check survives removal of the call-object line alone — the
    // destructuring line still mentions the name while the param is genuinely
    // dropped. Every callback uses the destructure + rebuilt-object shape, so
    // a correctly forwarded param appears at least twice (verified: today's
    // minimum across all tools/params is exactly 2).
    const { AsyncJobManager } = await import("../async-job-manager.js");
    const { MemoryJobStore } = await import("../job-store.js");
    const { noopLogger } = await import("../logger.js");
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: {
        backend: "sqlite",
        logsDbPath: ":memory:",
        jobsDbPath: ":memory:",
        jobRetentionDays: 7,
        dedupWindowMs: 0,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      },
    });
    const registry = (server as unknown as Record<string, Record<string, { handler?: unknown }>>)
      ._registeredTools;

    for (const contract of Object.values(UPSTREAM_CLI_CONTRACTS)) {
      for (const toolName of contract.mcpTools) {
        const tool = registry[toolName];
        expect(tool, `${toolName} registered`).toBeDefined();
        expect(typeof tool.handler, `${toolName} handler present`).toBe("function");
        const callbackSource = String(tool.handler);
        for (const param of contract.mcpParameters) {
          const occurrences = (callbackSource.match(new RegExp(`\\b${param}\\b`, "g")) ?? [])
            .length;
          expect(
            occurrences >= 2,
            `${toolName} callback forwards ${param} (found ${occurrences} reference(s); a forwarded param appears in BOTH the destructure and the rebuilt call object — fewer means it is silently dropped)`
          ).toBe(true);
        }
      }
    }
  });

  describe("extractDiscoveredFlags (advisory help surface extractor)", () => {
    it("extracts long flags from typical clap-style help", () => {
      const help = `
Options:
  -p, --prompt <TEXT>     The prompt
      --output-format <FMT>  [possible values: plain, json, streaming-json]
      --permission-mode <MODE>
      --sandbox <PROFILE>
  -c, --continue
      --worktree [<NAME>]
`;
      const flags = extractDiscoveredFlags(help);
      expect(flags).toContain("--prompt");
      expect(flags).toContain("--output-format");
      expect(flags).toContain("--permission-mode");
      expect(flags).toContain("--sandbox");
      expect(flags).toContain("--continue");
      expect(flags).toContain("--worktree");
      // Should be sorted and unique
      expect(flags).toEqual([...flags].sort());
    });

    it("is robust against noise, URLs, and prose", () => {
      const noisy = [
        "See https://example.com/docs --foo-bar and also --baz in the --other-thing docs.",
        "Permission allow rule (Claude Code: --allowedTools)",
        "      --real-flag <VALUE>  Permission allow rule (Claude Code: --allowedTools)",
      ].join("\n");
      const flags = extractDiscoveredFlags(noisy);
      expect(flags).toEqual(["--real-flag"]);
    });

    it("handles grok-style TUI help (realistic excerpt)", () => {
      const grokish = `
      --todo-gate
      --best-of-n <N>
  -r, --resume [<ID>]
      --agent <NAME>
`;
      const flags = extractDiscoveredFlags(grokish);
      expect(flags).toContain("--todo-gate");
      expect(flags).toContain("--best-of-n");
      expect(flags).toContain("--resume");
      expect(flags).toContain("--agent");
    });
  });

  describe("computeFlagDrift (hidden/acknowledged probe semantics)", () => {
    const makeContract = (overrides: Partial<CliContract>): CliContract => ({
      cli: "claude",
      executable: "fake-cli",
      upstream: "Fake CLI",
      helpArgs: [["--help"]],
      maxPositionals: 0,
      mcpTools: [],
      mcpParameters: [],
      conformanceFixtures: [],
      flags: {},
      ...overrides,
    });

    it("reports a declared flag absent from help as missing", () => {
      const contract = makeContract({
        flags: { "--model": { arity: "one", description: "Model" } },
      });
      const drift = computeFlagDrift(contract, "Options:\n  --other <X>  Other\n", ["--other"]);
      expect(drift.missingFlags).toEqual(["--model"]);
    });

    it("does not report hiddenFromHelp flags as missing", () => {
      const contract = makeContract({
        flags: {
          "--max-turns": { arity: "one", description: "Turn cap", hiddenFromHelp: true },
        },
      });
      const drift = computeFlagDrift(contract, "Options:\n  --model <M>  Model\n", ["--model"]);
      expect(drift.missingFlags).toEqual([]);
      expect(drift.warnings).toEqual([]);
    });

    it("warns when a hiddenFromHelp flag reappears in help (stale marker)", () => {
      const contract = makeContract({
        flags: {
          "--max-turns": { arity: "one", description: "Turn cap", hiddenFromHelp: true },
        },
      });
      const drift = computeFlagDrift(contract, "  --max-turns <N>  Turn cap\n", ["--max-turns"]);
      expect(drift.missingFlags).toEqual([]);
      expect(drift.warnings[0]).toMatch(/hiddenFromHelp but now appears/);
    });

    it("filters acknowledged upstream-only flags out of extraFlags", () => {
      const contract = makeContract({
        flags: { "-p": { arity: "one", description: "Prompt" } },
        acknowledgedUpstreamFlags: ["--prompt", "--debug"],
      });
      const drift = computeFlagDrift(contract, "help", ["--prompt", "--debug", "--brand-new"]);
      expect(drift.extraFlags).toEqual(["--brand-new"]);
      expect(drift.acknowledgedExtraFlags).toEqual(["--prompt", "--debug"]);
      expect(drift.warnings).toEqual([]);
    });

    it("filters acknowledged upstream-only subcommand flags out of extraFlags", () => {
      const contract = getCliSubcommandContract("grok", ["agent", "leader"]);
      expect(contract).toBeDefined();
      const drift = computeSubcommandFlagDrift(contract!, "grok", "help", [
        "--debug",
        "--debug-file",
        "--brand-new",
      ]);
      expect(drift.extraFlags).toEqual(["--brand-new"]);
      expect(drift.acknowledgedExtraFlags).toEqual(["--debug", "--debug-file"]);
      expect(drift.warnings).toEqual([]);
    });

    it("warns when an acknowledged flag vanishes from the installed help (stale entry)", () => {
      const contract = makeContract({
        acknowledgedUpstreamFlags: ["--gone-now"],
      });
      const drift = computeFlagDrift(contract, "help", []);
      expect(drift.warnings[0]).toMatch(/--gone-now no longer appears/);
    });

    it("acknowledgement never affects the argv allowlist", () => {
      // acknowledgedUpstreamFlags is probe-only: passing such a flag as argv
      // must still be rejected by validateUpstreamCliArgs.
      const result = validateUpstreamCliArgs("gemini", ["-p", "hello", "--acp"]);
      expect(result.ok).toBe(false);
      expect(result.violations[0]?.message).toMatch(/Unsupported gemini CLI flag/);
    });

    it("live contracts keep flags and acknowledgements disjoint", () => {
      for (const contract of Object.values(UPSTREAM_CLI_CONTRACTS)) {
        const declared = new Set(Object.keys(contract.flags));
        for (const flag of contract.acknowledgedUpstreamFlags ?? []) {
          expect(
            declared.has(flag),
            `${contract.cli}: ${flag} both declared and acknowledged`
          ).toBe(false);
        }
        for (const subcommand of flattenCliSubcommands(contract.subcommands)) {
          const subDeclared = new Set(Object.keys(subcommand.flags));
          for (const flag of subcommand.acknowledgedUpstreamFlags ?? []) {
            expect(
              subDeclared.has(flag),
              `${contract.cli} ${subcommand.commandPath.join(" ")}: ${flag} both declared and acknowledged`
            ).toBe(false);
          }
        }
      }
    });
  });

  describe("ACP upstream entrypoint contracts (track-acp-upstream-contracts)", () => {
    const ALL_PROVIDERS: readonly CliType[] = CLI_TYPES;

    it("declares an ACP entrypoint contract for every provider with the matrix status", () => {
      const expected: Record<CliType, string> = {
        mistral: "native",
        grok: "native",
        devin: "native",
        codex: "adapter_mediated_deferred",
        claude: "adapter_mediated_deferred",
        gemini: "absent_watchlist",
        cursor: "native",
      };
      for (const cli of ALL_PROVIDERS) {
        const acp = ACP_ENTRYPOINT_CONTRACTS[cli];
        expect(acp, `${cli} ACP contract missing`).toBeDefined();
        expect(acp.cli).toBe(cli);
        expect(acp.status, `${cli} ACP status`).toBe(expected[cli]);
      }
    });

    it("pins native entrypoints to vibe-acp and `grok agent stdio`, no adapter labelled native", () => {
      expect(ACP_ENTRYPOINT_CONTRACTS.mistral.executable).toBe("vibe-acp");
      expect(ACP_ENTRYPOINT_CONTRACTS.mistral.entrypointArgs).toEqual([]);
      expect(ACP_ENTRYPOINT_CONTRACTS.grok.executable).toBe("grok");
      expect(ACP_ENTRYPOINT_CONTRACTS.grok.entrypointArgs).toEqual(["agent", "stdio"]);
      expect(ACP_ENTRYPOINT_CONTRACTS.devin.executable).toBe("devin");
      expect(ACP_ENTRYPOINT_CONTRACTS.devin.entrypointArgs).toEqual(["acp"]);
      expect(ACP_ENTRYPOINT_CONTRACTS.cursor.executable).toBe("cursor-agent");
      expect(ACP_ENTRYPOINT_CONTRACTS.cursor.entrypointArgs).toEqual(["acp"]);

      // codex/claude adapters are documentation only, never native.
      expect(ACP_ENTRYPOINT_CONTRACTS.codex.status).not.toBe("native");
      expect(ACP_ENTRYPOINT_CONTRACTS.claude.status).not.toBe("native");
      expect((ACP_ENTRYPOINT_CONTRACTS.codex.adapterCandidates ?? []).length).toBeGreaterThan(0);
      expect((ACP_ENTRYPOINT_CONTRACTS.claude.adapterCandidates ?? []).length).toBeGreaterThan(0);
    });

    it("keeps agy on the watchlist with no ACP surface at agy 1.1.0", () => {
      const agy = ACP_ENTRYPOINT_CONTRACTS.gemini;
      expect(agy.status).toBe("absent_watchlist");
      expect(agy.executable).toBe("agy");
      expect(agy.targetVersion).toContain("1.1.0");
      expect(agy.entrypointArgs).toEqual([]);
      expect(agy.probeArgs).toEqual([]);
    });

    it("only native providers declare a read-only probe, and probes never start the live ACP process", () => {
      for (const cli of ALL_PROVIDERS) {
        const acp = ACP_ENTRYPOINT_CONTRACTS[cli];
        if (acp.status === "native") {
          expect(acp.probeArgs.length, `${cli} native must declare a probe`).toBeGreaterThan(0);
          // Every native probe must be a read-only --version/--help variant —
          // never the bare live entrypoint (no probe equals the entrypoint args).
          for (const probe of acp.probeArgs) {
            expect(
              probe.some(a => a === "--version" || a === "--help"),
              `${cli} probe ${probe.join(" ")} must be read-only`
            ).toBe(true);
            expect(
              JSON.stringify(probe),
              `${cli} probe must not be the bare live entrypoint`
            ).not.toBe(JSON.stringify(acp.entrypointArgs));
          }
        } else {
          expect(acp.probeArgs, `${cli} non-native must not declare a live probe`).toEqual([]);
        }
      }
    });

    it("does NOT widen any request argv allowlist (entrypoint args are not accepted as request flags)", () => {
      // The Grok ACP entrypoint is `agent stdio`. Feeding those tokens as
      // request argv must still be rejected by the request validator — ACP
      // tracking is a separate surface.
      const result = validateUpstreamCliArgs("grok", ["-p", "hello", "agent", "stdio"]);
      expect(result.ok).toBe(false);
    });

    it("surfaces ACP entrypoint metadata in the report under acpEntrypoint, separate from request flags", () => {
      const report = buildUpstreamContractReport() as {
        contracts: Record<string, { acpEntrypoint?: Record<string, unknown>; flags: unknown }>;
      };
      for (const cli of ALL_PROVIDERS) {
        const acp = report.contracts[cli].acpEntrypoint;
        expect(acp, `${cli} report acpEntrypoint`).toBeDefined();
        expect(acp?.status).toBe(ACP_ENTRYPOINT_CONTRACTS[cli].status);
        expect(acp?.native).toBe(ACP_ENTRYPOINT_CONTRACTS[cli].status === "native");
      }
      expect(report.contracts.mistral.acpEntrypoint?.native).toBe(true);
      expect(report.contracts.gemini.acpEntrypoint?.native).toBe(false);
    });

    it("emits acpInstalledProbe separately from request-tool installedProbe only when probing", () => {
      const noProbe = buildUpstreamContractReport() as Record<string, unknown>;
      expect(noProbe.acpInstalledProbe).toBeNull();
      expect(noProbe.installedProbe).toBeNull();

      const probed = buildUpstreamContractReport({ cli: "codex", probeInstalled: true }) as {
        acpInstalledProbe: Record<string, { status: string; available: boolean | null }>;
        installedProbe: Record<string, unknown>;
      };
      // Distinct top-level keys: ACP drift never masquerades as request drift.
      expect(probed.acpInstalledProbe).not.toBeNull();
      expect(probed.installedProbe).not.toBeNull();
      expect(probed.acpInstalledProbe).not.toBe(probed.installedProbe);
      // Codex has no native ACP entrypoint -> nothing to probe -> available null.
      expect(probed.acpInstalledProbe.codex.status).toBe("adapter_mediated_deferred");
      expect(probed.acpInstalledProbe.codex.available).toBeNull();
    });

    it("probeInstalledAcpEntrypoint does not spawn anything for adapter/absent providers", () => {
      for (const cli of ["codex", "claude", "gemini"] as const) {
        const probe = probeInstalledAcpEntrypoint(cli);
        expect(probe.available, `${cli} should not be probed`).toBeNull();
        expect(probe.entrypointDrift, `${cli} has no native entrypoint to drift`).toBe(false);
        expect(probe.checkedProbeCommands).toEqual([]);
      }
    });

    it("probeInstalledAcpEntrypoint reports native entrypoint drift when the binary is absent", () => {
      // Probe a native provider that resolves to a non-existent binary path by
      // temporarily pointing the executable at a name that cannot resolve.
      const original = ACP_ENTRYPOINT_CONTRACTS.mistral.executable;
      try {
        (ACP_ENTRYPOINT_CONTRACTS.mistral as { executable: string }).executable =
          "vibe-acp-nonexistent-binary-xyz";
        const probe = probeInstalledAcpEntrypoint("mistral");
        expect(probe.status).toBe("native");
        expect(probe.available).toBe(false);
        expect(probe.entrypointDrift).toBe(true);
        expect(probe.warnings.length).toBeGreaterThan(0);
      } finally {
        (ACP_ENTRYPOINT_CONTRACTS.mistral as { executable: string }).executable = original;
      }
    });
  });
});
