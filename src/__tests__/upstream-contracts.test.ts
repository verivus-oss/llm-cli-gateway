import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../index.js";
import {
  UPSTREAM_CLI_CONTRACTS,
  buildUpstreamContractReport,
  validateUpstreamCliEnv,
  validateUpstreamCliArgs,
} from "../upstream-contracts.js";

describe("upstream CLI contracts", () => {
  it("accepts a valid Claude argv emitted by the gateway", () => {
    const result = validateUpstreamCliArgs("claude", [
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
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

  it("rejects flags not accepted by Codex resume", () => {
    // Phase 4 slice α (v1.8.0) confirmed `--output-schema` IS accepted on
    // resume per codex-cli 0.133.0; `--search` remains forbidden.
    const result = validateUpstreamCliArgs("codex", [
      "exec",
      "resume",
      "--search",
      "session-id",
      "prompt",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/not accepted by the resume command contract/);
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

  it("MCP request schemas expose the provider contract parameters", () => {
    const server = createGatewayServer();
    const registry = (
      server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>
    )._registeredTools;

    for (const contract of Object.values(UPSTREAM_CLI_CONTRACTS)) {
      for (const toolName of contract.mcpTools.filter(name => !name.endsWith("_async"))) {
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
});
