import { describe, expect, it } from "vitest";
import {
  getModelCost,
  API_CATALOG,
  API_CATALOG_AS_OF,
  type ApiCatalog,
  type ApiCatalogEntry,
} from "../pricing.js";

// Phase_2 DAG step api-catalog-pricing: API-provider models are priced from the
// published catalog (source "api-catalog"); prefer_catalog_price decides when a
// model resolves in both catalog and family table; absent-in-both => unknown.

describe("getModelCost api-catalog path", () => {
  it("prices a known OpenRouter model from the catalog (source api-catalog)", () => {
    const cost = getModelCost("openrouter", "openai/gpt-5.5");
    expect(cost.source).toBe("api-catalog");
    expect(cost.inputUsdPerMTok).toBe(1.25);
    expect(cost.outputUsdPerMTok).toBe(10);
    expect(cost.asOf).toBe(API_CATALOG_AS_OF);
  });

  it("prices an Anthropic-served OpenRouter model as disjoint", () => {
    const cost = getModelCost("openrouter", "anthropic/claude-sonnet-4.5");
    expect(cost.source).toBe("api-catalog");
    expect(cost.accountingMode).toBe("disjoint");
    expect(cost.family).toBe("claude-sonnet");
  });

  it("returns source 'unknown' for a model absent from BOTH catalog and table", () => {
    const cost = getModelCost("openrouter", "vendor/never-heard-of-it");
    expect(cost.source).toBe("unknown");
    expect(cost.inputUsdPerMTok).toBe(0);
  });

  it("prefers the catalog over the table by default when a model resolves in both", () => {
    // grok-4 is in both the family table (GROK_4) and the api-catalog.
    const cost = getModelCost("xai", "grok-4");
    expect(cost.source).toBe("api-catalog");
  });

  it("prefers the table when preferCatalog=false and both exist", () => {
    const cost = getModelCost("xai", "grok-4", { preferCatalog: false });
    expect(cost.source).toBe("table");
    expect(cost.family).toBe("grok-4");
  });

  it("falls back to the table when the model is only in the table (catalog miss)", () => {
    // A bare CLI alias like "sonnet" is not a catalog key.
    const cost = getModelCost("claude", "claude-sonnet-4-6");
    expect(cost.source).toBe("table");
    expect(cost.family).toBe("claude-sonnet");
  });

  it("accepts an injected fixture catalog", () => {
    const fixture: ApiCatalog = new Map<string, ApiCatalogEntry>([
      ["acme/fast", { inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.15, cacheReadMultiplier: 0 }],
    ]);
    const cost = getModelCost("acme", "acme/fast", { catalog: fixture });
    expect(cost.source).toBe("api-catalog");
    expect(cost.inputUsdPerMTok).toBe(0.05);
    // A model NOT in the fixture and not in the table is unknown.
    expect(getModelCost("acme", "acme/unknown", { catalog: fixture }).source).toBe("unknown");
  });

  it("ships a non-empty curated catalog", () => {
    expect(API_CATALOG.size).toBeGreaterThan(0);
    expect(API_CATALOG.has("openai/gpt-5.5")).toBe(true);
  });
});
