import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CLI_TYPES } from "../session-manager.js";
import { UPSTREAM_CLI_CONTRACTS, buildUpstreamContractReport } from "../upstream-contracts.js";

// The TOML lives at docs/upstream/provider-sources.dag.toml. It is scanner
// input ONLY — these tests pin the synchronisation contract documented in
// docs/upstream/README.md: the TypeScript CliContract metadata is
// authoritative, the TOML mirrors `source_urls` / `watch_categories`, and the
// two must never drift. The TOML is never consulted for mechanical contract
// enforcement.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOML_PATH = join(REPO_ROOT, "docs", "upstream", "provider-sources.dag.toml");

interface TomlProviderBlock {
  cli: string;
  source_urls: string[];
  watch_categories: string[];
}

function loadToml(): {
  meta: { providers: string[] };
  providers: Record<string, TomlProviderBlock>;
} {
  return parseToml(readFileSync(TOML_PATH, "utf8")) as never;
}

describe("upstream provider sources (scanner input)", () => {
  it("every canonical CliType has upstreamMetadata in the TS contract", () => {
    for (const cli of CLI_TYPES) {
      const meta = UPSTREAM_CLI_CONTRACTS[cli].upstreamMetadata;
      expect(meta, `${cli} upstreamMetadata`).toBeDefined();
      expect(meta?.sourceUrls.length, `${cli} sourceUrls`).toBeGreaterThan(0);
      expect(meta?.watchCategories.length, `${cli} watchCategories`).toBeGreaterThan(0);
    }
  });

  it("keys providers in the TOML by canonical CliType only", () => {
    const toml = loadToml();
    expect(new Set(toml.meta.providers)).toEqual(new Set(CLI_TYPES));
    expect(new Set(Object.keys(toml.providers))).toEqual(new Set(CLI_TYPES));
    for (const cli of CLI_TYPES) {
      expect(toml.providers[cli].cli, `${cli} block self-key`).toBe(cli);
    }
  });

  it("keeps TOML source_urls + watch_categories byte-for-byte in sync with the TS metadata", () => {
    const toml = loadToml();
    for (const cli of CLI_TYPES) {
      const meta = UPSTREAM_CLI_CONTRACTS[cli].upstreamMetadata;
      const block = toml.providers[cli];
      expect(block.source_urls, `${cli} source_urls`).toEqual([...(meta?.sourceUrls ?? [])]);
      expect(block.watch_categories, `${cli} watch_categories`).toEqual([
        ...(meta?.watchCategories ?? []),
      ]);
    }
  });

  it("does NOT re-encode mechanical contract surfaces in the metadata", () => {
    // Guard the non-duplication invariant: upstreamMetadata is descriptive
    // pointers only. It must not grow flag/output/session/permission rules —
    // those stay in the CliContract proper (flags/env/resume* fields).
    const allowedKeys = new Set([
      "sourceUrls",
      "packageName",
      "repo",
      "installDocsUrl",
      "releaseChannel",
      "watchCategories",
    ]);
    for (const cli of CLI_TYPES) {
      const meta = UPSTREAM_CLI_CONTRACTS[cli].upstreamMetadata ?? {};
      for (const key of Object.keys(meta)) {
        expect(allowedKeys.has(key), `${cli} metadata key "${key}" is metadata-only`).toBe(true);
      }
    }
  });

  it("enriches the contract report with the metadata (single source of truth)", () => {
    const report = buildUpstreamContractReport({ cli: "claude" }) as {
      contracts: Record<string, { upstreamMetadata: { sourceUrls: string[] } | null }>;
    };
    expect(report.contracts.claude.upstreamMetadata?.sourceUrls).toEqual([
      ...UPSTREAM_CLI_CONTRACTS.claude.upstreamMetadata!.sourceUrls,
    ]);
  });
});
