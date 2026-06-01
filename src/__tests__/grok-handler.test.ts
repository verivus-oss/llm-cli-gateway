/**
 * Phase 4 slice δ — Grok `--max-turns` wiring.
 */
import { describe, expect, it } from "vitest";
import { prepareGrokRequest, MAX_TURNS_SCHEMA, MAX_PRICE_SCHEMA } from "../index.js";

function baseParams(extra: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "grok_request",
    ...extra,
  };
}

describe("Phase 4 slice δ — Grok --max-turns wiring", () => {
  it("emits --max-turns <N> when maxTurns is set", () => {
    const prep = prepareGrokRequest(baseParams({ maxTurns: 7 }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("7");
  });

  it("does NOT emit --max-turns when maxTurns is omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--max-turns");
  });

  it("does NOT emit --max-turns when maxTurns is explicitly undefined", () => {
    const prep = prepareGrokRequest(baseParams({ maxTurns: undefined }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--max-turns");
  });

  it("MAX_TURNS_SCHEMA rejects out-of-range / unsafe / scientific-notation values", () => {
    // Accept the happy path.
    expect(MAX_TURNS_SCHEMA.safeParse(1).success).toBe(true);
    expect(MAX_TURNS_SCHEMA.safeParse(10_000).success).toBe(true);
    // Reject zero / negative / non-integer.
    expect(MAX_TURNS_SCHEMA.safeParse(0).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(-1).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(1.5).success).toBe(false);
    // Reject above the 10k ceiling.
    expect(MAX_TURNS_SCHEMA.safeParse(10_001).success).toBe(false);
    // Reject values whose String() form would be scientific notation
    // (`1e21` → "1e+21") — exactly Codex's review finding.
    expect(MAX_TURNS_SCHEMA.safeParse(1e21).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it("MAX_PRICE_SCHEMA rejects Infinity / NaN / out-of-range / scientific-notation", () => {
    expect(MAX_PRICE_SCHEMA.safeParse(0.001).success).toBe(true);
    expect(MAX_PRICE_SCHEMA.safeParse(10_000).success).toBe(true);
    // Lower bound: 1e-6 is the smallest value String() emits in decimal form.
    expect(MAX_PRICE_SCHEMA.safeParse(1e-6).success).toBe(true);
    expect(String(1e-6)).toBe("0.000001");
    expect(MAX_PRICE_SCHEMA.safeParse(0).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(-0.5).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(Infinity).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(NaN).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(10_001).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(1e21).success).toBe(false);
    // The exact attack vector from Codex round-2: 1e-7 stringifies as "1e-7"
    // which Vibe and our --max-price contract regex both reject.
    expect(MAX_PRICE_SCHEMA.safeParse(1e-7).success).toBe(false);
    expect(String(1e-7)).toBe("1e-7");
  });

  it("emits --max-turns alongside existing flags without disturbing argv order", () => {
    const prep = prepareGrokRequest(
      baseParams({
        model: "grok-build",
        outputFormat: "json",
        allowedTools: ["read", "edit"],
        maxTurns: 12,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    // `-p` is still first; --max-turns is appended after the existing flag
    // set, mirroring prepareClaudeHighImpactFlags' append-only contract.
    expect(prep.args[0]).toBe("-p");
    expect(prep.args).toContain("--model");
    expect(prep.args).toContain("--output-format");
    expect(prep.args).toContain("--tools");
    const idx = prep.args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("12");
  });
});

describe("Grok 0.2.x: --compaction-mode / --compaction-detail wiring", () => {
  it("emits --compaction-mode <MODE> when compactionMode is set", () => {
    const prep = prepareGrokRequest(baseParams({ compactionMode: "segments" }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--compaction-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("segments");
  });

  it("emits --compaction-detail <DETAIL> when compactionDetail is set", () => {
    const prep = prepareGrokRequest(baseParams({ compactionDetail: "balanced" }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--compaction-detail");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("balanced");
  });

  it("emits both compaction flags together, appended after existing flags", () => {
    const prep = prepareGrokRequest(
      baseParams({
        model: "grok-build",
        outputFormat: "json",
        compactionMode: "transcript",
        compactionDetail: "verbose",
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("-p");
    const mIdx = prep.args.indexOf("--compaction-mode");
    const dIdx = prep.args.indexOf("--compaction-detail");
    expect(prep.args[mIdx + 1]).toBe("transcript");
    expect(prep.args[dIdx + 1]).toBe("verbose");
  });

  it("emits neither compaction flag when both are omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--compaction-mode");
    expect(prep.args).not.toContain("--compaction-detail");
  });
});
