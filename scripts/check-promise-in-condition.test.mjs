/**
 * ADD-form negative controls for the promise-in-condition gate.
 *
 * The control asserts its own INSERTION before asserting the gate fired. An
 * earlier ADD-form control in this node inserted its violation against an
 * anchor that did not exist, lint stayed green, and it looked exactly like a
 * passing control. Every ratchet here is defended by a control of this shape,
 * so the insertion is verified first, always.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const TARGET = "src/metrics.ts";
const ANCHOR = "export class PerformanceMetrics {";
const original = readFileSync(TARGET, "utf8");

function runGate() {
  try {
    execFileSync("node", ["scripts/check-promise-in-condition.mjs"], { encoding: "utf8" });
    return { exitCode: 0, output: "" };
  } catch (err) {
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function inject(snippet) {
  const before = readFileSync(TARGET, "utf8");
  // ASSERT THE INSERTION FIRST. A control whose violation never landed reports
  // a green gate and is indistinguishable from a control that passed.
  expect(before).toContain(ANCHOR);
  const after = before.replace(ANCHOR, `${ANCHOR}\n${snippet}\n`);
  expect(after).not.toBe(before);
  writeFileSync(TARGET, after);
  expect(readFileSync(TARGET, "utf8")).toContain(snippet.trim().split("\n")[0]);
}

afterEach(() => writeFileSync(TARGET, original));

describe("promise-in-condition gate", () => {
  it("passes on the clean tree", () => {
    expect(runGate().exitCode).toBe(0);
  });

  it("FIRES on a thenable whose type is NOT named Promise<...>", () => {
    // The control for structural detection. This gate used to decide
    // promise-ness with /^Promise</ against the rendered type name, which is
    // the exact mistake that stripped seven awaits earlier in this node:
    // PromiseWithChild is a promise and does not match that name.
    //
    // Without this control the name match could be reinstated and all the
    // other controls would still pass, which is what "a control that passes in
    // both states is not a control" means in practice. Probed: restoring the
    // name match fails THIS test and nothing else.
    inject(`  probeNamedThenable(): void {
    const deferred = { then(resolve: (v: boolean) => void): void { resolve(true); } };
    if (deferred) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("if condition");
  });

  it("FIRES on a NAMED async predicate, not only an inline async arrow", () => {
    // Review found this hole: the gate matched only a syntactically `async`
    // arrow written at the call site, so hoisting the same predicate into a
    // const hid it. The truthiness bug is identical either way.
    inject(`  probeNamedPredicate(xs: number[]): number | undefined {
    const isBig = async (x: number) => x > 0;
    return xs.find(isBig);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("async predicate to .find()");
  });

  it("FIRES on a predicate that returns a promise WITHOUT the async keyword", () => {
    // The second half of the same hole: no `async` keyword anywhere, and the
    // returned promise is still unconditionally truthy.
    inject(`  probePromiseReturningPredicate(xs: number[]): number[] {
    const isBig = (x: number): Promise<boolean> => Promise.resolve(x > 0);
    return xs.filter(isBig);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("async predicate to .filter()");
  });

  it("FIRES on a promise in an if condition", () => {
    inject(`  probeIf(): void {
    const p = Promise.resolve(false);
    if (p) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/if condition/);
  });

  it("FIRES on a negated promise", () => {
    inject(`  probeNeg(): void {
    const p = Promise.resolve(false);
    if (!p) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/negation/);
  });

  it("FIRES on a promise as a && operand", () => {
    inject(`  probeAnd(): void {
    const p = Promise.resolve(false);
    if (p && Date.now() > 0) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/operand/);
  });

  it("FIRES on an async predicate to .every()", () => {
    // The gate cannot see this as a boolean position: the truthiness test is
    // inside Array.prototype. It is caught by the shape of the call instead.
    inject(`  probeEvery(xs: number[]): boolean {
    return xs.every(async x => x > 0);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/async predicate to \.every\(\)/);
  });

  it("FIRES on an async predicate to .find()", () => {
    inject(`  probeFind(xs: number[]): number | undefined {
    return xs.find(async x => x > 0);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/async predicate to \.find\(\)/);
  });

  it("does NOT fire on a SYNC predicate", () => {
    // The control. A gate that flagged every .every() would be noise at the
    // sites where the idiom is correct, which is most of them.
    inject(`  probeSync(xs: number[]): boolean {
    return xs.every(x => x > 0);
  }`);
    expect(runGate().exitCode).toBe(0);
  });

  it("does NOT fire on .map(async ...), which is a different rule's problem", () => {
    // map does not test truthiness, so an async callback there is legal and
    // usually wrapped in Promise.all. Flagging it would be wrong.
    inject(`  probeMap(xs: number[]): Promise<number>[] {
    return xs.map(async x => x + 1);
  }`);
    expect(runGate().exitCode).toBe(0);
  });

  it("does NOT fire on a nullable promise, the cached-promise idiom", () => {
    // The control that stops this becoming noise. Testing whether a memoised or
    // in-flight promise EXISTS is legitimate and this codebase does it
    // deliberately in at least three places.
    inject(`  probeNullable(): void {
    const p: Promise<void> | undefined = undefined;
    if (p) return;
  }`);
    expect(runGate().exitCode).toBe(0);
  });

  it("does NOT fire on the promise duck-type idiom", () => {
    inject(`  probeDuck(v: unknown): void {
    if (v && typeof (v as Promise<void>).then === "function") return;
  }`);
    expect(runGate().exitCode).toBe(0);
  });
});
