/**
 * U27: Gemini high-impact features.
 *
 * Tests the schema additions on `gemini_request` / `gemini_request_async`:
 *   - sandbox → `-s`
 *   - policyFiles → `--policy <path>` (existence-validated)
 *   - adminPolicyFiles → `--admin-policy <path>` (existence-validated)
 *   - attachments → prepended `@<abs-path>` tokens (absolute + existence-validated)
 *   - createNewSession=true → no session flag (NOT `--resume`)
 *   - createNewSession=false + sessionId → `--resume <id>` (preserved behavior)
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

  it("emits --resume <id> when user supplies sessionId and createNewSession=false", () => {
    const plan = resolveGeminiSessionPlan({ sessionId: "user-abc-42" });
    expect(plan.args).toEqual(["--resume", "user-abc-42"]);
    expect(plan.resumed).toBe(true);
  });

  it("emits --resume latest when resumeLatest=true and no sessionId", () => {
    const plan = resolveGeminiSessionPlan({ resumeLatest: true });
    expect(plan.args).toEqual(["--resume", "latest"]);
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
  it("appends -s when sandbox=true", () => {
    const prep = prepareGeminiRequest(baseParams({ sandbox: true }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("-s");
  });

  it("appends --policy <path> for each policy file", () => {
    const prep = prepareGeminiRequest(baseParams({ policyFiles: [realFile1] }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--policy");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe(realFile1);
  });

  it("returns error response when policyFiles path is missing", () => {
    const missing = join(tmp, "nope.json");
    const prep = prepareGeminiRequest(baseParams({ policyFiles: [missing] }));
    // Missing path => ExtendedToolResponse (no `args` field).
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain(missing);
    expect(prep.content[0].text).toContain("policyFiles");
  });

  it("returns error response when adminPolicyFiles path is missing", () => {
    const missing = join(tmp, "nope-admin.json");
    const prep = prepareGeminiRequest(baseParams({ adminPolicyFiles: [missing] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain(missing);
    expect(prep.content[0].text).toContain("adminPolicyFiles");
  });

  it("prepends attachment tokens to the prompt passed via -p", () => {
    const prep = prepareGeminiRequest(
      baseParams({
        prompt: "describe this",
        attachments: [realFile1, realFile2],
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("-p");
    expect(prep.args[1]).toBe(`@${realFile1} @${realFile2} describe this`);
    // Effective prompt mirrors the mutated string.
    expect(prep.effectivePrompt).toBe(`@${realFile1} @${realFile2} describe this`);
  });

  it("returns error response for missing attachment paths", () => {
    const missing = join(tmp, "nope.png");
    const prep = prepareGeminiRequest(baseParams({ attachments: [missing] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain(missing);
  });

  it("preserves the -p ordering invariant when attachments are present", () => {
    const prep = prepareGeminiRequest(
      baseParams({
        attachments: [realFile1],
        model: "flash",
        sandbox: true,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    // -p must still be first; sandbox / model flags come after.
    expect(prep.args[0]).toBe("-p");
    expect(prep.args[1].startsWith(`@${realFile1} `)).toBe(true);
    const remainder = prep.args.slice(2);
    expect(remainder).toContain("--model");
    expect(remainder).toContain("-s");
  });
});
