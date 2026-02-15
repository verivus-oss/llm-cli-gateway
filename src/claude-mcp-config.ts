import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { parse as parseToml } from "toml";

export type ClaudeMcpServerName = "sqry" | "exa" | "ref_tools";

interface ClaudeServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

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
      env
    };
  } catch {
    return {};
  }
}

function findInstalledExaEntrypoint(): string | null {
  const nvmVersionsDir = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(nvmVersionsDir)) {
    return null;
  }

  let versions: string[] = [];
  try {
    versions = readdirSync(nvmVersionsDir);
  } catch {
    return null;
  }

  const candidates: string[] = [];
  for (const version of versions) {
    const entrypoint = join(
      nvmVersionsDir,
      version,
      "lib",
      "node_modules",
      "exa-mcp-server",
      ".smithery",
      "stdio",
      "index.cjs"
    );
    if (existsSync(entrypoint)) {
      candidates.push(entrypoint);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  return candidates[0];
}

function defaultServerDef(server: ClaudeMcpServerName): ClaudeServerDef {
  if (server === "sqry") {
    return { command: join(homedir(), ".local", "bin", "sqry-mcp"), args: [] };
  }
  if (server === "exa") {
    const exaEntrypoint = findInstalledExaEntrypoint();
    if (exaEntrypoint) {
      return {
        command: "node",
        args: [exaEntrypoint]
      };
    }
    return { command: "npx", args: ["-y", "exa-mcp-server"] };
  }
  return { command: "npx", args: ["-y", "ref-tools-mcp"] };
}

function toClaudeServerDef(server: ClaudeMcpServerName): ClaudeServerDef | null {
  const codexDef = readCodexServerConfig(server);
  const fallback = defaultServerDef(server);
  const command = codexDef.command || fallback.command;
  const args = codexDef.args || fallback.args || [];
  const env: Record<string, string> = {};

  if (codexDef.env) {
    Object.assign(env, codexDef.env);
  }

  if (server === "exa" && process.env.EXA_API_KEY) {
    env.EXA_API_KEY = process.env.EXA_API_KEY;
  }

  if (server === "ref_tools" && process.env.REF_API_KEY) {
    env.REF_API_KEY = process.env.REF_API_KEY;
  }

  // sqry should always be usable without env, but exa/ref_tools typically need credentials.
  if ((server === "exa" && !env.EXA_API_KEY) || (server === "ref_tools" && !env.REF_API_KEY)) {
    return null;
  }

  return {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {})
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
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write Claude MCP config: ${message}`);
  }

  return { path: configPath, enabled, missing };
}
