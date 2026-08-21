import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WRITE_ORDERING_RULES, type WriteOrderingRuleId } from "../storage/write-ordering.js";

// This file is the reason src/storage/write-ordering.ts is not a paragraph.
// The DAG's own record is that a constraint written in a plan is an unexecuted
// assertion until something runs it, and that this map has already produced two
// of them. So: every rule names the test that runs it, and a name that does not
// resolve to a real test fails here.

const ROOT = process.cwd();
const TESTS = join(ROOT, "src", "__tests__");

/** The rule set, pinned. Adding or dropping a failure mode must be deliberate. */
const EXPECTED_RULE_IDS: readonly WriteOrderingRuleId[] = [
  "in_process_start_before_complete",
  "idempotence_flags_not_straddled",
  "inline_vs_manager_double_complete",
  "crash_between_start_and_complete",
  "cross_process_orphan_completion",
  "rejected_start_poisons_chain",
  "status_guarded_complete_updates_zero_rows",
  "telemetry_before_start_row",
  "immediate_read_after_write",
  "correlation_id_reuse",
  "unbounded_queue_growth",
  "start_failure_policy",
  "complete_timeout_semantics",
  "unattached_completion_side_table",
  "merge_fence",
];

/**
 * Design 3.4's own failure list, by an anchor phrase from the document, mapped
 * to the rule that answers it. If the design is reworded the anchor stops
 * matching, which is the point: the spec must not drift away from its source.
 */
const DESIGN_BULLETS: ReadonlyArray<[string, WriteOrderingRuleId]> = [
  ["process crash or `SIGKILL` between start and complete", "crash_between_start_and_complete"],
  ["orphan completion by a different gateway instance", "cross_process_orphan_completion"],
  [
    "a rejected `logStart` promise poisoning or bypassing the chain",
    "rejected_start_poisons_chain",
  ],
  [
    "a status-guarded `logComplete` updating zero rows",
    "status_guarded_complete_updates_zero_rows",
  ],
  ["compression telemetry racing a missing start row", "telemetry_before_start_row"],
  ["immediate read-after-write", "immediate_read_after_write"],
  ["correlation-id reuse, and unbounded growth of the queue map", "correlation_id_reuse"],
];

function allTestSource(): string {
  return readdirSync(TESTS)
    .filter(name => name.endsWith(".test.ts"))
    .map(name => readFileSync(join(TESTS, name), "utf8"))
    .join("\n");
}

describe("write-ordering specification (s6)", () => {
  it("covers exactly the pinned rule set", () => {
    expect(Object.keys(WRITE_ORDERING_RULES).sort()).toEqual([...EXPECTED_RULE_IDS].sort());
  });

  it("answers every failure mode design 3.4 lists", () => {
    const design = readFileSync(join(ROOT, "docs", "plans", "storage-unification.md"), "utf8");
    for (const [anchor, ruleId] of DESIGN_BULLETS) {
      expect(design, `design 3.4 no longer says: ${anchor}`).toContain(anchor);
      expect(WRITE_ORDERING_RULES[ruleId]).toBeDefined();
    }
    // The queue-map half of the last bullet is answered by its own rule.
    expect(WRITE_ORDERING_RULES.unbounded_queue_growth.status).toBe("enforced");
  });

  it("names a real test for every rule that claims to be run", () => {
    const source = allTestSource();
    const missing: string[] = [];
    for (const [id, rule] of Object.entries(WRITE_ORDERING_RULES)) {
      if (rule.status === "unenforced") {
        expect(rule.unenforcedBecause.length, `${id} must say why`).toBeGreaterThan(40);
        continue;
      }
      for (const title of rule.verifiedBy) {
        if (!source.includes(`it("${title}"`)) missing.push(`${id} -> ${title}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("awaits every flight.start and flight.completeInline call site in index.ts", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    const unawaited: string[] = [];
    for (const match of source.matchAll(/flight\.(start|completeInline)\(/g)) {
      const index = match.index ?? 0;
      if (source.slice(Math.max(0, index - 6), index) !== "await ") {
        unawaited.push(`${match[0]} at offset ${index}`);
      }
    }
    // Not a style rule. An unawaited start() lets `execute` dispatch before the
    // start row is down, and an unawaited completeInline() lets the handler
    // return before the response body is durable.
    expect(unawaited).toEqual([]);
    expect(source.match(/flight\.start\(/g)?.length).toBeGreaterThan(0);

    // The other half of the same invariant, and the reason the await matters at
    // all: the envelope must finish the stage that holds `flight.start()` before
    // it dispatches `execute`. Reordering these two lines would let the sync
    // deadline arm the async manager while the start row was still open.
    const staged = source.indexOf("await hooks.runInsideTerminalTry()");
    const dispatched = source.indexOf("await hooks.execute(");
    expect(staged).toBeGreaterThan(-1);
    expect(dispatched).toBeGreaterThan(staged);
  });

  it("takes the port's sink types rather than a void slot", () => {
    const source = readFileSync(join(ROOT, "src", "flight-ownership.ts"), "utf8");
    // A slot typed `() => void` accepts an async thunk in silence, which is why
    // FlightStartSink and FlightCompleteSink exist in the port at all.
    expect(source).toContain('from "./storage/operations.js"');
    expect(source).toContain("startFn: FlightStartSink");
    expect(source).toContain("completeFn: FlightCompleteSink");
    expect(source).not.toMatch(/=>\s*void\b/);
  });

  it("awaits flightRecorder.close() in performShutdown", () => {
    const source = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    // `pre_positioned` on the s7 node: this was the one close() in
    // performShutdown that was not awaited, harmless only while the recorder
    // was synchronous. Unawaited, process.exit() fires while the driver's
    // bounded drain is still running, and the log line on the next line
    // asserts a close that did not finish. The DYNAMIC half of this pair is
    // "close() settles only after an already-submitted write has settled",
    // which is what makes the await load-bearing rather than decorative.
    expect(source).toMatch(/await flightRecorder\.close\(\);\s*\n\s*logger\.info/);
  });

  it("declares no recorder sink that returns void", () => {
    // s7 found the SECOND instance of the same hazard, and it was live: ACP's
    // own `AcpFlightSink` declared `logStart(entry): void`, so the async
    // recorder's promises were absorbed by the type and every ACP flight write
    // was silently dropped. No lint rule can see a promise the type system has
    // already discarded, so the control has to be the declaration. Checking one
    // file fixed one site; this checks the class.
    for (const file of [
      join(ROOT, "src", "acp", "runtime.ts"),
      join(ROOT, "src", "storage", "operations.ts"),
    ]) {
      const source = readFileSync(file, "utf8");
      for (const method of ["logStart", "logComplete"]) {
        const declaration = new RegExp(`\\b${method}\\([^)]*\\):\\s*(\\w+)`, "g");
        for (const match of source.matchAll(declaration)) {
          expect(match[1], `${file}: ${method} returns ${match[1]}`).toBe("Promise");
        }
      }
    }
  });
});
