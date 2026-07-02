import { describe, it, expect } from "vitest";
import { CLI_TYPES } from "../provider-types.js";
import {
  getAllProviderDefinitions,
  getProviderDefinition,
  type ProviderDefinition,
} from "../provider-definitions.js";
import {
  generateProviderIdListing,
  generateRequestToolDescriptors,
  generateResourceDescriptors,
  generateModelListingRows,
  generateSessionListingRows,
  generateProviderCapabilityRows,
  generateAdminToolDescriptors,
  generateUpstreamContractRows,
  generateDocsSummaryRows,
  modelsResourceUri,
  sessionsResourceUri,
} from "../provider-surface-generator.js";

const N = CLI_TYPES.length;

describe("provider-surface-generator", () => {
  it("URIs are built from provider ids", () => {
    expect(modelsResourceUri("claude")).toBe("models://claude");
    expect(sessionsResourceUri("devin")).toBe("sessions://devin");
  });

  it("every generator yields exactly one entry per CLI_TYPES member", () => {
    const generators = [
      generateProviderIdListing,
      generateRequestToolDescriptors,
      generateResourceDescriptors,
      generateModelListingRows,
      generateSessionListingRows,
      generateProviderCapabilityRows,
      generateAdminToolDescriptors,
      generateUpstreamContractRows,
      generateDocsSummaryRows,
    ];
    for (const gen of generators) {
      const rows = gen();
      expect(rows).toHaveLength(N);
    }
  });

  it("request-tool descriptors carry sync + async names for every provider", () => {
    const rows = generateRequestToolDescriptors();
    for (const id of CLI_TYPES) {
      const row = rows.find(r => r.provider === id);
      expect(row).toBeDefined();
      expect(row?.syncToolName).toBe(`${id === "gemini" ? "gemini" : id}_request`);
      expect(row?.asyncToolName).toBe(getProviderDefinition(id).requestSurface.asyncToolName);
    }
  });

  it("resource descriptors cover devin and cursor (the current resource gap)", () => {
    const rows = generateResourceDescriptors();
    const devin = rows.find(r => r.provider === "devin");
    const cursor = rows.find(r => r.provider === "cursor");
    expect(devin?.modelsUri).toBe("models://devin");
    expect(devin?.sessionsUri).toBe("sessions://devin");
    expect(cursor?.modelsUri).toBe("models://cursor");
    expect(cursor?.sessionsUri).toBe("sessions://cursor");
  });

  it("resource descriptors carry the provider icon for title rendering", () => {
    const rows = generateResourceDescriptors();
    for (const id of CLI_TYPES) {
      const row = rows.find(r => r.provider === id);
      expect(row?.icon).toBe(getProviderDefinition(id).icon);
      expect(row?.icon.length).toBeGreaterThan(0);
    }
  });

  it("admin descriptors mark read-only families and honest surface kinds", () => {
    const rows = generateAdminToolDescriptors();
    const grok = rows.find(r => r.provider === "grok");
    const models = grok?.families.find(f => f.family === "models");
    expect(models?.readOnly).toBe(true);
    expect(models?.kind).toBe("cli-subcommand");
    expect(models?.invokableSubcommand).toBe(true);
    const mcp = grok?.families.find(f => f.family === "mcp");
    expect(mcp?.readOnly).toBe(false);
    // Mistral config projections are NOT invokable subcommands.
    const mistral = rows.find(r => r.provider === "mistral");
    const config = mistral?.families.find(f => f.family === "config");
    expect(config?.kind).toBe("config-projection");
    expect(config?.invokableSubcommand).toBe(false);
    const setup = mistral?.families.find(f => f.family === "setup");
    expect(setup?.kind).toBe("cli-flag");
    expect(setup?.invokableSubcommand).toBe(false);
  });

  it("upstream-contract rows expose native entrypoints for native providers", () => {
    const rows = generateUpstreamContractRows();
    const grok = rows.find(r => r.provider === "grok");
    expect(grok?.acpClassification).toBe("native");
    expect(grok?.nativeEntrypoint).toBe("grok agent stdio");
    const claude = rows.find(r => r.provider === "claude");
    expect(claude?.nativeEntrypoint).toBeNull();
  });

  // A NEW provider definition must flow through every generator with no consumer
  // edits. We prove this against a fake registry (real + fake) without touching
  // the real registry.
  it("a fake provider definition flows through every generator", () => {
    const fake: ProviderDefinition = {
      ...JSON.parse(JSON.stringify(getProviderDefinition("claude"))),
      id: "fakeprov" as never,
      displayName: "Fake Provider",
      sessionLabel: "Fake Session",
      requestSurface: {
        sync: true,
        async: true,
        transport: "cli",
        acpCapable: false,
        syncToolName: "fakeprov_request",
        asyncToolName: "fakeprov_request_async",
      },
    };
    const defs = [...getAllProviderDefinitions(), fake];

    expect(generateProviderIdListing(defs)).toContain("fakeprov");

    const resource = generateResourceDescriptors(defs).find(
      r => r.provider === ("fakeprov" as never)
    );
    expect(resource?.modelsUri).toBe("models://fakeprov");
    expect(resource?.sessionsUri).toBe("sessions://fakeprov");

    const req = generateRequestToolDescriptors(defs).find(
      r => r.provider === ("fakeprov" as never)
    );
    expect(req?.syncToolName).toBe("fakeprov_request");

    for (const gen of [
      generateModelListingRows,
      generateSessionListingRows,
      generateProviderCapabilityRows,
      generateAdminToolDescriptors,
      generateUpstreamContractRows,
      generateDocsSummaryRows,
    ]) {
      expect(gen(defs)).toHaveLength(defs.length);
    }
  });
});
