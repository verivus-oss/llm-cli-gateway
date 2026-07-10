import { afterEach, describe, expect, it } from "vitest";
import {
  cliBreakerState,
  primeCliBreakerStateForTest,
  providerCommandName,
  resetCliBreakersForTest,
} from "../executor.js";
import { CircuitBreakerState } from "../retry.js";
import { CLI_TYPES } from "../provider-types.js";

// `cliBreakerState` is the least-cost-routing accessor over the per-CLI circuit
// breakers. Breakers are keyed by the RESOLVED executable (e.g. cursor ->
// "cursor-agent"), so the accessor must map the CliType to its executable via
// `providerCommandName` before consulting the internal Map. These tests pin the
// mapping, the CLOSED default, and the state passthrough without spawning any
// real provider CLI.
describe("cliBreakerState", () => {
  afterEach(() => {
    resetCliBreakersForTest();
  });

  it("defaults to CLOSED for every CliType before any request creates a breaker", () => {
    for (const cli of CLI_TYPES) {
      expect(cliBreakerState(cli)).toBe(CircuitBreakerState.CLOSED);
    }
  });

  it("maps the CliType to its executable before lookup (cursor -> cursor-agent)", () => {
    // Seed a breaker under the EXECUTABLE key only.
    expect(providerCommandName("cursor")).toBe("cursor-agent");
    primeCliBreakerStateForTest("cursor-agent", CircuitBreakerState.OPEN);

    // Querying by the CliType must resolve to that executable-keyed breaker.
    expect(cliBreakerState("cursor")).toBe(CircuitBreakerState.OPEN);

    // A breaker seeded under the raw CliType name must NOT be consulted, since
    // the accessor keys by the executable. It stays at the CLOSED default.
    primeCliBreakerStateForTest("cursor", CircuitBreakerState.HALF_OPEN);
    expect(cliBreakerState("cursor")).toBe(CircuitBreakerState.OPEN);
  });

  it("returns the primed state for each breaker state and matches the internal Map", () => {
    // Providers whose executable name differs from the CliType exercise the
    // remapping paths in providerCommandName (gemini -> agy, mistral -> vibe).
    primeCliBreakerStateForTest(providerCommandName("gemini"), CircuitBreakerState.OPEN);
    primeCliBreakerStateForTest(providerCommandName("mistral"), CircuitBreakerState.HALF_OPEN);
    primeCliBreakerStateForTest(providerCommandName("claude"), CircuitBreakerState.CLOSED);

    expect(cliBreakerState("gemini")).toBe(CircuitBreakerState.OPEN);
    expect(cliBreakerState("mistral")).toBe(CircuitBreakerState.HALF_OPEN);
    expect(cliBreakerState("claude")).toBe(CircuitBreakerState.CLOSED);

    // An untouched provider still reports the healthy default.
    expect(cliBreakerState("codex")).toBe(CircuitBreakerState.CLOSED);
  });

  it("derives the executable key from providerCommandName for every CliType", () => {
    // Prove the accessor consults exactly providerCommandName(cli): prime each
    // provider's executable to OPEN and confirm the CliType query observes it.
    for (const cli of CLI_TYPES) {
      resetCliBreakersForTest();
      primeCliBreakerStateForTest(providerCommandName(cli), CircuitBreakerState.OPEN);
      expect(cliBreakerState(cli)).toBe(CircuitBreakerState.OPEN);
    }
  });
});
