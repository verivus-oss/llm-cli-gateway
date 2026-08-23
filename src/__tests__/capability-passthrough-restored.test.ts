/**
 * Regression coverage for the three capability removals reverted before 3.1.0.
 *
 * grok `--best-of-n`, grok `--check` and devin `--agent-config` were deleted
 * from the gateway because OUR reference host's binaries stopped advertising
 * them. Every customer still on an older CLI lost a flag their binary accepts,
 * without touching their CLI: they upgraded the gateway, and we removed it.
 *
 * That was a written policy, not an accident. See
 * docs/plans/gateway-passthrough-policy.dag.toml, which replaces it: the
 * customer's INSTALLED BINARY is the authority, and the gateway is never the
 * thing that refuses a flag that binary would take.
 *
 * These tests pin the restoration. They must keep failing loudly if a future
 * rebaseline strips the flags again, because the failure mode is silent for us
 * (our host does not have the flags) and total for the affected customer.
 *
 * Every acceptance case is paired with a CONTROL asserting that a genuinely
 * unknown flag is still rejected. Without that pairing, disabling validation
 * wholesale would turn these green while removing the argument-injection and
 * argv-shape guards that must survive.
 */
import { describe, expect, it } from "vitest";
import { UPSTREAM_CLI_CONTRACTS, validateUpstreamCliArgs } from "../upstream-contracts.js";
import { GROK_FLAG_GENERATION, buildArgvFromGeneration } from "../provider-codegen.js";

describe("capabilities removed upstream stay available to customers who still have them", () => {
  it("grok --best-of-n and --check are declared in the contract", () => {
    const flags = UPSTREAM_CLI_CONTRACTS.grok.flags as Record<string, unknown>;
    expect(flags["--best-of-n"]).toBeDefined();
    expect(flags["--check"]).toBeDefined();
  });

  it("devin --agent-config is declared in the contract", () => {
    const flags = UPSTREAM_CLI_CONTRACTS.devin.flags as Record<string, unknown>;
    expect(flags["--agent-config"]).toBeDefined();
  });

  it("grok argv generation emits both flags from the generation table", () => {
    // grok's production emission is data-driven, so the table IS the behaviour.
    const argv = buildArgvFromGeneration(UPSTREAM_CLI_CONTRACTS.grok, GROK_FLAG_GENERATION, {
      bestOfN: 3,
      check: true,
    });
    expect(argv).toEqual(["--best-of-n", "3", "--check"]);
  });

  it("accepts argv carrying the restored flags", () => {
    expect(validateUpstreamCliArgs("grok", ["-p", "hi", "--best-of-n", "3"]).ok).toBe(true);
    expect(validateUpstreamCliArgs("grok", ["-p", "hi", "--check"]).ok).toBe(true);
    expect(validateUpstreamCliArgs("devin", ["-p", "hi", "--agent-config", "/tmp/a.toml"]).ok).toBe(
      true
    );
  });

  it("CONTROL: a genuinely unknown flag is still rejected for both providers", () => {
    // If this goes green alongside the cases above, validation has been
    // disabled rather than corrected and those cases prove nothing.
    const grok = validateUpstreamCliArgs("grok", ["-p", "hi", "--not-a-real-flag", "x"]);
    expect(grok.ok).toBe(false);

    const devin = validateUpstreamCliArgs("devin", ["-p", "hi", "--not-a-real-flag", "x"]);
    expect(devin.ok).toBe(false);
  });

  it("CONTROL: --best-of-n still enforces its numeric pattern", () => {
    // Restoring pass-through must not smuggle in a value the binary's own
    // parser would reject on shape. The contract's pattern is upstream's, not
    // an invented constraint.
    expect(validateUpstreamCliArgs("grok", ["-p", "hi", "--best-of-n", "0"]).ok).toBe(false);
    expect(validateUpstreamCliArgs("grok", ["-p", "hi", "--best-of-n", "abc"]).ok).toBe(false);
  });

  it("CONTROL: the argument-injection guard still fires on the restored flags", () => {
    // The single most important retained check: a caller must not be able to
    // smuggle an option through a value field.
    const injected = validateUpstreamCliArgs("devin", [
      "-p",
      "hi",
      "--agent-config",
      "--always-approve",
    ]);
    expect(injected.ok).toBe(false);
  });
});
