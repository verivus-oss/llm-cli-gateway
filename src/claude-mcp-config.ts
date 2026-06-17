import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { parse as parseToml } from "smol-toml";
import type { ClaudeServerDef } from "./mcp-registry.js";
import { INTERNAL_MCP_REGISTRY } from "./mcp-registry.js";

// The internal MCP names + their host commands/env rules live solely in
// `mcp-registry.ts` (the single release-strip target). This module owns the
// generic config-generation orchestration; it never hardcodes a server name.
export { CLAUDE_MCP_SERVER_NAMES } from "./mcp-registry.js";

// Server names are open strings: the request schemas accept arbitrary names, the
// registry resolves the gateway-known ones, and unknown names fall back to Codex
// config (or are reported `missing`). A const-tuple union would force an
// exhaustive `switch` and reject the stripped public build's open inputs.
export type ClaudeMcpServerName = string;

interface CodexServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeMcpConfigResult {
  path: string;
  enabled: ClaudeMcpServerName[];
  missing: ClaudeMcpServerName[];
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      record[key] = String(entry);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function readCodexServerConfig(server: ClaudeMcpServerName): CodexServerDef {
  const codexConfigPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(codexConfigPath)) {
    return {};
  }

  try {
    const content = readFileSync(codexConfigPath, "utf-8");
    const parsed = parseToml(content) as Record<string, unknown>;
    const mcpServers = parsed.mcp_servers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      return {};
    }

    const serverConfig = (mcpServers as Record<string, unknown>)[server];
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
      return {};
    }

    const obj = serverConfig as Record<string, unknown>;
    const command = typeof obj.command === "string" ? obj.command : undefined;
    const args = asStringArray(obj.args);
    const env = asStringRecord(obj.env);

    return {
      command,
      args,
      env,
    };
  } catch {
    return {};
  }
}

// Generic resolver: merge Codex-config overrides over the registry default,
// forward/require the registry's env vars, and report `missing` (null) when a
// required credential is absent or an unknown name has no Codex fallback. All
// server-specific knowledge comes from `INTERNAL_MCP_REGISTRY`; this function
// hardcodes no name.
function toClaudeServerDef(server: ClaudeMcpServerName): ClaudeServerDef | null {
  const entry = INTERNAL_MCP_REGISTRY[server];
  const codexDef = readCodexServerConfig(server);
  const fallback: Partial<ClaudeServerDef> = entry ? entry.defaultDef() : {};

  const command = codexDef.command || fallback.command;
  if (!command) {
    // Unknown server with no Codex config and no registry fallback → missing.
    return null;
  }
  const args = codexDef.args || fallback.args || [];

  const env: Record<string, string> = {};
  if (codexDef.env) {
    Object.assign(env, codexDef.env);
  }

  if (entry) {
    for (const key of entry.forwardEnv ?? []) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
    // Required credentials may come from Codex config env or process.env;
    // absence marks the server `missing` rather than enabling it credential-less.
    for (const key of entry.requireEnv ?? []) {
      if (!env[key]) {
        return null;
      }
    }
  }

  return {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function buildClaudeMcpConfig(servers: ClaudeMcpServerName[]): ClaudeMcpConfigResult {
  const uniqueServers = [...new Set(servers)];
  const enabled: ClaudeMcpServerName[] = [];
  const missing: ClaudeMcpServerName[] = [];
  const mcpServers: Record<string, ClaudeServerDef> = {};

  for (const server of uniqueServers) {
    const def = toClaudeServerDef(server);
    if (!def) {
      missing.push(server);
      continue;
    }
    mcpServers[server] = def;
    enabled.push(server);
  }

  const configPath = join(homedir(), ".llm-cli-gateway", "claude-mcp.generated.json");
  const configDir = dirname(configPath);
  try {
    mkdirSync(configDir, { recursive: true });
    const tempPath = `${configPath}.tmp.${process.pid}`;
    writeFileSync(tempPath, JSON.stringify({ mcpServers }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, configPath);
    chmodSync(configPath, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write Claude MCP config: ${message}`);
  }

  return { path: configPath, enabled, missing };
}
