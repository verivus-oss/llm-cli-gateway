import { describe, expect, it } from "vitest";
import {
  getAcpProviderEntry,
  getAcpProviderRegistry,
  getRuntimePilotProviders,
  providerHasNativeAcp,
  type AcpProviderStatus,
  type AcpSupportKind,
} from "../acp/provider-registry.js";
import { CLI_TYPES } from "../session-manager.js";

// Step: define-acp-provider-registry-and-errors.
// Validation clause: provider-registry tests assert exact status for Mistral,
// Grok, Codex, Claude, and Antigravity agy.

describe("acp provider registry", () => {
  it("covers exactly the gateway CLI providers", () => {
    const registry = getAcpProviderRegistry();
    expect(Object.keys(registry).sort()).toEqual([...CLI_TYPES].sort());
  });

  const expectedStatus: Record<string, AcpProviderStatus> = {
    mistral: "native_smoke_passed",
    grok: "native_smoke_passed",
    codex: "adapter_mediated_deferred",
    claude: "adapter_mediated_deferred",
    gemini: "absent_watchlist",
    devin: "native_smoke_passed",
    cursor: "native_smoke_passed",
  };

  const expectedSupportKind: Record<string, AcpSupportKind> = {
    mistral: "native",
    grok: "native",
    codex: "adapter_mediated",
    claude: "adapter_mediated",
    gemini: "none",
    devin: "native",
    cursor: "native",
  };

  for (const provider of CLI_TYPES) {
    it(`reports exact ACP status and support kind for ${provider}`, () => {
      const entry = getAcpProviderEntry(provider);
      expect(entry.provider).toBe(provider);
      expect(entry.status).toBe(expectedStatus[provider]);
      expect(entry.supportKind).toBe(expectedSupportKind[provider]);
    });
  }

  it("targets Antigravity agy 1.0.13 for gemini and keeps it on the watchlist with no entrypoint", () => {
    const gemini = getAcpProviderEntry("gemini");
    expect(gemini.displayName).toBe("Google Antigravity");
    expect(gemini.targetVersion).toBe("agy 1.0.13");
    expect(gemini.status).toBe("absent_watchlist");
    expect(gemini.supportKind).toBe("none");
    expect(gemini.entrypoint).toBeNull();
    expect(gemini.runtimeEnabledDefault).toBe(false);
    expect(gemini.shipRuntimePilot).toBe(false);
  });

  it("labels no adapter-mediated provider as native", () => {
    for (const provider of ["codex", "claude"] as const) {
      const entry = getAcpProviderEntry(provider);
      expect(entry.supportKind).toBe("adapter_mediated");
      expect(entry.status).toBe("adapter_mediated_deferred");
      expect(entry.entrypoint).toBeNull();
      expect(providerHasNativeAcp(provider)).toBe(false);
      expect(entry.adapterCandidates.length).toBeGreaterThan(0);
    }
  });

  it("stores native entrypoints as executable plus argv array, never a shell string", () => {
    const mistral = getAcpProviderEntry("mistral");
    expect(mistral.entrypoint).toEqual({ command: "vibe-acp", args: [] });

    const grok = getAcpProviderEntry("grok");
    expect(grok.entrypoint).toEqual({ command: "grok", args: ["agent", "stdio"] });

    const devin = getAcpProviderEntry("devin");
    expect(devin.entrypoint).toEqual({ command: "devin", args: ["acp"] });

    const cursor = getAcpProviderEntry("cursor");
    expect(cursor.entrypoint).toEqual({ command: "cursor-agent", args: ["acp"] });

    // Structural guarantee for no_shell_eval_for_entrypoints: args is an array,
    // and the command contains no shell metacharacters.
    for (const provider of ["mistral", "grok", "devin", "cursor"] as const) {
      const entrypoint = getAcpProviderEntry(provider).entrypoint;
      expect(entrypoint).not.toBeNull();
      expect(Array.isArray(entrypoint?.args)).toBe(true);
      expect(entrypoint?.command).not.toMatch(/[;&|`$<>()]/);
      for (const arg of entrypoint?.args ?? []) {
        expect(arg).not.toMatch(/[;&|`$<>()]/);
      }
    }
  });

  it("defaults every provider runtime gate to disabled", () => {
    for (const provider of CLI_TYPES) {
      expect(getAcpProviderEntry(provider).runtimeEnabledDefault).toBe(false);
    }
  });

  it("returns native runtime pilots in priority order (mistral, grok, devin, then cursor)", () => {
    expect(getRuntimePilotProviders()).toEqual(["mistral", "grok", "devin", "cursor"]);
  });

  it("identifies native ACP providers correctly", () => {
    expect(providerHasNativeAcp("mistral")).toBe(true);
    expect(providerHasNativeAcp("grok")).toBe(true);
    expect(providerHasNativeAcp("codex")).toBe(false);
    expect(providerHasNativeAcp("claude")).toBe(false);
    expect(providerHasNativeAcp("gemini")).toBe(false);
    expect(providerHasNativeAcp("cursor")).toBe(true);
  });

  it("freezes the registry so consumers cannot mutate metadata", () => {
    const registry = getAcpProviderRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.mistral)).toBe(true);
  });

  it("carries no secrets or local paths in caveat strings", () => {
    for (const provider of CLI_TYPES) {
      const caveat = getAcpProviderEntry(provider).caveat;
      expect(caveat).not.toMatch(/\/home\//);
      expect(caveat).not.toMatch(/~\//);
      expect(caveat).not.toMatch(/(sk|xai|gsk)-[A-Za-z0-9]{8,}/);
    }
  });
});
