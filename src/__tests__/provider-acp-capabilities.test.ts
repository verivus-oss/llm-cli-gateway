import { describe, expect, it } from "vitest";

import {
  buildProviderAcpCapabilityRecord,
  deriveSupportedMethodsFromDiscovered,
} from "../provider-acp-capabilities.js";
import { parseAcpInitialize, type ParsedAcpInitialize } from "../provider-capability-discovery.js";
import type { AcpConfig } from "../config.js";

// Phase-5 Deliverable B: the provider-acp capability projection is DERIVED from
// provider-definitions + an (optional) discovered initialize capability set. The
// record for a native provider changes when the discovered set changes, WITHOUT
// any source edit (acceptance #6). Non-native providers report an explicit
// no-entrypoint record with zero adapter-as-native masquerade.

/** Build a discovered ParsedAcpInitialize from a JSON initialize response. */
function discovered(body: Record<string, unknown>): ParsedAcpInitialize {
  const parsed = parseAcpInitialize(JSON.stringify(body));
  if (parsed.kind !== "ok") throw new Error(`expected ok, got ${parsed.kind}`);
  return parsed.value;
}

function acpConfig(over: Partial<AcpConfig> = {}): AcpConfig {
  return {
    enabled: true,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: 600000,
    initializeTimeoutMs: 10000,
    sessionNewTimeoutMs: 10000,
    promptTimeoutMs: 600000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    allowMutatingSessionOps: false,
    fallbackToCliWhenUnhealthy: true,
    providers: {},
    sources: { configFile: null },
    ...over,
  };
}

describe("provider-acp-capabilities: native records", () => {
  it("sources the native entrypoint + probe from provider-definitions (grok)", () => {
    const record = buildProviderAcpCapabilityRecord("grok");
    expect(record.native).toBe(true);
    expect(record.nativeEntrypoint).toBe("grok agent stdio");
    expect(record.entrypoint).toEqual({ command: "grok", args: ["agent", "stdio"] });
    expect(record.probeArgv).toEqual([["agent", "stdio", "--help"]]);
  });

  it("degrades to static-fallback (baseline methods) when no discovered set is supplied", () => {
    const record = buildProviderAcpCapabilityRecord("mistral");
    expect(record.initialize?.source).toBe("static-fallback");
    expect(record.supportedSessionMethods).toEqual(
      ["session/cancel", "session/new", "session/prompt", "session/update"].sort()
    );
    // A static fallback never over-claims optional methods.
    expect(record.supportedSessionMethods).not.toContain("session/resume");
  });

  it("surfaces devin's --agent-type variants from the definition", () => {
    const record = buildProviderAcpCapabilityRecord("devin");
    expect(record.agentTypes.map(t => t.id)).toEqual(["summarizer", "review"]);
  });

  // Acceptance #6: the record content changes with the injected discovered set,
  // with NO source edit. The discovered fixtures use the SPEC shape (capabilities
  // nested under `agentCapabilities`, `authMethods` as objects), exactly what the
  // runtime negotiates. Mutations that flip this red: (a) making
  // buildProviderAcpCapabilityRecord ignore `options.discovered` and always
  // return the static fallback; (b) reverting parseAcpInitialize to read a
  // top-level `sessionCapabilities` shape (the nested agentCapabilities would be
  // ignored and session/resume/list/... would vanish).
  it("reprojects supported methods from an injected discovered set (no source edit)", () => {
    const before = buildProviderAcpCapabilityRecord("grok", {
      discovered: discovered({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }),
    });
    expect(before.initialize?.source).toBe("discovered");
    expect(before.supportedSessionMethods).toContain("session/resume");
    expect(before.supportedSessionMethods).not.toContain("session/list");

    const after = buildProviderAcpCapabilityRecord("grok", {
      discovered: discovered({
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {} },
        },
        authMethods: [{ id: "oauth" }],
      }),
    });
    expect(after.supportedSessionMethods).toContain("session/list");
    expect(after.supportedSessionMethods).toContain("session/close");
    expect(after.supportedSessionMethods).toContain("session/delete");
    expect(after.supportedSessionMethods).toContain("authenticate");
  });

  it("reflects the operator host-service gates from acpConfig (deny-by-default)", () => {
    const denied = buildProviderAcpCapabilityRecord("grok");
    expect(denied.hostServicePolicy.filesystemWriteAllowed).toBe(false);
    expect(denied.hostServicePolicy.terminalAllowed).toBe(false);
    expect(denied.hostServicePolicy.mutatingSessionOpsAllowed).toBe(false);
    expect(denied.hostServicePolicy.filesystemRead).toBe("deny-by-default");
    expect(denied.hostServicePolicy.unknownToolKind).toBe("deny-by-default");
    expect(denied.hostServicePolicy.permissionRouting).toBe("approval-manager");

    const allowed = buildProviderAcpCapabilityRecord("grok", {
      acpConfig: acpConfig({
        allowWriteHostServices: true,
        allowTerminalHostServices: true,
        allowMutatingSessionOps: true,
      }),
    });
    expect(allowed.hostServicePolicy.filesystemWriteAllowed).toBe(true);
    expect(allowed.hostServicePolicy.terminalAllowed).toBe(true);
    expect(allowed.hostServicePolicy.mutatingSessionOpsAllowed).toBe(true);
  });

  it("redacts a local path smuggled into discovered agentInfo", () => {
    const record = buildProviderAcpCapabilityRecord("grok", {
      discovered: discovered({
        protocolVersion: 1,
        agentInfo: { name: "grok /home/werner/.grok/leader.sock", version: "0.2.77" },
      }),
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("/home/werner");
  });
});

describe("provider-acp-capabilities: non-native (anti-masquerade)", () => {
  for (const provider of ["claude", "codex", "gemini"] as const) {
    it(`reports ${provider} as non-native with no entrypoint and no methods`, () => {
      const record = buildProviderAcpCapabilityRecord(provider);
      expect(record.native).toBe(false);
      expect(record.nativeEntrypoint).toBeNull();
      expect(record.entrypoint).toBeNull();
      expect(record.supportedSessionMethods).toEqual([]);
      expect(record.initialize).toBeNull();
      expect(record.agentTypes).toEqual([]);
    });
  }
});

describe("deriveSupportedMethodsFromDiscovered: pure", () => {
  it("always includes the baseline methods", () => {
    const methods = deriveSupportedMethodsFromDiscovered(discovered({ protocolVersion: 1 }));
    for (const m of ["session/new", "session/prompt", "session/cancel", "session/update"]) {
      expect(methods).toContain(m);
    }
  });

  it("maps session capabilities and authMethods to methods (spec-nested shape)", () => {
    const methods = deriveSupportedMethodsFromDiscovered(
      discovered({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {} },
        },
        authMethods: [{ id: "oauth" }],
      })
    );
    expect(methods).toEqual(
      expect.arrayContaining([
        "session/resume",
        "session/list",
        "session/close",
        "session/delete",
        "session/load",
        "authenticate",
      ])
    );
  });
});
