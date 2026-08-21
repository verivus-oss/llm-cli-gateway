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
