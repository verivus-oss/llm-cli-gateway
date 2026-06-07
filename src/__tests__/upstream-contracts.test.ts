import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../index.js";
import {
  UPSTREAM_CLI_CONTRACTS,
  buildUpstreamContractReport,
  computeFlagDrift,
  validateUpstreamCliEnv,
  validateUpstreamCliArgs,
  extractDiscoveredFlags,
} from "../upstream-contracts.js";
import type { CliContract } from "../upstream-contracts.js";

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

  it("validates provider-specific env contracts", () => {
    expect(validateUpstreamCliEnv("mistral", { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" }).ok).toBe(
      true
    );
    const result = validateUpstreamCliEnv("codex", { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported codex CLI environment variable/);
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
          expect(
            callbackSource.includes(param),
            `${toolName} callback forwards ${param} (schema accepts it but the callback never references it — it would be silently dropped)`
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
      }
    });
  });
});
