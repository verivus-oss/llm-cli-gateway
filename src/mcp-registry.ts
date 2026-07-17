import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Internal MCP server registry — the single home for every gateway-internal MCP
 * name, host command, env rule, and approval-scoring weight.
 *
 * This module is the ONLY production source that hardcodes the internal MCP
 * names (`sqry`, `exa`, `ref_tools`, `trstr`, …), their host launch commands
 * (`sqry-mcp`, `exa-mcp-server`, `ref-tools-mcp`, `trstr-mcp`), and their
 * credential env-var names. Every other module imports from here, so the
 * release strip (`scripts/strip-internal-mcp.mjs`) can replace exactly this one
 * compiled file (`dist/mcp-registry.js` + `.d.ts`) with an empty stub and the
 * published tarball carries zero internal names. The public export surface is
 * deliberately minimal — two runtime value exports plus the two type interfaces
 * they reference — and the strip stub reproduces it identically (only the
 * NAME/command DATA goes empty), so a published build's types match a dev
 * build's:
 *   - `INTERNAL_MCP_REGISTRY` (value)
 *   - `CLAUDE_MCP_SERVER_NAMES` (value)
 *   - `ClaudeServerDef`, `RegistryEntry` (types; `ClaudeServerDef` is
 *     type-imported by `claude-mcp-config.ts`)
 *
 * Keep server-specific literals confined to this file. A new internal MCP server
 * is added by inserting one `INTERNAL_MCP_REGISTRY` entry; a PATH-gated local
 * server additionally extends `RegistryEntry` with an availability flag and the
 * resolver in `claude-mcp-config.ts` with the matching check.
 */

export interface ClaudeServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RegistryEntry {
  /**
   * Resolve the default (non-Codex-config) command/args for this server.
   * Evaluated lazily so host-probing logic (e.g. locating an installed exa
   * entrypoint) only runs when the server is actually requested.
   */
  defaultDef: () => ClaudeServerDef;
  /**
   * Env-var names forwarded from `process.env` into the generated config when
   * present (e.g. `EXA_API_KEY`). Forwarded values never appear in source.
   */
  forwardEnv?: readonly string[];
  /**
   * Env-var names that must resolve (from Codex config env or `process.env`) or
   * the server is reported `missing` rather than enabled.
   */
  requireEnv?: readonly string[];
  /**
   * When true, the resolved command must exist on PATH (unless Codex config
   * supplies an explicit command) or the server is reported `missing`. For
   * PATH-gated local servers that have no `npx` fallback (e.g. `agent_browser`),
   * so the gateway never writes a config pointing at an absent binary.
   */
  requireCommandOnPath?: boolean;
  /**
   * This registry definition is safe to place in a Claude `mcp_managed`
   * config. It must resolve only to a gateway-provisioned local command, with
   * no ambient PATH lookup, Codex override, or network-install fallback.
   * Omit it for legacy-only definitions such as dynamic `npx` launchers.
   */
  managedEligible?: boolean;
  /**
   * Approval-risk scoring applied by ApprovalManager when this server is
   * requested. Omit for zero-risk servers (e.g. `sqry`, `trstr`).
   */
  approval?: { score: number; reason: string };
}

function findInstalledExaEntrypoint(): string | null {
  const nvmVersionsDir = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(nvmVersionsDir)) {
    return null;
  }

  let versions: string[];
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

export const INTERNAL_MCP_REGISTRY: Record<string, RegistryEntry> = {
  sqry: {
    defaultDef: () => ({ command: join(homedir(), ".local", "bin", "sqry-mcp"), args: [] }),
    managedEligible: true,
  },
  exa: {
    defaultDef: () => {
      const exaEntrypoint = findInstalledExaEntrypoint();
      if (exaEntrypoint) {
        return { command: "node", args: [exaEntrypoint] };
      }
      return { command: "npx", args: ["-y", "exa-mcp-server"] };
    },
    forwardEnv: ["EXA_API_KEY"],
    requireEnv: ["EXA_API_KEY"],
    approval: { score: 2, reason: "Request enables external web/company research MCP (exa)" },
  },
  ref_tools: {
    defaultDef: () => ({ command: "npx", args: ["-y", "ref-tools-mcp"] }),
    forwardEnv: ["REF_API_KEY"],
    requireEnv: ["REF_API_KEY"],
    approval: { score: 1, reason: "Request enables documentation retrieval MCP (ref_tools)" },
  },
  trstr: {
    defaultDef: () => ({ command: join(homedir(), ".local", "bin", "trstr-mcp"), args: [] }),
    managedEligible: true,
  },
  agent_browser: {
    // Local browser-automation MCP. No npx fallback — it must be installed on
    // PATH, so it is reported `missing` until `agent-browser` is available.
    defaultDef: () => ({ command: "agent-browser", args: ["mcp", "--tools", "core"] }),
    requireCommandOnPath: true,
    approval: { score: 4, reason: "Request enables browser automation MCP (agent_browser)" },
  },
};

/**
 * The gateway-known MCP server names, derived from the registry so the list and
 * the per-server logic can never drift. Empty in a stripped public build (the
 * registry stub is `{}`), which the request schemas (open `z.string()`) and
 * approval scoring (no per-server weight) handle without crashing.
 */
export const CLAUDE_MCP_SERVER_NAMES: readonly string[] = Object.keys(INTERNAL_MCP_REGISTRY);
