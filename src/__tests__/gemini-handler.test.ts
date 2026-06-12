/**
 * U27: Gemini-compatible Antigravity high-impact features.
 *
 * Tests the schema additions on `gemini_request` / `gemini_request_async`:
 *   - sandbox → `--sandbox`
 *   - policyFiles/adminPolicyFiles/attachments are rejected because agy has
 *     no matching non-interactive flags
 *   - createNewSession=true → no session flag (NOT `--resume`)
 *   - createNewSession=false + sessionId → `--conversation <id>`
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  GEMINI_HIGH_IMPACT_PARAMS_SCHEMA,
  prependGeminiAttachments,
  prepareGeminiHighImpactFlags,
  resolveGeminiSessionPlan,
} from "../request-helpers.js";
import { prepareGeminiRequest } from "../index.js";

let tmp: string;
let realFile1: string;
let realFile2: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "u27-gemini-"));
  realFile1 = join(tmp, "policy-1.json");
  realFile2 = join(tmp, "policy-2.json");
  writeFileSync(realFile1, "{}", { mode: 0o600 });
  writeFileSync(realFile2, "{}", { mode: 0o600 });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseParams(extra: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "gemini_request",
    ...extra,
  };
}

describe("U27 prepareGeminiHighImpactFlags", () => {
  it("emits -s when sandbox=true", () => {
    const out = prepareGeminiHighImpactFlags({ sandbox: true });
    expect(out.args).toContain("-s");
    expect(out.missingPolicyPath).toBeNull();
  });

  it("omits -s when sandbox is false/undefined", () => {
    expect(prepareGeminiHighImpactFlags({}).args).not.toContain("-s");
    expect(prepareGeminiHighImpactFlags({ sandbox: false }).args).not.toContain("-s");
  });

  it("emits --policy <path> per file when paths exist", () => {
    const out = prepareGeminiHighImpactFlags({ policyFiles: [realFile1, realFile2] });
    expect(out.missingPolicyPath).toBeNull();
    expect(out.args).toEqual(["--policy", realFile1, "--policy", realFile2]);
  });

  it("returns missingPolicyPath when a policyFile does not exist", () => {
    const missing = join(tmp, "nope.json");
    const out = prepareGeminiHighImpactFlags({ policyFiles: [realFile1, missing] });
    expect(out.missingPolicyPath).toBe(missing);
    expect(out.missingPolicyField).toBe("policyFiles");
    expect(out.args).toEqual([]);
  });

  it("emits --admin-policy <path> per file when paths exist", () => {
    const out = prepareGeminiHighImpactFlags({ adminPolicyFiles: [realFile1] });
    expect(out.args).toEqual(["--admin-policy", realFile1]);
  });

  it("returns missingPolicyPath for missing admin policy", () => {
    const missing = join(tmp, "absent.json");
    const out = prepareGeminiHighImpactFlags({ adminPolicyFiles: [missing] });
    expect(out.missingPolicyPath).toBe(missing);
    expect(out.missingPolicyField).toBe("adminPolicyFiles");
  });
});

describe("U27 prependGeminiAttachments", () => {
  it("prepends @<abs-path> tokens space-separated before the prompt", () => {
    const result = prependGeminiAttachments("describe this", [realFile1, realFile2]);
    expect(result).toBe(`@${realFile1} @${realFile2} describe this`);
  });

  it("returns the prompt unchanged when attachments is empty", () => {
    expect(prependGeminiAttachments("hello", [])).toBe("hello");
  });

  it("throws on relative paths (caller should map to error response)", () => {
    expect(() => prependGeminiAttachments("p", ["./relative.png"])).toThrow(/absolute/);
  });

  it("throws on missing paths", () => {
    const missing = join(tmp, "missing.png");
    expect(() => prependGeminiAttachments("p", [missing])).toThrow(/does not exist/);
  });

  it("throws on paths that cannot be represented as Gemini @path tokens", () => {
    const pathWithSpace = join(tmp, "file with space.png");
    const pathWithAt = join(tmp, "file@name.png");
    writeFileSync(pathWithSpace, "image", { mode: 0o600 });
    writeFileSync(pathWithAt, "image", { mode: 0o600 });

    expect(() => prependGeminiAttachments("p", [pathWithSpace])).toThrow(/without escaping/);
    expect(() => prependGeminiAttachments("p", [pathWithAt])).toThrow(/without escaping/);
  });
});

describe("U27 GEMINI_HIGH_IMPACT_PARAMS_SCHEMA", () => {
  it("rejects relative attachment paths at Zod validation", () => {
    const parsed = GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
      attachments: ["./rel.png"],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/absolute/);
    }
  });

  it("accepts absolute attachment paths at Zod validation", () => {
    const parsed = GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
      attachments: ["/abs/path.png"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("U27 resolveGeminiSessionPlan", () => {
  it("emits no session flag for fresh sessions (createNewSession=true)", () => {
    const plan = resolveGeminiSessionPlan({ createNewSession: true });
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });

  it("emits no session flag when no sessionId and no resumeLatest", () => {
    const plan = resolveGeminiSessionPlan({});
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });

  it("emits --conversation <id> when user supplies sessionId and createNewSession=false", () => {
    const plan = resolveGeminiSessionPlan({ sessionId: "user-abc-42" });
    expect(plan.args).toEqual(["--conversation", "user-abc-42"]);
    expect(plan.resumed).toBe(true);
  });

  it("emits --continue when resumeLatest=true and no sessionId", () => {
    const plan = resolveGeminiSessionPlan({ resumeLatest: true });
    expect(plan.args).toEqual(["--continue"]);
    expect(plan.resumed).toBe(false);
  });

  it("createNewSession=true wins over a user-supplied sessionId", () => {
    const plan = resolveGeminiSessionPlan({
      createNewSession: true,
      sessionId: "user-abc-42",
    });
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });
});

describe("U27 prepareGeminiRequest end-to-end", () => {
  it("appends --sandbox when sandbox=true", () => {
    const prep = prepareGeminiRequest(baseParams({ sandbox: true }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--sandbox");
  });

  it("returns error response when policyFiles is set because agy does not support --policy", () => {
    const prep = prepareGeminiRequest(baseParams({ policyFiles: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("policyFiles");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("returns error response when adminPolicyFiles is set because agy does not support --admin-policy", () => {
    const prep = prepareGeminiRequest(baseParams({ adminPolicyFiles: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("adminPolicyFiles");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("returns error response when attachments are set because agy has no attachment token contract", () => {
    const prep = prepareGeminiRequest(baseParams({ attachments: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("attachments");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("emits agy print-mode args before other flags", () => {
    const prep = prepareGeminiRequest(
      baseParams({
        model: "flash",
        sandbox: true,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("--print");
    expect(prep.args[1]).toBe("hello");
    const remainder = prep.args.slice(2);
    expect(remainder).toContain("--model");
    expect(remainder).toContain("--sandbox");
  });
});

describe("Phase 4 slice γ — Antigravity rejects Gemini --skip-trust wiring", () => {
  it("returns an error when skipTrust=true", () => {
    const prep = prepareGeminiRequest(baseParams({ skipTrust: true }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("skipTrust");
  });

  it("does NOT emit --skip-trust when skipTrust=false", () => {
    const prep = prepareGeminiRequest(baseParams({ skipTrust: false }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--skip-trust");
  });

  it("does NOT emit --skip-trust when skipTrust is omitted (default behaviour preserved)", () => {
    const prep = prepareGeminiRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--skip-trust");
  });
});

describe("Gemini --yolo wiring", () => {
  it("emits --dangerously-skip-permissions when yolo=true (legacy, no approvalMode)", () => {
    const prep = prepareGeminiRequest(baseParams({ yolo: true }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--dangerously-skip-permissions");
    // No approval-mode emitted, so the agy permission bypass is the sole auto-approve signal.
    expect(prep.args).not.toContain("--approval-mode");
  });

  it("does NOT emit --dangerously-skip-permissions when yolo is omitted", () => {
    const prep = prepareGeminiRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--dangerously-skip-permissions");
  });

  it("emits one agy permission bypass for yolo=true + approvalMode=yolo", () => {
    const prep = prepareGeminiRequest(baseParams({ yolo: true, approvalMode: "yolo" }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args.filter(arg => arg === "--dangerously-skip-permissions")).toHaveLength(1);
    expect(prep.args).not.toContain("--approval-mode");
  });
});
