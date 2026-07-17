import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCompatibleGenerationModes,
  captureTools,
  compareDeterministicStrings,
  renderToolsMarkdown,
} from "./generate-site-discovery.mjs";
import {
  assertNoPublicInternalMcpAliases,
  projectPublicMcpAliases,
} from "./public-site-mcp-policy.mjs";

const generatorUrl = pathToFileURL(
  join(fileURLToPath(new URL(".", import.meta.url)), "generate-site-discovery.mjs")
).href;

describe("generated public tools index", () => {
  it("rejects partial-generation flags in check mode", () => {
    expect(() =>
      assertCompatibleGenerationModes({
        checkOnly: true,
        skipToolsCapture: true,
        writeFixtureOnly: false,
      })
    ).toThrow("--check cannot be combined with --skip-tools-capture");
    expect(() =>
      assertCompatibleGenerationModes({
        checkOnly: true,
        skipToolsCapture: false,
        writeFixtureOnly: true,
      })
    ).toThrow("--check cannot be combined with --write-fixture-only");
  });

  it("uses the stable Pages version instead of an RC capture package version", () => {
    const markdown = renderToolsMarkdown({
      packageName: "llm-cli-gateway",
      packageVersion: "2.18.0-rc.1",
      siteVersion: "2.17.1",
      toolCount: 1,
      source: "test runtime capture",
      captureCommand: "test capture",
      generatedAt: "deterministic build output",
      tools: [{ name: "codex_request", description: "Review the checkout." }],
    });

    expect(markdown).toContain("- Public site version: `2.17.1`");
    expect(markdown).not.toContain("llm-cli-gateway@2.18.0-rc.1");
  });

  it("rejects a fixture that cannot state a stable public site version", () => {
    expect(() =>
      renderToolsMarkdown({
        siteVersion: "2.18.0-rc.1",
        tools: [],
      })
    ).toThrow(/stable siteVersion/);
  });

  it("projects private MCP aliases to the public open-string schema and fails closed elsewhere", () => {
    const projected = projectPublicMcpAliases({
      properties: {
        mcpServers: {
          items: { type: "string", enum: ["sqry", "exa"] },
        },
      },
    });

    expect(projected).toEqual({
      properties: {
        mcpServers: {
          items: { type: "string" },
        },
      },
    });
    expect(() => assertNoPublicInternalMcpAliases(projected, "fixture")).not.toThrow();
    expect(() => assertNoPublicInternalMcpAliases({ example: "sqry" }, "fixture")).toThrow(
      /internal MCP aliases: sqry/
    );
    expect(() =>
      assertNoPublicInternalMcpAliases({ example: "mcp__sqry__query" }, "fixture")
    ).toThrow(/internal MCP aliases: sqry/);
  });

  it("sorts public tool names identically under distinct LC_ALL values", () => {
    const names = ["zebra", "äther", "agent", "Alpha"];
    const expected = ["Alpha", "agent", "zebra", "äther"];
    expect([...names].sort(compareDeterministicStrings)).toEqual(expected);
    expect(
      readFileSync(fileURLToPath(new URL("./generate-site-discovery.mjs", import.meta.url)), "utf8")
    ).not.toContain(".localeCompare(");

    const run = locale => {
      const script = [
        `import { compareDeterministicStrings } from ${JSON.stringify(generatorUrl)};`,
        `process.stdout.write(${JSON.stringify(names)}.sort(compareDeterministicStrings).join(","));`,
      ].join(" ");
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: locale },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };

    expect(run("C")).toBe(expected.join(","));
    expect(run("tr_TR.UTF-8")).toBe(expected.join(","));
  });

  it("captures a fixed public surface despite hostile ambient gateway configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-cli-gateway-site-config-"));
    const configPath = join(directory, "gateway.toml");
    const originalConfig = process.env.LLM_GATEWAY_CONFIG;
    try {
      delete process.env.LLM_GATEWAY_CONFIG;
      const baseline = await captureTools("2.17.1");
      expect(baseline.tools.map(tool => tool.name)).toContain("review_changes");

      writeFileSync(
        configPath,
        [
          "[least_cost]",
          "enabled = true",
          "",
          "[personal_config]",
          "enabled = true",
          `baseline_path = "${join(directory, "baseline")}"`,
          "",
          "[providers.local_capture_test]",
          'kind = "openai-compatible"',
          'base_url = "http://127.0.0.1:11434/v1"',
          'default_model = "local"',
        ].join("\n")
      );
      process.env.LLM_GATEWAY_CONFIG = configPath;
      const hostile = await captureTools("2.17.1");

      expect(hostile).toEqual(baseline);
      expect(() => assertNoPublicInternalMcpAliases(hostile, "captured fixture")).not.toThrow();
    } finally {
      if (originalConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
      else process.env.LLM_GATEWAY_CONFIG = originalConfig;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
