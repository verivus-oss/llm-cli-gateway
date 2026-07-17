import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod/v3";
import { CLAUDE_MCP_SERVER_NAMES, INTERNAL_MCP_REGISTRY } from "../mcp-registry.js";

describe("INTERNAL_MCP_REGISTRY", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // An empty HOME means no ~/.nvm exa entrypoint, so exa's defaultDef resolves
    // deterministically to the npx fallback.
    testHome = mkdtempSync(join(tmpdir(), "mcp-registry-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it("exposes exactly the gateway-known server names, derived from the registry", () => {
    expect(Object.keys(INTERNAL_MCP_REGISTRY)).toEqual([
      "sqry",
      "exa",
      "ref_tools",
      "trstr",
      "agent_browser",
    ]);
    // CLAUDE_MCP_SERVER_NAMES is the keys of the registry — they can never drift.
    expect([...CLAUDE_MCP_SERVER_NAMES]).toEqual(Object.keys(INTERNAL_MCP_REGISTRY));
  });

  it("every entry carries a defaultDef closure", () => {
    for (const [name, entry] of Object.entries(INTERNAL_MCP_REGISTRY)) {
      expect(typeof entry.defaultDef, name).toBe("function");
      const def = entry.defaultDef();
      expect(typeof def.command, name).toBe("string");
      expect(Array.isArray(def.args), name).toBe(true);
    }
  });

  it("sqry/trstr resolve to local host binaries and carry no credentials or approval weight", () => {
    expect(INTERNAL_MCP_REGISTRY.sqry.defaultDef().command).toContain("sqry-mcp");
    expect(INTERNAL_MCP_REGISTRY.trstr.defaultDef().command).toContain("trstr-mcp");
    expect(INTERNAL_MCP_REGISTRY.sqry.approval).toBeUndefined();
    expect(INTERNAL_MCP_REGISTRY.trstr.approval).toBeUndefined();
    expect(INTERNAL_MCP_REGISTRY.sqry.requireEnv).toBeUndefined();
    expect(INTERNAL_MCP_REGISTRY.sqry.managedEligible).toBe(true);
    expect(INTERNAL_MCP_REGISTRY.trstr.managedEligible).toBe(true);
  });

  it("agent_browser is a PATH-gated local server with browser-automation approval weight", () => {
    const ab = INTERNAL_MCP_REGISTRY.agent_browser;
    expect(ab.defaultDef()).toEqual({ command: "agent-browser", args: ["mcp", "--tools", "core"] });
    expect(ab.requireCommandOnPath).toBe(true);
    // No npx fallback and no credential env — availability is purely "is it on PATH".
    expect(ab.requireEnv).toBeUndefined();
    expect(ab.forwardEnv).toBeUndefined();
    expect(ab.approval).toEqual({
      score: 4,
      reason: "Request enables browser automation MCP (agent_browser)",
    });
  });

  it("exa requires + forwards EXA_API_KEY and scores +2", () => {
    const exa = INTERNAL_MCP_REGISTRY.exa;
    expect(exa.managedEligible).toBeUndefined();
    expect(exa.requireEnv).toEqual(["EXA_API_KEY"]);
    expect(exa.forwardEnv).toEqual(["EXA_API_KEY"]);
    expect(exa.approval).toEqual({
      score: 2,
      reason: "Request enables external web/company research MCP (exa)",
    });
    // No installed entrypoint under the empty HOME → npx fallback.
    expect(exa.defaultDef()).toEqual({ command: "npx", args: ["-y", "exa-mcp-server"] });
  });

  it("ref_tools requires + forwards REF_API_KEY and scores +1", () => {
    const ref = INTERNAL_MCP_REGISTRY.ref_tools;
    expect(ref.managedEligible).toBeUndefined();
    expect(ref.requireEnv).toEqual(["REF_API_KEY"]);
    expect(ref.forwardEnv).toEqual(["REF_API_KEY"]);
    expect(ref.approval).toEqual({
      score: 1,
      reason: "Request enables documentation retrieval MCP (ref_tools)",
    });
    expect(ref.defaultDef()).toEqual({ command: "npx", args: ["-y", "ref-tools-mcp"] });
  });
});

// Locks the §3/§4c decision: the request `mcpServers` element schema is built
// from CLAUDE_MCP_SERVER_NAMES at registration time. This mirrors index.ts's
// `mcpServerEnum()` exactly — a full list yields a closed enum (rejects typos),
// an empty list (stripped public build) yields an open string (accepts arbitrary
// names). `z.enum([])` is illegal, which is why the empty case MUST branch to
// `z.string()` rather than an empty enum.
describe("mcpServers element schema (empty vs full registry)", () => {
  const elementSchema = (names: readonly string[]): z.ZodTypeAny =>
    names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string();

  it("full registry → closed enum that rejects unknown names", () => {
    const schema = z.array(elementSchema(CLAUDE_MCP_SERVER_NAMES)).default([]);
    expect(schema.parse(["sqry", "exa"])).toEqual(["sqry", "exa"]);
    expect(schema.parse(undefined)).toEqual([]);
    expect(() => schema.parse(["not_a_known_server"])).toThrow();
  });

  it("empty registry (stripped build) → open string that accepts arbitrary names", () => {
    const schema = z.array(elementSchema([])).default([]);
    // z.enum([]) would have thrown at construction; z.string() does not.
    expect(schema.parse(["anything", "at-all"])).toEqual(["anything", "at-all"]);
    expect(schema.parse(undefined)).toEqual([]);
    // Still an array of strings — non-string elements are rejected.
    expect(() => schema.parse([123])).toThrow();
  });
});
