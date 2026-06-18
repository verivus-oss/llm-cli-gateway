import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { delimiter, join } from "path";
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

  it("enables trstr without credentials (same as sqry)", () => {
    const result = buildClaudeMcpConfig(["trstr"]);
    expect(result.enabled).toEqual(["trstr"]);
    expect(result.missing).toEqual([]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.trstr.command).toContain("trstr-mcp");
    expect(parsed.mcpServers.trstr.args).toEqual([]);
  });

  it("uses fallback path when no TOML entry for trstr", () => {
    writeCodexConfig(`
[mcp_servers.sqry]
command = "/custom/sqry-mcp"
`);
    const result = buildClaudeMcpConfig(["trstr"]);
    expect(result.enabled).toEqual(["trstr"]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.trstr.command).toContain("trstr-mcp");
  });

  it("uses TOML override for trstr command", () => {
    writeCodexConfig(`
[mcp_servers.trstr]
command = "/custom/trstr-mcp"
args = ["--verbose"]
`);
    const result = buildClaudeMcpConfig(["trstr"]);
    expect(result.enabled).toEqual(["trstr"]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.trstr.command).toBe("/custom/trstr-mcp");
    expect(parsed.mcpServers.trstr.args).toEqual(["--verbose"]);
  });

  it("uses TOML command-only override for trstr (args default to fallback)", () => {
    writeCodexConfig(`
[mcp_servers.trstr]
command = "/opt/trstr-mcp"
`);
    const result = buildClaudeMcpConfig(["trstr"]);
    expect(result.enabled).toEqual(["trstr"]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.trstr.command).toBe("/opt/trstr-mcp");
    expect(parsed.mcpServers.trstr.args).toEqual([]);
  });

  it("mixed strict mode: trstr enabled, exa missing without key", () => {
    const result = buildClaudeMcpConfig(["trstr", "exa"]);
    expect(result.enabled).toEqual(["trstr"]);
    expect(result.missing).toEqual(["exa"]);
  });

  it("deduplicates trstr entries", () => {
    const result = buildClaudeMcpConfig(["trstr", "trstr"]);
    expect(result.enabled).toEqual(["trstr"]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["trstr"]);
  });

  it("trstr coexists with all default servers when credentials present", () => {
    process.env.EXA_API_KEY = "exa-from-env";
    process.env.REF_API_KEY = "ref-from-env";

    const result = buildClaudeMcpConfig(["sqry", "exa", "ref_tools", "trstr"]);
    expect(result.enabled).toEqual(["sqry", "exa", "ref_tools", "trstr"]);
    expect(result.missing).toEqual([]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["exa", "ref_tools", "sqry", "trstr"]);
    expect(parsed.mcpServers.trstr.command).toContain("trstr-mcp");
  });

  it("falls back gracefully when codex config.toml is invalid", () => {
    process.env.EXA_API_KEY = "exa-from-env";
    process.env.REF_API_KEY = "ref-from-env";
    writeCodexConfig(`this is not valid toml = [`);

    const result = buildClaudeMcpConfig(["exa", "ref_tools"]);
    expect(result.enabled).toEqual(["exa", "ref_tools"]);
    expect(result.missing).toEqual([]);
  });

  // Schema widening (ClaudeMcpServerName → string) lets arbitrary names reach the
  // resolver. An unknown name with no registry entry and no Codex config has no
  // launch command → reported `missing` (never throws). This is also the
  // stripped-build path, where the registry is empty so EVERY name is "unknown".
  it("reports an unknown server name with no codex config as missing (no throw)", () => {
    const result = buildClaudeMcpConfig(["totally_unknown_server"]);
    expect(result.enabled).toEqual([]);
    expect(result.missing).toEqual(["totally_unknown_server"]);
  });

  // An unknown name DOES become usable if Codex config supplies a command —
  // unknown → codex-config-or-missing, per the resolver contract.
  it("enables an unknown server name when codex config supplies a command", () => {
    writeCodexConfig(`
[mcp_servers.custom_thing]
command = "/opt/custom-thing-mcp"
args = ["--stdio"]
`);

    const result = buildClaudeMcpConfig(["custom_thing"]);
    expect(result.enabled).toEqual(["custom_thing"]);
    expect(result.missing).toEqual([]);

    const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(parsed.mcpServers.custom_thing.command).toBe("/opt/custom-thing-mcp");
    expect(parsed.mcpServers.custom_thing.args).toEqual(["--stdio"]);
  });

  // agent_browser is PATH-gated (requireCommandOnPath, no npx fallback): it is
  // only enabled when the `agent-browser` binary is installed.
  it("marks agent_browser missing when agent-browser is not on PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = join(testHome, "empty-bin"); // contains no agent-browser
    try {
      const result = buildClaudeMcpConfig(["agent_browser"]);
      expect(result.enabled).toEqual([]);
      expect(result.missing).toEqual(["agent_browser"]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("enables agent_browser with `agent-browser mcp --tools core` when it is on PATH", () => {
    const binDir = join(testHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const exe = join(binDir, "agent-browser");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(exe, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    try {
      const result = buildClaudeMcpConfig(["agent_browser"]);
      expect(result.enabled).toEqual(["agent_browser"]);
      expect(result.missing).toEqual([]);

      const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(parsed.mcpServers.agent_browser.command).toBe("agent-browser");
      expect(parsed.mcpServers.agent_browser.args).toEqual(["mcp", "--tools", "core"]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("enables agent_browser via a Codex config command even when not on PATH", () => {
    writeCodexConfig(`
[mcp_servers.agent_browser]
command = "/opt/agent-browser"
args = ["mcp", "--tools", "core"]
`);
    const originalPath = process.env.PATH;
    process.env.PATH = join(testHome, "empty-bin");
    try {
      const result = buildClaudeMcpConfig(["agent_browser"]);
      expect(result.enabled).toEqual(["agent_browser"]);
      expect(result.missing).toEqual([]);

      const parsed = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(parsed.mcpServers.agent_browser.command).toBe("/opt/agent-browser");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
