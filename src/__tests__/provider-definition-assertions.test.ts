import { describe, it, expect } from "vitest";
import { CLI_TYPES } from "../provider-types.js";
import {
  getAllProviderDefinitions,
  getProviderDefinition,
  type ProviderDefinition,
} from "../provider-definitions.js";
import {
  assertNever,
  assertExhaustiveProviderCoverage,
  assertProviderProjectionsProducible,
  assertRegistryIntegrity,
  providerScopeLabel,
  REQUIRED_PROVIDER_PROJECTIONS,
} from "../provider-definition-assertions.js";

/** A deep-ish clone that lets a test mutate a definition to simulate a bare add. */
function cloneDef(def: ProviderDefinition): ProviderDefinition {
  return JSON.parse(JSON.stringify(def)) as ProviderDefinition;
}

describe("provider-definition assertions", () => {
  it("passes integrity for the real registry", () => {
    expect(() => assertRegistryIntegrity()).not.toThrow();
    expect(() => assertExhaustiveProviderCoverage()).not.toThrow();
  });

  it("produces every required projection for every real definition", () => {
    for (const def of getAllProviderDefinitions()) {
      const producible = assertProviderProjectionsProducible(def);
      for (const projection of REQUIRED_PROVIDER_PROJECTIONS) {
        expect(producible.has(projection)).toBe(true);
      }
    }
  });

  it("providerScopeLabel is exhaustive over CLI_TYPES", () => {
    for (const id of CLI_TYPES) {
      const label = providerScopeLabel(id);
      expect(label).toBe(getProviderDefinition(id).capabilityScope);
    }
  });

  it("fails coverage when a provider is MISSING from the registry", () => {
    const partial = getAllProviderDefinitions().filter(d => d.id !== "devin");
    expect(() => assertExhaustiveProviderCoverage(partial)).toThrow(/missing.*devin/i);
  });

  it("fails coverage on a DUPLICATE definition", () => {
    const defs = getAllProviderDefinitions();
    const dup = [...defs, getProviderDefinition("claude")];
    expect(() => assertExhaustiveProviderCoverage(dup)).toThrow(/duplicate/i);
  });

  it("fails coverage on an EXTRA definition not in CLI_TYPES", () => {
    const fake = {
      ...cloneDef(getProviderDefinition("claude")),
      id: "fakeprov",
    } as unknown as ProviderDefinition;
    expect(() => assertExhaustiveProviderCoverage([...getAllProviderDefinitions(), fake])).toThrow(
      /not in CLI_TYPES/i
    );
  });

  it("fails when a provider is added BARE (missing request tool names)", () => {
    const bare = cloneDef(getProviderDefinition("claude"));
    (bare.requestSurface as { syncToolName: string }).syncToolName = "";
    expect(() => assertProviderProjectionsProducible(bare)).toThrow(/syncRequestTool/);
  });

  it("fails a bare provider missing resource policy", () => {
    const bare = cloneDef(getProviderDefinition("codex"));
    (bare.resourcePolicy as { exposesModelsResource: boolean }).exposesModelsResource = false;
    expect(() => assertProviderProjectionsProducible(bare)).toThrow(/modelsResource/);
  });

  it("fails a bare provider missing docs", () => {
    const bare = cloneDef(getProviderDefinition("grok"));
    (bare.docs as { primary: string[] }).primary = [];
    expect(() => assertProviderProjectionsProducible(bare)).toThrow(/docsSummary/);
  });

  it("fails a native ACP provider whose probe argv equals the live entrypoint", () => {
    const bad = cloneDef(getProviderDefinition("grok"));
    (bad.acp as { probeArgv: string[][] }).probeArgv = [["agent", "stdio"]];
    expect(() => assertProviderProjectionsProducible(bad)).toThrow(/probe argv must differ/);
  });

  it("fails a non-native provider that carries an entrypoint (adapter masquerade)", () => {
    const bad = cloneDef(getProviderDefinition("claude"));
    (bad.acp as { entrypoint: unknown }).entrypoint = { command: "claude", args: ["acp"] };
    expect(() => assertProviderProjectionsProducible(bad)).toThrow(/null entrypoint/);
  });

  it("assertNever throws at runtime", () => {
    expect(() => assertNever("x" as never, "test")).toThrow(/Unhandled test/);
  });
});
