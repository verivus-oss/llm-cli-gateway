import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  ACP_CONTRACT,
  clearProviderToolCapabilitiesCache,
  getProviderToolCapabilities,
  providerCapabilityIds,
} from "../provider-tool-capabilities.js";

const REPO_ROOT = join(__dirname, "..", "..");
const CONTRACT_DOC = join(REPO_ROOT, "docs", "acp-contract.md");
const SCOPE_DOC = join(REPO_ROOT, "docs", "acp-scope.md");
const INDEX_SRC = join(REPO_ROOT, "src", "index.ts");

function readDoc(path: string): string {
  return readFileSync(path, "utf8");
}

describe("freeze-contract-and-non-goals: ACP contract metadata", () => {
  it("uses Agent Client Protocol terminology and marks Agent Communication Protocol out of scope", () => {
    expect(ACP_CONTRACT.protocol).toBe("Agent Client Protocol");
    expect(ACP_CONTRACT.outOfScope).toBe("Agent Communication Protocol");
  });

  it("freezes the core decisions", () => {
    expect(ACP_CONTRACT.mcpFrontendRemains).toBe(true);
    expect(ACP_CONTRACT.acpIsInternalProviderTransport).toBe(true);
    expect(ACP_CONTRACT.defaultTransport).toBe("cli");
    expect(ACP_CONTRACT.hostServicesDenyByDefault).toBe(true);
    expect(ACP_CONTRACT.noRawAcpJsonRpcTool).toBe(true);
    expect(ACP_CONTRACT.adapterSupportIsNotNative).toBe(true);
    expect(ACP_CONTRACT.contractDoc).toBe("docs/acp-contract.md");
  });

  it("freezes the non-goals including the agent-to-agent protocol exclusion", () => {
    expect(ACP_CONTRACT.nonGoals.length).toBeGreaterThanOrEqual(6);
    expect(ACP_CONTRACT.nonGoals).toContain("Replace the MCP server.");
    expect(ACP_CONTRACT.nonGoals).toContain("Expose raw ACP JSON-RPC to agents.");
    expect(ACP_CONTRACT.nonGoals.some(goal => /Agent Communication Protocol/.test(goal))).toBe(
      true
    );
  });

  it("classifies Mistral, Grok and Devin as native candidates, never adapter as native", () => {
    expect(ACP_CONTRACT.providers.mistral.classification).toBe("native_candidate");
    expect(ACP_CONTRACT.providers.grok.classification).toBe("native_candidate");
    expect(ACP_CONTRACT.providers.devin.classification).toBe("native_candidate");
    expect(ACP_CONTRACT.providers.codex.classification).toBe("adapter_mediated_deferred");
    expect(ACP_CONTRACT.providers.claude.classification).toBe("adapter_mediated_deferred");
    expect(ACP_CONTRACT.providers.gemini.classification).toBe("absent_watchlist");

    // No provider is classified as "native" without being a candidate; adapter
    // providers must never be native.
    expect(ACP_CONTRACT.providers.codex.classification).not.toBe("native_candidate");
    expect(ACP_CONTRACT.providers.claude.classification).not.toBe("native_candidate");
  });

  it("provides a frozen classification for every provider capability id", () => {
    for (const id of providerCapabilityIds()) {
      expect(ACP_CONTRACT.providers[id]).toBeDefined();
      expect(ACP_CONTRACT.providers[id].summary.length).toBeGreaterThan(10);
    }
  });
});

describe("freeze-contract-and-non-goals: capability surface", () => {
  it("exposes acpContract on every provider capability object matching the frozen contract", () => {
    clearProviderToolCapabilitiesCache();
    const caps = getProviderToolCapabilities();
    for (const id of providerCapabilityIds()) {
      const cap = caps[id];
      expect(cap).toBeDefined();
      expect(cap?.acpContract).toEqual(ACP_CONTRACT.providers[id]);
    }
    clearProviderToolCapabilitiesCache();
  });

  it("returns a copy so callers cannot mutate the frozen contract", () => {
    clearProviderToolCapabilitiesCache();
    const cap = getProviderToolCapabilities("mistral").mistral;
    expect(cap?.acpContract).not.toBe(ACP_CONTRACT.providers.mistral);
    clearProviderToolCapabilitiesCache();
  });
});

describe("freeze-contract-and-non-goals: docs", () => {
  it("contract doc uses Agent Client Protocol and excludes Agent Communication Protocol", () => {
    const doc = readDoc(CONTRACT_DOC);
    expect(doc).toMatch(/Agent Client Protocol/);
    expect(doc).toMatch(/Agent Communication Protocol/);
    expect(doc).toMatch(/out[\s*-]+of[\s*-]+scope/i);
    // The frozen no-raw-JSON-RPC decision must be stated.
    expect(doc).toMatch(/raw ACP JSON-RPC/);
  });

  it("contract doc states the deny-by-default HostServices and native-vs-adapter decisions", () => {
    const doc = readDoc(CONTRACT_DOC);
    expect(doc).toMatch(/deny-by-default/i);
    expect(doc).toMatch(/adapter-mediated/i);
    expect(doc).toMatch(/native/i);
    expect(doc).toMatch(/default_transport.*cli|`cli`/);
  });

  it("scope doc points at the frozen contract", () => {
    const doc = readDoc(SCOPE_DOC);
    expect(doc).toMatch(/docs\/acp-contract\.md/);
  });
});

describe("freeze-contract-and-non-goals: no raw ACP JSON-RPC tool", () => {
  it("registers no MCP tool whose name exposes raw ACP JSON-RPC", () => {
    const source = readFileSync(INDEX_SRC, "utf8");
    const toolNameRegex = /server\.tool\(\s*["']([^"']+)["']/g;
    const toolNames: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = toolNameRegex.exec(source)) !== null) {
      toolNames.push(match[1]);
    }
    // Sanity: we actually scanned registered tools.
    expect(toolNames.length).toBeGreaterThan(0);

    const forbidden = /(json_?rpc|jsonrpc|raw_acp|acp_raw|acp_json|acp_jsonrpc)/i;
    const offenders = toolNames.filter(name => forbidden.test(name));
    expect(offenders).toEqual([]);
  });
});
