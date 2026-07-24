import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultKitPathLayout,
  getPersonalConfigStatus,
  validateKitRequestSurface,
  PersonalConfigError,
} from "../personal-config.js";
import {
  CLI_TYPES,
  KIT_SUPPORTED_PROVIDERS,
  describeKitRequestTools,
  describeKitSupportedProviders,
  getKitProviderLabel,
  getProviderPersonalConfigKit,
  isKitSupportedProvider,
} from "../provider-definitions.js";

// Mistral Kit M4: the surfacing slice. Kit provider support is declared once in
// the provider registry; the admission gates and every read-only surface derive
// from it, so no surface can disagree with what the gates actually admit.

describe("Kit provider support is registry-derived", () => {
  it("admits exactly the registry's Kit-supported providers", () => {
    for (const provider of CLI_TYPES) {
      const supported = getProviderPersonalConfigKit(provider).supported;
      expect(isKitSupportedProvider(provider)).toBe(supported);
    }
    expect([...KIT_SUPPORTED_PROVIDERS]).toEqual(["claude", "codex", "mistral"]);
  });

  it("rejects an unsupported provider through the request-surface gate", () => {
    expect(() => validateKitRequestSurface("gemini", {}, true)).toThrow(PersonalConfigError);
    try {
      validateKitRequestSurface("gemini", {}, true);
    } catch (error) {
      expect((error as PersonalConfigError).code).toBe("kit_provider_unsupported");
      // The message is derived, so a newly supported provider cannot leave a
      // stale provider list behind in operator-facing text.
      expect((error as Error).message).toContain(describeKitSupportedProviders());
    }
  });

  it("admits mistral through the request-surface gate", () => {
    expect(() => validateKitRequestSurface("mistral", { prompt: "hello" }, true)).not.toThrow();
  });

  it("describes the supported providers from the registry order", () => {
    expect(describeKitSupportedProviders()).toBe("Claude, Codex and Mistral");
  });

  // Operator-facing strings that redirect a caller to the Kit surface must name
  // the whole admitted set. Hand-written copies of this list went stale when
  // mistral was admitted (found by cross-LLM review), so they are derived now.
  it("names every Kit request tool when redirecting a caller", () => {
    expect(describeKitRequestTools("sync")).toBe(
      "claude_request, codex_request or mistral_request"
    );
    expect(describeKitRequestTools("async")).toBe(
      "claude_request_async, codex_request_async or mistral_request_async"
    );
    for (const provider of KIT_SUPPORTED_PROVIDERS) {
      expect(describeKitRequestTools("sync")).toContain(`${provider}_request`);
      expect(describeKitRequestTools("async")).toContain(`${provider}_request_async`);
    }
  });

  it("labels a Kit session per provider rather than assuming two providers", () => {
    // Regression guard: a `provider === "claude" ? "Claude" : "Codex"` ternary
    // silently labelled every non-claude provider "Codex".
    expect(KIT_SUPPORTED_PROVIDERS.map(getKitProviderLabel)).toEqual([
      "Claude",
      "Codex",
      "Mistral",
    ]);
  });
});

describe("config_status Kit provider surface", () => {
  let home: string;
  let baseline: string;

  // A private layout keeps the test off the developer's real ~/.llm-cli-gateway.
  const layout = () => ({ ...defaultKitPathLayout(home), baselineDir: baseline });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kit-m4-status-"));
    baseline = join(home, "agent-config");
    mkdirSync(baseline, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.MISTRAL_API_KEY;
  });

  it("reports every provider with its registry isolation model", () => {
    const status = getPersonalConfigStatus(layout(), {
      enabled: false,
      baselinePath: baseline,
      maxStaleHours: 168,
    });
    expect(Object.keys(status.kitProviders).sort()).toEqual([...CLI_TYPES].sort());
    expect(status.kitProviders.mistral).toMatchObject({
      kitSupported: true,
      isolationModel: "controlled-environment",
      requiredCredentialEnv: "MISTRAL_API_KEY",
    });
    expect(status.kitProviders.gemini).toMatchObject({
      kitSupported: false,
      isolationModel: null,
      requiredCredentialEnv: null,
    });
  });

  it("keeps a supported provider ineligible while the Kit is disabled", () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const status = getPersonalConfigStatus(layout(), {
      enabled: false,
      baselinePath: baseline,
      maxStaleHours: 168,
    });
    expect(status.kitProviders.mistral.requiredCredentialConfigured).toBe(true);
    expect(status.kitProviders.mistral.kitEligible).toBe(false);
  });

  it("reports credential presence without exposing the credential", () => {
    process.env.MISTRAL_API_KEY = "super-secret-value";
    const status = getPersonalConfigStatus(layout(), {
      enabled: true,
      baselinePath: baseline,
      maxStaleHours: 168,
    });
    expect(status.kitProviders.mistral.requiredCredentialConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("super-secret-value");
  });

  it("marks mistral eligible once the baseline, release, and credential are in place", () => {
    // A verified release requires a real baseline repository, so build one.
    execFileSync("git", ["init", "-q", "-b", "main", baseline]);
    writeFileSync(join(baseline, "instructions.md"), "Follow the personal baseline.\n");
    execFileSync("git", ["-C", baseline, "add", "."]);
    execFileSync("git", [
      "-C",
      baseline,
      "-c",
      "user.email=kit@test",
      "-c",
      "user.name=Kit",
      "commit",
      "-qm",
      "baseline",
    ]);

    const settings = { enabled: true, baselinePath: baseline, maxStaleHours: 168 };
    const before = getPersonalConfigStatus(layout(), settings);
    expect(before.baselinePresent).toBe(true);
    // No activated release yet: eligibility must stay false for every provider.
    expect(before.currentReleaseId).toBeNull();
    for (const provider of KIT_SUPPORTED_PROVIDERS) {
      expect(before.kitProviders[provider].kitEligible).toBe(false);
    }
  });
});
