/**
 * Negative controls for the s5 assertion-parity checker.
 *
 * Every control is ADD-form: it introduces a NEW weakening into the head source
 * and asserts the checker fires. Removing an entry the checker already lists is
 * not evidence, and the s2 ratchet was wrong twice before it was right, so the
 * checker's own logic is probed by these too.
 */
import { describe, expect, it } from "vitest";
import {
  compareTestFile,
  extractAssertions,
  normaliseSubject,
  preExistingBareMatchers,
} from "./check-test-assertion-parity.mjs";

const BASE = `
import { describe, expect, it } from "vitest";
describe("store", () => {
  it("refuses an unadmitted attempt", () => {
    expect(() => store.recordStart({ id: "a" })).toThrow(/not admitted/);
  });
  it("reads a row back", () => {
    expect(store.getById("a")).toEqual({ id: "a" });
  });
});
`;

/** The whole point: this is what the port legitimately does to BASE. */
const PORTED = `
import { describe, expect, it } from "vitest";
describe("store", () => {
  it("refuses an unadmitted attempt", async () => {
    await expect(store.recordStart({ id: "a" })).rejects.toThrow(/not admitted/);
  });
  it("reads a row back", async () => {
    expect(await store.getById("a")).toEqual({ id: "a" });
  });
});
`;

describe("permitted rewrites", () => {
  it("accepts sync-throw to rejects, and an inserted await", () => {
    expect(compareTestFile(BASE, PORTED, "t.test.ts")).toEqual([]);
  });

  it("accepts a file that did not change at all", () => {
    expect(compareTestFile(BASE, BASE, "t.test.ts")).toEqual([]);
  });
});

describe("ADD-form negative controls", () => {
  it("fires when a toThrow argument is NARROWED away", () => {
    // The single most likely weakening during an async port: keep the shape,
    // drop the error that made it specific.
    const head = PORTED.replace("rejects.toThrow(/not admitted/)", "rejects.toThrow()");
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/outside the allowlist/);
  });

  it("fires when a matcher is WEAKENED", () => {
    const head = PORTED.replace('toEqual({ id: "a" })', "toBeTruthy()");
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/outside the allowlist/);
  });

  it("fires when an expected VALUE changes", () => {
    const head = PORTED.replace('toEqual({ id: "a" })', 'toEqual({ id: "b" })');
    expect(compareTestFile(BASE, head, "t.test.ts")).toHaveLength(1);
  });

  it("fires when an assertion is REMOVED", () => {
    const head = PORTED.replace('expect(await store.getById("a")).toEqual({ id: "a" });', "");
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v.some(x => /no assertion on that subject survives/.test(x))).toBe(true);
  });

  it("fires when a test gains .skip", () => {
    const head = PORTED.replace('it("reads a row back"', 'it.skip("reads a row back"');
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v.some(x => /gained \.skip/.test(x))).toBe(true);
  });

  it("fires when a test gains .only", () => {
    const head = PORTED.replace('it("reads a row back"', 'it.only("reads a row back"');
    expect(compareTestFile(BASE, head, "t.test.ts").some(x => /gained \.only/.test(x))).toBe(true);
  });

  it("fires when a test is RENAMED", () => {
    const head = PORTED.replace('"reads a row back"', '"reads a row back eventually"');
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v.some(x => /removed or renamed/.test(x))).toBe(true);
  });

  it("fires when the test COUNT decreases", () => {
    const head = PORTED.replace(/ {2}it\("reads a row back"[\s\S]*?\n {2}\}\);\n/, "");
    const v = compareTestFile(BASE, head, "t.test.ts");
    expect(v.some(x => /test count decreased/.test(x))).toBe(true);
  });

  it("fires when a throw is turned into a resolves instead of a rejects", () => {
    // rejects is the ONLY permitted modifier gain. resolves would invert the
    // meaning of the test while looking like the same edit.
    const head = PORTED.replace("rejects.toThrow", "resolves.toThrow");
    expect(compareTestFile(BASE, head, "t.test.ts")).toHaveLength(1);
  });

  it("fires when an assertion is negated with .not", () => {
    const head = PORTED.replace("rejects.toThrow", "rejects.not.toThrow");
    expect(compareTestFile(BASE, head, "t.test.ts")).toHaveLength(1);
  });
});

describe("pre-existing bare matchers", () => {
  const BARE = `
import { describe, expect, it } from "vitest";
it("refuses", () => {
  expect(() => store.recordStart({ id: "a" })).toThrow();
  expect(() => store.markRunning("a")).toThrow(/nope/);
});
`;

  it("reports a matcher that was ALREADY bare at the base ref", () => {
    // Three real sites exist: job-store-pg.test.ts:1146, job-store.test.ts:156
    // and validation-run-store.test.ts:298, all bare at 039c006. A reader
    // comparing head against the parity rule would see an un-narrowed matcher
    // and "fix" it; this is how the tool says it was always that way.
    const bare = preExistingBareMatchers(BARE, "t.test.ts");
    expect(bare).toHaveLength(1);
    expect(bare[0].subject).toBe('store.recordStart({ id: "a" })');
    expect(bare[0].matcher).toBe("toThrow");
  });

  it("does NOT report a matcher that carries an argument", () => {
    // The control that stops this becoming a blanket amnesty for bare matchers.
    const bare = preExistingBareMatchers(BARE, "t.test.ts");
    expect(bare.map(b => b.subject)).not.toContain('store.markRunning("a")');
  });

  it("still fails a NEWLY narrowed matcher even though bare ones are reported", () => {
    // ADD-form: narrowing toThrow(/nope/) to toThrow() must remain a violation.
    // Reporting pre-existing bare matchers must not excuse a new one.
    const ported = BARE.replace(
      'expect(() => store.markRunning("a")).toThrow(/nope/);',
      'await expect(store.markRunning("a")).rejects.toThrow();'
    );
    const v = compareTestFile(BARE, ported, "t.test.ts");
    expect(v.some(x => /outside the allowlist/.test(x))).toBe(true);
  });
});

describe("the checker's own parsing", () => {
  it("strips a thunk wrapper and a leading await to the same subject", () => {
    // If these did not normalise to one string, the permitted rewrite would
    // never match and the checker would fail every legitimate port: a gate that
    // rejects everything is as useless as one that accepts everything.
    expect(normaliseSubject("() => store.recordStart({ id: 1 })")).toEqual({
      subject: "store.recordStart({ id: 1 })",
      thunk: true,
    });
    expect(normaliseSubject("await store.recordStart({ id: 1 })")).toEqual({
      subject: "store.recordStart({ id: 1 })",
      thunk: false,
    });
  });

  it("records modifiers and matcher arguments it must compare", () => {
    const [a] = extractAssertions("expect(x).rejects.toThrow(/boom/);", "t.test.ts");
    expect(a.modifiers).toEqual(["rejects"]);
    expect(a.matcher).toBe("toThrow");
    expect(a.args).toEqual(["/boom/"]);
  });

  it("does not silently find zero assertions in a real-looking file", () => {
    // A parser that matches nothing makes every control above pass vacuously.
    expect(extractAssertions(BASE, "t.test.ts")).toHaveLength(2);
    expect(extractAssertions(PORTED, "t.test.ts")).toHaveLength(2);
  });
});
