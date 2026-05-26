/**
 * Phase 4 slice δ — Grok `--max-turns` wiring.
 */
import { describe, expect, it } from "vitest";
import { prepareGrokRequest } from "../index.js";

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
