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
