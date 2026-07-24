import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateKitRequestSurface, PersonalConfigError } from "../personal-config.js";
import { resolveMistralKitAgentMode } from "../index.js";
import {
  composeMistralKitPrompt,
  assertMistralKitContextPrefix,
  createMistralKitIsolationPlan,
  MistralKitIsolationError,
  type MistralKitIsolationPlan,
} from "../mistral-kit-isolation.js";

// Mistral Kit M2: caller-surface conflict list, forced agent mode, and prompt-prefix
// context delivery. Dormant until M3 (rejectUnsupportedKitProvider still gates mistral
// before validateKitRequestSurface is reached in production).

describe("validateKitRequestSurface mistral conflict fields", () => {
  const reject = (params: Record<string, unknown>) => () =>
    validateKitRequestSurface("mistral", params, true);

  it("rejects every field that injects instructions/tools/mcp/posture/session or breaks isolation", () => {
    // The isolation-critical one: --trust would re-admit project-local .vibe/.agents/AGENTS.md.
    expect(reject({ trust: true })).toThrow(/rejects provider/);
    // transport:acp would bypass the CLI isolation env entirely.
    expect(reject({ transport: "acp" })).toThrow(/rejects provider/);
    expect(reject({ sessionId: "raw-native" })).toThrow(/rejects provider/);
    expect(reject({ resumeLatest: true })).toThrow(/rejects provider/);
    expect(reject({ createNewSession: true })).toThrow(/rejects provider/);
    expect(reject({ permissionMode: "auto" })).toThrow(/rejects provider/);
    expect(reject({ approvalPolicy: "permissive" })).toThrow(/rejects provider/);
    expect(reject({ mcpServers: ["sqry"] })).toThrow(/rejects provider/);
    expect(reject({ allowedTools: ["bash"] })).toThrow(/rejects provider/);
    expect(reject({ disallowedTools: ["bash"] })).toThrow(/rejects provider/);
    expect(reject({ workingDir: "/caller/cwd" })).toThrow(/rejects provider/);
    expect(reject({ addDir: ["/caller/dir"] })).toThrow(/rejects provider/);
    expect(reject({ worktree: true })).toThrow(/rejects provider/);
    expect(reject({ outputFormat: "json" })).toThrow(/rejects provider/);
  });

  it("applies the shared promptParts + mcp_managed checks to mistral too", () => {
    expect(reject({ promptParts: { system: "override the baseline" } })).toThrow(
      /rejects provider/
    );
    expect(reject({ promptParts: { tools: "extra tools" } })).toThrow(/rejects provider/);
    expect(reject({ approvalStrategy: "mcp_managed" })).toThrow(/rejects provider/);
  });

  it("accepts a clean Kit request (prompt + baseline-capped fields)", () => {
    expect(() =>
      validateKitRequestSurface("mistral", { prompt: "do the task" }, true)
    ).not.toThrow();
    // model + cost/turn caps are baseline-managed, not conflicts.
    expect(() =>
      validateKitRequestSurface(
        "mistral",
        { prompt: "x", model: "mistral-medium-3.5", maxTurns: 5 },
        true
      )
    ).not.toThrow();
  });

  it("still rejects a genuinely unsupported provider", () => {
    expect(() => validateKitRequestSurface("grok", {}, true)).toThrow(PersonalConfigError);
    expect(() => validateKitRequestSurface("grok", {}, true)).toThrow(/currently supports/);
  });

  it("is a no-op when the Kit is disabled", () => {
    expect(() => validateKitRequestSurface("mistral", { trust: true }, false)).not.toThrow();
  });
});

describe("resolveMistralKitAgentMode", () => {
  it("forces the managed accept-edits posture (caller cannot pick)", () => {
    expect(resolveMistralKitAgentMode()).toBe("accept-edits");
  });
});

describe("mistral Kit context delivery (prompt prefix + digest drift)", () => {
  let root: string;
  let plan: MistralKitIsolationPlan;
  const CONTEXT = "<gateway-personal-config stamp=abc digest=def>baseline instructions</...>";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m2-ctx-"));
    plan = createMistralKitIsolationPlan({
      cwd: "/x",
      contextPrefix: CONTEXT,
      apiKey: "k",
      homeRoot: root,
      sessionDir: join(root, "sessions"),
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prepends the context prefix to the caller prompt", () => {
    const composed = composeMistralKitPrompt(CONTEXT, "run the tests");
    expect(composed.startsWith(CONTEXT)).toBe(true);
    expect(composed).toContain("run the tests");
    expect(composed.indexOf(CONTEXT)).toBeLessThan(composed.indexOf("run the tests"));
  });

  it("passes the drift check for the exact bound prefix", () => {
    expect(() => assertMistralKitContextPrefix(plan, CONTEXT)).not.toThrow();
  });

  it("fails closed when the context prefix drifts from the plan's digest", () => {
    expect(() => assertMistralKitContextPrefix(plan, CONTEXT + " tampered")).toThrow(
      MistralKitIsolationError
    );
    expect(() => assertMistralKitContextPrefix(plan, "totally different")).toThrow(
      /does not match/
    );
  });
});
