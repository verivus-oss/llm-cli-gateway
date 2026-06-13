import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAcpConfig,
  ACP_TRANSPORTS,
  DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS,
  DEFAULT_ACP_INITIALIZE_TIMEOUT_MS,
  DEFAULT_ACP_SESSION_NEW_TIMEOUT_MS,
  DEFAULT_ACP_PROMPT_TIMEOUT_MS,
} from "../config.js";
import { noopLogger } from "../logger.js";

describe("loadAcpConfig", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-config-test-"));
    stubbedConfig = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbedConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
    else process.env.LLM_GATEWAY_CONFIG = stubbedConfig;
  });

  function pointToFile(toml: string): string {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, toml);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
    return p;
  }

  function pointToMissing(): void {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "missing.toml"));
  }

  describe("constants", () => {
    it("default_transport stays cli and transports are exactly cli/acp", () => {
      expect(ACP_TRANSPORTS).toEqual(["cli", "acp"]);
    });
  });

  describe("default config", () => {
    it("returns fully dormant defaults when no config file exists", () => {
      pointToMissing();
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(false);
      expect(cfg.defaultTransport).toBe("cli");
      expect(cfg.smokeOnStartup).toBe(false);
      expect(cfg.processIdleTimeoutMs).toBe(DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS);
      expect(cfg.initializeTimeoutMs).toBe(DEFAULT_ACP_INITIALIZE_TIMEOUT_MS);
      expect(cfg.sessionNewTimeoutMs).toBe(DEFAULT_ACP_SESSION_NEW_TIMEOUT_MS);
      expect(cfg.promptTimeoutMs).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS);
      expect(cfg.allowWriteHostServices).toBe(false);
      expect(cfg.allowTerminalHostServices).toBe(false);
      expect(cfg.fallbackToCliWhenUnhealthy).toBe(true);
      expect(cfg.providers).toEqual({});
      expect(cfg.sources.configFile).toBeNull();
    });

    it("returns defaults when [acp] block is absent in an existing config file", () => {
      pointToFile('[persistence]\nbackend = "sqlite"\n');
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(false);
      expect(cfg.defaultTransport).toBe("cli");
      // The file existed and was consulted, so it is recorded as the source even
      // though the [acp] table itself was absent and defaults applied.
      expect(cfg.sources.configFile).not.toBeNull();
    });

    it("fills defaults for omitted keys when [acp] is present but partial", () => {
      pointToFile(["[acp]", "enabled = true", ""].join("\n"));
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(true);
      // Defaults still applied to everything else.
      expect(cfg.defaultTransport).toBe("cli");
      expect(cfg.promptTimeoutMs).toBe(DEFAULT_ACP_PROMPT_TIMEOUT_MS);
      expect(cfg.fallbackToCliWhenUnhealthy).toBe(true);
      expect(cfg.sources.configFile).not.toBeNull();
    });
  });

  describe("explicit disabled config", () => {
    it("reads an explicit fully-disabled [acp] block", () => {
      pointToFile(
        [
          "[acp]",
          "enabled = false",
          'default_transport = "cli"',
          "smoke_on_startup = false",
          "allow_write_host_services = false",
          "allow_terminal_host_services = false",
          "fallback_to_cli_when_unhealthy = false",
          "",
        ].join("\n")
      );
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(false);
      expect(cfg.defaultTransport).toBe("cli");
      expect(cfg.fallbackToCliWhenUnhealthy).toBe(false);
      expect(cfg.providers).toEqual({});
    });
  });

  describe("provider override config", () => {
    it("reads per-provider command/args and runtime gate", () => {
      pointToFile(
        [
          "[acp]",
          "enabled = true",
          "",
          "[acp.providers.mistral]",
          "enabled = true",
          'command = "vibe-acp"',
          "args = []",
          "runtime_enabled = false",
          "",
          "[acp.providers.grok]",
          "enabled = true",
          'command = "grok"',
          'args = ["agent", "stdio"]',
          "runtime_enabled = false",
          "isolated_leader_socket = true",
          "",
        ].join("\n")
      );
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(true);

      const mistral = cfg.providers.mistral;
      expect(mistral).toBeDefined();
      expect(mistral.command).toBe("vibe-acp");
      expect(mistral.args).toEqual([]);
      expect(mistral.runtimeEnabled).toBe(false);
      expect(mistral.isolatedLeaderSocket).toBe(false);

      const grok = cfg.providers.grok;
      expect(grok).toBeDefined();
      expect(grok.command).toBe("grok");
      expect(grok.args).toEqual(["agent", "stdio"]);
      expect(grok.runtimeEnabled).toBe(false);
      expect(grok.isolatedLeaderSocket).toBe(true);
    });

    it("allows path-style executables without shell metacharacters", () => {
      pointToFile(
        ["[acp.providers.mistral]", 'command = "/usr/local/bin/vibe-acp"', "args = []", ""].join(
          "\n"
        )
      );
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.providers.mistral.command).toBe("/usr/local/bin/vibe-acp");
    });
  });

  describe("invalid default transport", () => {
    it("throws on an unknown default_transport", () => {
      pointToFile(["[acp]", 'default_transport = "websocket"', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });
  });

  describe("invalid timeout", () => {
    it("throws on a non-positive prompt_timeout_ms", () => {
      pointToFile(["[acp]", "prompt_timeout_ms = 0", ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("throws on a non-integer initialize_timeout_ms", () => {
      pointToFile(["[acp]", "initialize_timeout_ms = 10.5", ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("throws on a negative process_idle_timeout_ms", () => {
      pointToFile(["[acp]", "process_idle_timeout_ms = -1", ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });
  });

  describe("rejected shell-style entrypoint strings", () => {
    it("rejects a command containing a shell pipe", () => {
      pointToFile(["[acp.providers.grok]", 'command = "grok | tee leak.log"', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects a command with embedded arguments (spaces)", () => {
      pointToFile(["[acp.providers.grok]", 'command = "grok agent stdio"', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects command substitution", () => {
      pointToFile(["[acp.providers.mistral]", 'command = "$(which vibe-acp)"', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects a redirect metacharacter", () => {
      pointToFile(["[acp.providers.mistral]", 'command = "vibe-acp>out"', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects an empty command string", () => {
      pointToFile(["[acp.providers.mistral]", 'command = ""', ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects a provider sub-table with no command at all", () => {
      pointToFile(["[acp.providers.mistral]", "enabled = true", ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });
  });

  describe("strict schema", () => {
    it("rejects unknown keys in the [acp] table", () => {
      pointToFile(["[acp]", "unknown_key = true", ""].join("\n"));
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });

    it("rejects unknown keys in a provider sub-table", () => {
      pointToFile(
        ["[acp.providers.mistral]", 'command = "vibe-acp"', "surprise = 1", ""].join("\n")
      );
      expect(() => loadAcpConfig(noopLogger)).toThrow(/Invalid \[acp\] config/);
    });
  });

  describe("syntax-invalid TOML", () => {
    it("falls back to defaults (does not throw) on unparseable TOML", () => {
      pointToFile("this is = = not valid toml [[[");
      const cfg = loadAcpConfig(noopLogger);
      expect(cfg.enabled).toBe(false);
      expect(cfg.defaultTransport).toBe("cli");
      expect(cfg.sources.configFile).toBeNull();
    });
  });
});
