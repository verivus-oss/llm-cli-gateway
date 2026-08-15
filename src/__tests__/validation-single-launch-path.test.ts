import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Three consecutive rounds of cross-model review found the SAME defect class in
// this file: a gate was added to the roster launch path, and the judge, which
// had its own dispatch call, silently kept the old behaviour.
//
//   round 2: the empty-reviewer filter never reached the review judge
//   round 3: cursor trust and the bubblewrap preflight never reached the judge
//
// The fix for round 3 was to make the preflight a required ARGUMENT of
// dispatchProviderJob. That is still a rule a caller has to follow, and a caller
// can satisfy it with a hand-built object. The actual fix is that there is now
// ONE launch path: launchProviderSeat computes the gates itself and is the only
// caller of dispatchProviderJob.
//
// This test is deliberately structural. The invariant is the ABSENCE of a second
// call site, and absence is not something a behavioural test can express: a
// second launch path would pass every behavioural test in the suite precisely
// because it is a separate path. So this counts call sites in the source, which
// is the only form that can fail for the reason that matters.

function orchestrator(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "validation-orchestrator.ts"),
    "utf8"
  );
}

/** Call sites of `name(`, excluding its own declaration and comment lines. */
function callSites(source: string, name: string): string[] {
  return source
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(
      ({ line }) =>
        line.includes(`${name}(`) &&
        !line.startsWith("//") &&
        !line.startsWith("*") &&
        !line.startsWith("function ") &&
        !line.startsWith("async function ")
    )
    .map(({ line, n }) => `${n}: ${line}`);
}

describe("the orchestrator has exactly one provider launch path", () => {
  it("dispatchProviderJob is called from exactly one place", () => {
    // If this fails, a second launch path was added. Do not fix it by copying
    // the gates into the new site; route the new caller through
    // launchProviderSeat, which is what makes the gates unforgettable.
    const sites = callSites(orchestrator(), "dispatchProviderJob");
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain("const outcome = dispatchProviderJob(");
  });

  it("providerPreflight is called from exactly one place", () => {
    // Same invariant one level up: if a caller computes its own preflight, it
    // can compute a WRONG one, or a permissive one, which is how a hand-built
    // { trusted: true } would defeat the gate.
    expect(callSites(orchestrator(), "providerPreflight")).toHaveLength(1);
  });

  it("both gates are reachable only through providerPreflight", () => {
    // The individual gates must not be called directly either, or a caller
    // could run one and skip the other, which is precisely what the judge did.
    expect(callSites(orchestrator(), "reviewSandboxGap")).toHaveLength(1);
    expect(callSites(orchestrator(), "cursorTrustGap")).toHaveLength(1);
  });

  it("the roster and the judge both launch through launchProviderSeat", () => {
    // The positive half: one path, and both real seats use it.
    const sites = callSites(orchestrator(), "launchProviderSeat");
    expect(sites).toHaveLength(2);
  });

  it("a trust verdict is only ever constructed inside the gates", () => {
    // dispatchProviderJob takes the preflight as an argument, so a forged
    // { trusted: true } would defeat it. The single-call-site tests above mean
    // no caller exists to forge one, and this pins the other half: the verdict
    // is only built where the rule lives.
    //
    // The first version of this test compared each line against a permissive
    // regex and PASSED against a planted `dispatchProviderJob(..., { trusted:
    // true })`, so it could not fail for the reason it named. Line ranges are
    // used instead, which is what makes "inside the gates" checkable.
    const lines = orchestrator().split("\n");
    const bodyOf = (name: string): [number, number] => {
      const start = lines.findIndex(line => line.startsWith(`function ${name}(`));
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const end = lines.findIndex((line, i) => i > start && line === "}");
      return [start, end];
    };
    const allowed = [bodyOf("cursorTrustGap"), bodyOf("providerPreflight")];
    const offenders = lines
      .map((line, i) => ({ line: line.trim(), n: i }))
      .filter(({ line }) => /trusted:\s*(true|false)/.test(line) && !line.startsWith("//"))
      .filter(({ n }) => !allowed.some(([start, end]) => n > start && n < end))
      .map(({ line, n }) => `${n + 1}: ${line}`);
    expect(offenders).toEqual([]);
  });
});
