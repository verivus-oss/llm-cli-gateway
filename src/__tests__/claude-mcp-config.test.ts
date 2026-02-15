import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildClaudeMcpConfig } from "../claude-mcp-config.js";

describe("buildClaudeMcpConfig", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalExaApiKey: string | undefined;
  let originalRefApiKey: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "claude-mcp-config-test-"));
    originalHome = process.env.HOME;
    originalExaApiKey = process.env.EXA_API_KEY;
    originalRefApiKey = process.env.REF_API_KEY;

    process.env.HOME = testHome;
    delete process.env.EXA_API_KEY;
    delete process.env.REF_API_KEY;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalExaApiKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = originalExaApiKey;
    }

    if (originalRefApiKey === undefined) {
      delete process.env.REF_API_KEY;
    } else {
      process.env.REF_API_KEY = originalRefApiKey;
    }

    rmSync(testHome, { recursive: true, force: true });
  });

  function writeCodexConfig(content: string): void {
    const codexDir = join(testHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), content, "utf-8");
  }

  it("reads mcp server definitions from codex config.toml", () => {
    writeCodexConfig(`
[mcp_servers.sqry]
command = "/custom/sqry-mcp"
args = ["--stdio"]

[mcp_servers.exa]
command = "node"
args = ["/custom/exa/index.cjs"]
[mcp_servers.exa.env]
EXA_API_KEY = "exa-from-toml"

[mcp_servers.ref_tools]
command = "npx"
args = ["-y", "ref-tools-mcp"]
[mcp_servers.ref_tools.env]
REF_API_KEY = "ref-from-toml"
`);

    const result = buildClaudeMcpConfig(["sqry", "exa", "ref_tools"]);
    expect(result.enabled).toEqual(["sqry", "exa", "ref_tools"]);
    expect(result.missing).toEqual([]);
    expect(existsSync(result.path)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.sqry.command).toBe("/custom/sqry-mcp");
    expect(parsed.mcpServers.sqry.args).toEqual(["--stdio"]);
    expect(parsed.mcpServers.exa.command).toBe("node");
    expect(parsed.mcpServers.exa.args).toEqual(["/custom/exa/index.cjs"]);
    expect(parsed.mcpServers.exa.env.EXA_API_KEY).toBe("exa-from-toml");
    expect(parsed.mcpServers.ref_tools.env.REF_API_KEY).toBe("ref-from-toml");
  });

  it("marks credentialed MCPs as missing when required keys are absent", () => {
    writeCodexConfig(`
[mcp_servers.sqry]
command = "/custom/sqry-mcp"

[mcp_servers.exa]
command = "node"
args = ["/custom/exa/index.cjs"]

[mcp_servers.ref_tools]
command = "npx"
args = ["-y", "ref-tools-mcp"]
`);

    const result = buildClaudeMcpConfig(["sqry", "exa", "ref_tools"]);
    expect(result.enabled).toEqual(["sqry"]);
    expect(result.missing).toEqual(["exa", "ref_tools"]);
  });

  it("falls back to latest installed exa entrypoint when config is missing", () => {
    process.env.EXA_API_KEY = "exa-from-env";
    const older = join(
      testHome,
      ".nvm",
      "versions",
      "node",
      "v20.1.0",
      "lib",
      "node_modules",
      "exa-mcp-server",
      ".smithery",
      "stdio"
    );
    const newer = join(
      testHome,
      ".nvm",
      "versions",
      "node",
      "v20.12.0",
      "lib",
      "node_modules",
      "exa-mcp-server",
      ".smithery",
      "stdio"
    );
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, "index.cjs"), "", "utf-8");
    writeFileSync(join(newer, "index.cjs"), "", "utf-8");

    const result = buildClaudeMcpConfig(["exa"]);
    expect(result.enabled).toEqual(["exa"]);
    expect(result.missing).toEqual([]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.exa.command).toBe("node");
    expect(parsed.mcpServers.exa.args).toEqual([join(newer, "index.cjs")]);
  });

  it("falls back gracefully when codex config.toml is invalid", () => {
    process.env.EXA_API_KEY = "exa-from-env";
    process.env.REF_API_KEY = "ref-from-env";
    writeCodexConfig(`this is not valid toml = [`);

    const result = buildClaudeMcpConfig(["exa", "ref_tools"]);
    expect(result.enabled).toEqual(["exa", "ref_tools"]);
    expect(result.missing).toEqual([]);
  });
});
