import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  createMistralKitIsolationPlan,
  assertMistralKitIsolationManifest,
  isIssuedMistralKitIsolationPlan,
  MistralKitIsolationError,
  MISTRAL_KIT_ENV_SCRUB,
  type MistralKitIsolationPlan,
} from "../mistral-kit-isolation.js";

// Mistral Kit M1: the controlled-environment isolation module. Dormant groundwork (no live
// handler calls it until M3). These pin the constructed plan + the fail-closed manifest.
// The host smoke test (redirected VIBE_HOME => untrusted cwd => project AGENTS.md ignored)
// is verified out-of-band on real vibe; enumeration:
// docs/plans/mistral-kit-vibe-isolation-enumeration.md.

const API_KEY = "test-mistral-api-key";
const CONTEXT = "<gateway-personal-config stamp=abc digest=def>baseline</...>";

describe("createMistralKitIsolationPlan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m1-iso-root-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function build(): MistralKitIsolationPlan {
    return createMistralKitIsolationPlan({
      cwd: "/srv/some/scope",
      contextPrefix: CONTEXT,
      apiKey: API_KEY,
      homeRoot: root,
    });
  }

  it("constructs a gateway-owned home with only .vibe/config.toml", () => {
    const plan = build();
    expect(existsSync(join(plan.home, ".vibe", "config.toml"))).toBe(true);
    expect(existsSync(join(plan.home, ".agents"))).toBe(false);
    // config.toml carries the match-nothing skill allowlist + session logging on.
    const cfg = readFileSync(join(plan.vibeHome, "config.toml"), "utf-8");
    expect(cfg).toContain("__gateway_kit_no_skills__");
    expect(cfg).toContain("[session_logging]");
    expect(cfg).toContain("enabled = true");
    expect(isIssuedMistralKitIsolationPlan(plan)).toBe(true);
  });

  it("env fragment carries the full redirect + hardening lever set", () => {
    const plan = build();
    expect(plan.env.HOME).toBe(plan.home);
    expect(plan.env.VIBE_HOME).toBe(plan.vibeHome);
    expect(plan.env.MISTRAL_API_KEY).toBe(API_KEY);
    expect(plan.env.VIBE_TEST_DISABLE_KEYRING).toBe("1");
    expect(plan.env.VIBE_INCLUDE_PROJECT_CONTEXT).toBe("false");
    expect(plan.env.VIBE_INCLUDE_PROMPT_DETAIL).toBe("false");
    expect(plan.env.VIBE_EXPERIMENTAL_ENABLE_REGISTRY_SKILLS).toBe("false");
    expect(plan.env.VIBE_ACP_LOGGING_ENABLED).toBe("false");
    // No --trust in the gateway args (the cwd must stay untrusted).
    expect(plan.args).not.toContain("--trust");
  });

  it("scrubKeys are the bare-name env vars the VIBE_* lever cannot cover", () => {
    const plan = build();
    expect(plan.scrubKeys).toEqual(MISTRAL_KIT_ENV_SCRUB);
    expect(plan.scrubKeys).toContain("SAVE_DIR");
    expect(plan.scrubKeys).toContain("ENABLED");
    expect(plan.scrubKeys).toContain("SESSION_PREFIX");
  });

  it("binds the context prefix digest (sha256)", () => {
    const plan = build();
    expect(plan.contextPrefixDigest).toBe(createHash("sha256").update(CONTEXT).digest("hex"));
  });

  it("fails closed on an empty api key", () => {
    expect(() =>
      createMistralKitIsolationPlan({
        cwd: "/x",
        contextPrefix: CONTEXT,
        apiKey: "",
        homeRoot: root,
      })
    ).toThrow(MistralKitIsolationError);
    expect(() =>
      createMistralKitIsolationPlan({
        cwd: "/x",
        contextPrefix: CONTEXT,
        apiKey: "  ",
        homeRoot: root,
      })
    ).toThrow(/MISTRAL_API_KEY/);
  });
});

describe("assertMistralKitIsolationManifest (fail-closed)", () => {
  let root: string;
  let plan: MistralKitIsolationPlan;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m1-iso-assert-"));
    plan = createMistralKitIsolationPlan({
      cwd: "/x",
      contextPrefix: CONTEXT,
      apiKey: API_KEY,
      homeRoot: root,
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes for a freshly-built plan", () => {
    expect(() => assertMistralKitIsolationManifest(plan)).not.toThrow();
  });

  it("throws when an ambient surface (~/.agents) leaks into the home", () => {
    mkdirSync(join(plan.home, ".agents", "skills"), { recursive: true });
    expect(() => assertMistralKitIsolationManifest(plan)).toThrow(/leaked an ambient surface/);
  });

  it("throws when an unexpected top-level entry appears", () => {
    writeFileSync(join(plan.home, "stray.txt"), "x");
    expect(() => assertMistralKitIsolationManifest(plan)).toThrow(/unexpected entries/);
  });

  it("throws when a required manifest file is missing", () => {
    rmSync(join(plan.vibeHome, "config.toml"));
    expect(() => assertMistralKitIsolationManifest(plan)).toThrow(/missing required file/);
  });

  it("throws when the env redirect does not match the constructed home", () => {
    const tampered = { ...plan, env: { ...plan.env, HOME: "/somewhere/else" } };
    expect(() => assertMistralKitIsolationManifest(tampered)).toThrow(/do not match/);
  });

  it("throws when a lever is missing from the env fragment", () => {
    const noKeyring = { ...plan };
    const env = { ...plan.env };
    delete (env as Record<string, string>).VIBE_TEST_DISABLE_KEYRING;
    expect(() => assertMistralKitIsolationManifest({ ...noKeyring, env })).toThrow(/missing lever/);
  });
});

describe("isIssuedMistralKitIsolationPlan", () => {
  it("rejects a structurally-convincing forged plan", () => {
    const forged: MistralKitIsolationPlan = {
      home: "/x",
      vibeHome: "/x/.vibe",
      cwd: "/x",
      env: { HOME: "/x", VIBE_HOME: "/x/.vibe", MISTRAL_API_KEY: "k" },
      scrubKeys: MISTRAL_KIT_ENV_SCRUB,
      args: [],
      contextPrefixDigest: "deadbeef",
    };
    expect(isIssuedMistralKitIsolationPlan(forged)).toBe(false);
  });
});
