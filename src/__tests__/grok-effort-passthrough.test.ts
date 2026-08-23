/**
 * Regression coverage for the grok effort pass-through defect (P0, 3.1.0).
 *
 * grok 1.0.4 declares `--reasoning-effort <EFFORT>` with `[aliases: --effort]`
 * and NO possible-values set. The contract had the ALIAS carrying an invented
 * five-level enum and the canonical spelling unenforced, so `values`, which is a
 * REJECTION list, refused effort levels the binary parses.
 *
 * Established by experiment against the installed binary, with a control that
 * proves the probe can detect an enum at all:
 *
 *   grok --permission-mode bogus --single   -> "invalid value 'bogus' for
 *                                               '--permission-mode <MODE>'
 *                                               [possible values: ...]"
 *   grok --reasoning-effort bogus --single  -> falls through to the
 *                                               missing-value error for --single
 *   grok --effort bogus --single            -> same
 *
 * The control is load-bearing. Without it, "both effort probes produced an
 * error" reads as "both were rejected", when in fact clap reports enum
 * violations in preference to the missing-value error, so the absence of an
 * enum message is the signal.
 *
 * Every negative case below is paired with a positive control on a flag that
 * genuinely does carry `values`, so a future change that disables validation
 * wholesale fails here rather than silently turning these assertions green.
 */
import { describe, expect, it } from "vitest";
import { UPSTREAM_CLI_CONTRACTS, validateUpstreamCliArgs } from "../upstream-contracts.js";

const PROMPT = ["-p", "hello"] as const;

describe("grok effort is passed through, not enum-gated", () => {
  it("declares no `values` for either spelling of the effort flag", () => {
    const flags = UPSTREAM_CLI_CONTRACTS.grok.flags as Record<
      string,
      { values?: readonly string[] }
    >;
    expect(flags["--effort"]).toBeDefined();
    expect(flags["--reasoning-effort"]).toBeDefined();
    expect(flags["--effort"].values).toBeUndefined();
    expect(flags["--reasoning-effort"].values).toBeUndefined();
  });

  it("accepts an effort level outside the previously invented five-set", () => {
    // "ludicrous" is not a level the gateway advertises. The binary parses it,
    // so the gateway must not refuse it. This is the assertion that fails
    // against the pre-fix contract.
    expect(validateUpstreamCliArgs("grok", [...PROMPT, "--effort", "ludicrous"]).ok).toBe(true);
    expect(validateUpstreamCliArgs("grok", [...PROMPT, "--reasoning-effort", "ludicrous"]).ok).toBe(
      true
    );
  });

  it("still accepts the advertised levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(validateUpstreamCliArgs("grok", [...PROMPT, "--effort", level]).ok, level).toBe(true);
    }
  });

  it("CONTROL: a flag that really does carry `values` is still rejected", () => {
    // If this ever goes green alongside the cases above, validation has been
    // disabled rather than corrected, and the tests above prove nothing.
    const permission = validateUpstreamCliArgs("grok", [...PROMPT, "--permission-mode", "bogus"]);
    expect(permission.ok).toBe(false);
    expect(permission.violations[0]?.message).toContain("--permission-mode");

    const format = validateUpstreamCliArgs("grok", [...PROMPT, "--output-format", "bogus"]);
    expect(format.ok).toBe(false);

    // ...and the fourth output format added in rc.8 is still admitted, so the
    // control is not just "everything with values is rejected".
    expect(
      validateUpstreamCliArgs("grok", [...PROMPT, "--output-format", "streaming-messages-json"]).ok
    ).toBe(true);
  });

  it("rejects both effort spellings in one invocation", () => {
    // They are the same upstream option. Emitting both sends it twice and grok
    // silently last-wins, so a caller passing {effort, reasoningEffort} would
    // get whichever the argv builder happened to place last.
    const both = validateUpstreamCliArgs("grok", [
      ...PROMPT,
      "--effort",
      "high",
      "--reasoning-effort",
      "low",
    ]);
    expect(both.ok).toBe(false);
    expect(both.violations.some(v => v.message.includes("mutually exclusive"))).toBe(true);
  });
});
