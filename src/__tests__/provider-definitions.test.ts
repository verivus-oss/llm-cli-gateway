import { describe, it, expect } from "vitest";
import { CLI_TYPES, type CliType } from "../provider-types.js";
import {
  adminSurfaceKind,
  getAllProviderDefinitions,
  getProviderDefinition,
  listProviderIds,
  getProviderDisplayName,
  getProviderSessionLabel,
} from "../provider-definitions.js";
import { getAcpProviderRegistry, providerHasNativeAcp } from "../acp/provider-registry.js";
import { ACP_ENTRYPOINT_CONTRACTS, UPSTREAM_CLI_CONTRACTS } from "../upstream-contracts.js";

describe("provider-definitions registry", () => {
  it("has exactly one definition per CLI_TYPES member with a matching id", () => {
    expect(listProviderIds()).toEqual(CLI_TYPES);
    const defs = getAllProviderDefinitions();
    expect(defs).toHaveLength(CLI_TYPES.length);
    for (const id of CLI_TYPES) {
      expect(getProviderDefinition(id).id).toBe(id);
    }
    // No extra definitions and no duplicates.
    const ids = defs.map(d => d.id).sort();
    expect(ids).toEqual([...CLI_TYPES].sort());
  });

  it("carries every required field group for each provider", () => {
    for (const def of getAllProviderDefinitions()) {
      expect(def.displayName.length).toBeGreaterThan(0);
      // Every provider carries a non-empty emoji icon for its resource titles.
      expect(def.icon.length).toBeGreaterThan(0);
      expect(def.executables.length).toBeGreaterThan(0);
      expect(def.primaryExecutable).toBe(def.executables[0]);
      // request transport
      expect(def.requestSurface.transport).toBe("cli");
      expect(def.requestSurface.sync).toBe(true);
      expect(def.requestSurface.async).toBe(true);
      // docs
      expect(def.docs.primary.length).toBeGreaterThan(0);
      // model discovery
      expect(def.discovery.modelDiscovery.strategy.length).toBeGreaterThan(0);
      expect(def.discovery.modelDiscovery.evidence.length).toBeGreaterThan(0);
      // session discovery
      expect(def.discovery.sessionContinuity.flags.length).toBeGreaterThan(0);
      // admin subcommands
      expect(Array.isArray(def.adminSubcommands)).toBe(true);
      // acp metadata
      expect(["native", "none"]).toContain(def.acp.classification);
      // safety policy
      expect(Array.isArray(def.safetyModes.flags)).toBe(true);
      // resource policy + upstream linkage
      expect(def.resourcePolicy.exposesModelsResource).toBe(true);
      expect(def.resourcePolicy.exposesSessionsResource).toBe(true);
      expect(def.upstreamContract.targetVersion.length).toBeGreaterThan(0);
    }
  });

  it("classifies native ACP providers with a live entrypoint and a distinct non-live probe", () => {
    for (const def of getAllProviderDefinitions()) {
      if (def.acp.classification === "native") {
        expect(def.acp.entrypoint).not.toBeNull();
        expect(def.acp.nativeEntrypoint).not.toBeNull();
        expect(def.acp.probeArgv.length).toBeGreaterThan(0);
        const liveArgs = (def.acp.entrypoint?.args ?? []).join(" ");
        for (const probe of def.acp.probeArgv) {
          expect(probe.join(" ")).not.toBe(liveArgs);
        }
      } else {
        // Non-native providers report NO native entrypoint (no adapter
        // masquerading as native).
        expect(def.acp.entrypoint).toBeNull();
        expect(def.acp.nativeEntrypoint).toBeNull();
      }
    }
  });

  it("reports the expected native/none split (grok, mistral, devin, cursor native)", () => {
    const native = getAllProviderDefinitions()
      .filter(d => d.acp.classification === "native")
      .map(d => d.id)
      .sort();
    expect(native).toEqual(["cursor", "devin", "grok", "mistral"]);
    for (const none of ["claude", "codex", "gemini"] as CliType[]) {
      expect(getProviderDefinition(none).acp.classification).toBe("none");
    }
  });

  // The registry must CONSOLIDATE existing data, not invent it. Cross-check
  // against the pre-existing scattered sources.
  it("agrees with acp/provider-registry on native-vs-none classification", () => {
    const acpRegistry = getAcpProviderRegistry();
    for (const id of CLI_TYPES) {
      const isNative = getProviderDefinition(id).acp.classification === "native";
      expect(isNative).toBe(providerHasNativeAcp(id));
      const entry = acpRegistry[id];
      if (isNative) {
        expect(getProviderDefinition(id).acp.entrypoint).toEqual({
          command: entry.entrypoint?.command,
          args: entry.entrypoint?.args,
        });
      }
    }
  });

  it("agrees with ACP_ENTRYPOINT_CONTRACTS native entrypoints", () => {
    for (const id of CLI_TYPES) {
      const def = getProviderDefinition(id);
      const contract = ACP_ENTRYPOINT_CONTRACTS[id];
      if (def.acp.classification === "native") {
        expect(contract.status).toBe("native");
        expect(def.acp.entrypoint?.command).toBe(contract.executable);
        expect(def.acp.entrypoint?.args ?? []).toEqual([...contract.entrypointArgs]);
      } else {
        expect(contract.status).not.toBe("native");
      }
    }
  });

  it("agrees with UPSTREAM_CLI_CONTRACTS on executable identity and request tool names", () => {
    for (const id of CLI_TYPES) {
      const def = getProviderDefinition(id);
      const contract = UPSTREAM_CLI_CONTRACTS[id];
      expect(def.primaryExecutable).toBe(contract.executable);
      expect(def.requestSurface.syncToolName).toBe(contract.mcpTools[0]);
      expect(def.requestSurface.asyncToolName).toBe(contract.mcpTools[1]);
    }
  });

  it("keeps cursor complete but marked maintain-only", () => {
    const cursor = getProviderDefinition("cursor");
    expect(cursor.capabilityScope).toBe("maintain-only");
    expect(cursor.acp.classification).toBe("native");
    expect(cursor.resourcePolicy.exposesModelsResource).toBe(true);
    expect(cursor.resourcePolicy.exposesSessionsResource).toBe(true);
    for (const id of CLI_TYPES) {
      if (id !== "cursor") expect(getProviderDefinition(id).capabilityScope).toBe("full");
    }
  });

  it("cursor safety + continuity match the grounded upstream-contracts cursor contract field-for-field", () => {
    const cursor = getProviderDefinition("cursor");
    const contract = UPSTREAM_CLI_CONTRACTS.cursor;
    // Safety flags all exist in the grounded contract's flag set; NO --permission-mode.
    for (const flag of cursor.safetyModes.flags) {
      expect(Object.keys(contract.flags)).toContain(flag);
    }
    expect(cursor.safetyModes.flags).not.toContain("--permission-mode");
    expect(Object.keys(contract.flags)).not.toContain("--permission-mode");
    // sandbox IS a real cursor control (enabled|disabled); trust is real.
    expect(cursor.safetyModes.sandbox).toBe(true);
    expect(contract.flags["--sandbox"].values).toEqual(["enabled", "disabled"]);
    expect(cursor.safetyModes.permissionMode).toBe(false);
    expect(cursor.safetyModes.trust).toBe(true);
    // Continuity: both --resume and --continue, matching the contract.
    expect([...cursor.discovery.sessionContinuity.flags].sort()).toEqual([
      "--continue",
      "--resume",
    ]);
    expect(Object.keys(contract.flags)).toEqual(expect.arrayContaining(["--resume", "--continue"]));
    // Now-captured cursor help wired as the checksum ref (no longer null).
    expect(cursor.upstreamContract.helpChecksumRef).toBe("cursor-agent--help.txt");
  });

  it("mistral admin families are grounded honestly against vibe --help", () => {
    const mistral = getProviderDefinition("mistral");
    const byFamily = Object.fromEntries(mistral.adminSubcommands.map(f => [f.family, f]));
    // The only real vibe CLI admin surface is two FLAGS.
    expect(adminSurfaceKind(byFamily.setup)).toBe("cli-flag");
    expect(adminSurfaceKind(byFamily["check-upgrade"])).toBe("cli-flag");
    // --check-upgrade prompts to install an update: mutating, not read-only.
    expect(byFamily["check-upgrade"].safety).toBe("mutating-gated");
    // config/mcp/skills/agents are read-only config PROJECTIONS, never claimed as
    // invokable `vibe <cmd>` subcommands (vibe --help advertises no subcommands).
    for (const fam of ["config", "mcp", "skills", "agents"]) {
      expect(adminSurfaceKind(byFamily[fam])).toBe("config-projection");
      expect(byFamily[fam].safety).toBe("read-only");
    }
    // No mistral admin family is a cli-subcommand (there are no vibe subcommands).
    for (const family of mistral.adminSubcommands) {
      expect(adminSurfaceKind(family)).not.toBe("cli-subcommand");
    }
  });

  it("exposes stable identity accessors", () => {
    expect(getProviderDisplayName("claude")).toBe("Anthropic Claude Code");
    expect(getProviderSessionLabel("claude")).toBe("Claude Session");
    expect(getProviderSessionLabel("cursor")).toBe("Cursor Session");
  });
});
