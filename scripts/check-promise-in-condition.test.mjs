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
import nodeFs, {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import nodePath, { dirname, join, resolve } from "node:path";
import { gatedRelativePath } from "./lib/gated-path.mjs";
import { makeScratchDir, scratchRoot } from "./lib/scratch-root.mjs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-promise-in-condition.mjs");
let fixtureRoot;

// Every fixture writer goes through this so a symlinked `.scratch` is refused
// before the first byte is written, and the write is bound to the directory
// the check saw rather than to a path a concurrent swap could retarget.
function newScratchDir(prefix) {
  return makeScratchDir(REPO_ROOT, prefix);
}

function runGate(root = fixtureRoot) {
  const args = [CHECKER];
  if (root) args.push("--root", root);
  // A disk-backed descriptor preserves checker diagnostics in restricted runners
  // that empty nested Node stdout/stderr pipes.
  const captureRoot = newScratchDir("promise-output-");
  const outputPath = join(captureRoot, "checker-output.txt");
  const outputFd = openSync(outputPath, "w");
  let exitCode = 0;
  try {
    execFileSync("node", args, { cwd: REPO_ROOT, stdio: ["ignore", outputFd, outputFd] });
  } catch (err) {
    exitCode = err.status ?? 1;
  } finally {
    closeSync(outputFd);
  }
  try {
    return { exitCode, output: readFileSync(outputPath, "utf8") };
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
    // The capture directory is per call; a surviving one is a leak, not a cache.
    expect(existsSync(captureRoot)).toBe(false);
  }
}

function inject(snippet) {
  expect(fixtureRoot).toBeUndefined();
  fixtureRoot = newScratchDir("promise-condition-");
  const sourceDir = join(fixtureRoot, "src");
  const target = join(sourceDir, "probe.ts");
  mkdirSync(sourceDir);
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["src/**/*"] })
  );
  writeFileSync(target, `export class Fixture {\n${snippet}\n}\n`);
  expect(readFileSync(target, "utf8")).toContain(snippet.trim().split("\n")[0]);
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    expect(existsSync(fixtureRoot)).toBe(false);
  }
  fixtureRoot = undefined;
});

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

  // ── the coercion family ────────────────────────────────────────────────────
  // Added after a LIVE defect, Boolean(getJobKitExecution(jobId)), sat in
  // llm_job_result while this gate reported zero. Each shape below is a
  // separate rule and therefore gets its own control: a single Boolean() test
  // would leave the rest of the family unexecuted, which is the same blind spot
  // one enumeration later.

  it("FIRES on Boolean(promise), the shape of the live defect", () => {
    inject(`  probeBooleanCoercion(): boolean {
    const p = Promise.resolve(false);
    return Boolean(p);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/Boolean\(\) coercion/);
  });

  it("FIRES on !!promise, which the negation rule already covered", () => {
    // VERIFIED, not assumed. The header claims `!!p` needed no new code
    // because the visitor descends past the outer `!` to the inner one. A
    // claim about a gate's coverage that nothing executes is exactly what this
    // file exists to refuse.
    inject(`  probeDoubleBang(): boolean {
    const p = Promise.resolve(false);
    return !!p;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/negation/);
  });

  it("FIRES on Number(promise) in a condition", () => {
    // Number(p) is NaN, so the guard is dead in the other direction: always
    // FALSE rather than always true. Equally silent.
    inject(`  probeNumberCoercion(): void {
    const p = Promise.resolve(1);
    if (Number(p)) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/if condition/);
  });

  it("FIRES on String(promise) in a condition", () => {
    inject(`  probeStringCoercion(): void {
    const p = Promise.resolve("x");
    if (String(p)) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/if condition/);
  });

  it("does NOT fire on String(promise) outside a condition", () => {
    // The deliberate boundary from the header. This gate is named for dead
    // GUARDS; a stringified promise in a log line is a different complaint and
    // flagging it here would raise the noise floor of a gate whose whole value
    // is that a finding is always real.
    inject(`  probeStringLog(): string {
    const p = Promise.resolve("x");
    return "value=" + String(p);
  }`);
    expect(runGate().exitCode).toBe(0);
  });

  it("FIRES on a promise in a for-loop condition", () => {
    inject(`  probeForCondition(): void {
    const p = Promise.resolve(false);
    for (let i = 0; p; i++) return;
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/for condition/);
  });

  it("FIRES on .filter(Boolean) over promise ELEMENTS", () => {
    // The predicate rule asks what the callback returns, which says nothing
    // here: Boolean is synchronous and correct. It is the array that is wrong,
    // and every element survives the filter.
    inject(`  probeFilterBooleanPromises(xs: Promise<number>[]): Promise<number>[] {
    return xs.filter(Boolean);
  }`);
    const r = runGate();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/\.filter\(Boolean\) over promise elements/);
  });

  it("does NOT fire on .filter(Boolean) over ordinary elements", () => {
    // The control for the rule above: dropping nullish entries with
    // `.filter(Boolean)` is a correct and common idiom.
    inject(`  probeFilterBooleanPlain(xs: (number | null)[]): number[] {
    return xs.filter(Boolean) as number[];
  }`);
    expect(runGate().exitCode).toBe(0);
  });
  it("fails closed with exit 2 when --root has no tsconfig.json, instead of scanning the cwd", () => {
    fixtureRoot = newScratchDir("promise-condition-");
    const r = runGate(fixtureRoot);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("Cannot read file");
    expect(r.output).not.toContain("promise-in-condition: 0 in production");
  });

  it("fails closed with exit 2 when the root tsconfig.json is malformed", () => {
    fixtureRoot = newScratchDir("promise-condition-");
    writeFileSync(join(fixtureRoot, "tsconfig.json"), "{ not json");
    const r = runGate(fixtureRoot);
    expect(r.exitCode).toBe(2);
    expect(r.output).not.toContain("promise-in-condition: 0 in production");
  });

  it("fails closed with exit 2 when the root tsconfig.json parses but its options are invalid", () => {
    // Distinct branch from the malformed-JSON case: the file reads and parses,
    // and TypeScript rejects an option value. Codex's round-2 mutant made this
    // branch exit 0 and the shipped suite did not notice.
    fixtureRoot = newScratchDir("promise-condition-");
    writeFileSync(
      join(fixtureRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "not-a-target" },
        include: ["src/**/*"],
      })
    );
    const r = runGate(fixtureRoot);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("--target");
    expect(r.output).not.toContain("promise-in-condition: 0 in production");
  });

  it("fails closed with exit 2 on malformed arguments", () => {
    for (const argv of [
      ["--root"],
      ["--root", ""],
      ["--roots", REPO_ROOT],
      ["--root", REPO_ROOT, "extra"],
    ]) {
      let exitCode = 0;
      try {
        execFileSync("node", [CHECKER, ...argv], { cwd: REPO_ROOT, stdio: "ignore" });
      } catch (err) {
        exitCode = err.status ?? 1;
      }
      expect(exitCode, `argv ${JSON.stringify(argv)}`).toBe(2);
    }
  });

  it("gates a Windows-separated path exactly like a POSIX one", () => {
    expect(gatedRelativePath("/repo", "/repo/src/probe.ts", nodePath.posix)).toBe("src/probe.ts");
    expect(gatedRelativePath("C:\\repo", "C:\\repo\\src\\probe.ts", nodePath.win32)).toBe(
      "src/probe.ts"
    );
    expect(gatedRelativePath("/repo", "/repo/scripts/x.ts", nodePath.posix)).toBeNull();
    expect(gatedRelativePath("/repo", "/repo/src-other/x.ts", nodePath.posix)).toBeNull();
    expect(gatedRelativePath("C:\\repo", "C:\\repo\\srcs\\x.ts", nodePath.win32)).toBeNull();
    expect(gatedRelativePath("/repo", "/repo/src", nodePath.posix)).toBeNull();
  });

  it("refuses to write fixtures through a symlinked .scratch", () => {
    // The round-2 board measured this: `.scratch -> src` sent every fixture
    // into tracked src/ while the case ran. The guard is exercised on a
    // throwaway repo root, because replacing the real .scratch mid-suite is
    // the kind of tree edit this file exists to stop.
    fixtureRoot = newScratchDir("promise-guard-");
    const fakeSrc = join(fixtureRoot, "src");
    mkdirSync(fakeSrc);
    symlinkSync("src", join(fixtureRoot, ".scratch"), "dir");
    expect(() => makeScratchDir(fixtureRoot, "promise-condition-")).toThrow(/symbolic link/);
    // Nothing may have been written through the link before the refusal.
    expect(readdirSync(fakeSrc)).toEqual([]);
  });

  it("refuses a .scratch that exists as a regular file", () => {
    fixtureRoot = newScratchDir("promise-guard-");
    writeFileSync(join(fixtureRoot, ".scratch"), "");
    expect(() => makeScratchDir(fixtureRoot, "promise-condition-")).toThrow(
      /exists and is not a directory/
    );
  });

  it("creates a missing .scratch as a real directory", () => {
    fixtureRoot = newScratchDir("promise-guard-");
    const dir = scratchRoot(fixtureRoot);
    expect(dir).toBe(join(fixtureRoot, ".scratch"));
    expect(existsSync(dir)).toBe(true);
    const made = makeScratchDir(fixtureRoot, "promise-condition-");
    expect(dirname(made)).toBe(dir);
    expect(existsSync(made)).toBe(true);
  });

  // ── the swap window ────────────────────────────────────────────────────────
  // Round 3 measured that a check followed by a path-based mkdtemp leaves a
  // window in which .scratch can become a symlink to src. These two cases play
  // the attacker at the worst moment, between the check and the write, by
  // wrapping mkdtempSync. On the path-based helper both fail with the fixture
  // under the fake src; on the descriptor-bound helper neither can.

  function swappingFs(swap) {
    let armed = true;
    return {
      ...nodeFs,
      constants: nodeFs.constants,
      mkdtempSync(prefix, opts) {
        if (armed) {
          armed = false;
          swap();
        }
        return nodeFs.mkdtempSync(prefix, opts);
      },
    };
  }

  it("keeps the fixture out of src when .scratch is renamed away and replaced by a symlink mid-write", () => {
    fixtureRoot = newScratchDir("promise-guard-");
    const fakeSrc = join(fixtureRoot, "src");
    const scratch = join(fixtureRoot, ".scratch");
    const moved = join(fixtureRoot, ".scratch-moved");
    mkdirSync(fakeSrc);
    mkdirSync(scratch);
    const made = makeScratchDir(
      fixtureRoot,
      "promise-condition-",
      swappingFs(() => {
        renameSync(scratch, moved);
        symlinkSync("src", scratch, "dir");
      })
    );
    expect(readdirSync(fakeSrc)).toEqual([]);
    const name = nodePath.basename(made);
    expect(readdirSync(moved)).toEqual([name]);
    expect(name.startsWith("promise-condition-")).toBe(true);
  });

  it("fails closed when .scratch is deleted and replaced by a symlink mid-write", () => {
    fixtureRoot = newScratchDir("promise-guard-");
    const fakeSrc = join(fixtureRoot, "src");
    const scratch = join(fixtureRoot, ".scratch");
    mkdirSync(fakeSrc);
    mkdirSync(scratch);
    expect(() =>
      makeScratchDir(
        fixtureRoot,
        "promise-condition-",
        swappingFs(() => {
          rmSync(scratch, { recursive: true });
          symlinkSync("src", scratch, "dir");
        })
      )
    ).toThrow();
    expect(readdirSync(fakeSrc)).toEqual([]);
  });

  it("refuses when .scratch is swapped for a symlink between creation and the write", () => {
    // Grok's round-3 survivor on the create path: after mkdir the helper must
    // look again, through the descriptor, not trust what it just created.
    fixtureRoot = newScratchDir("promise-guard-");
    const fakeSrc = join(fixtureRoot, "src");
    const scratch = join(fixtureRoot, ".scratch");
    mkdirSync(fakeSrc);
    const fs = {
      ...nodeFs,
      constants: nodeFs.constants,
      mkdirSync(dir, opts) {
        nodeFs.mkdirSync(dir, opts);
        rmSync(scratch, { recursive: true });
        symlinkSync("src", scratch, "dir");
      },
    };
    expect(() => makeScratchDir(fixtureRoot, "promise-condition-", fs)).toThrow(/symbolic link/);
    expect(readdirSync(fakeSrc)).toEqual([]);
  });

  it("rethrows an open failure that is not ENOENT instead of creating over it", () => {
    fixtureRoot = newScratchDir("promise-guard-");
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fs = {
      ...nodeFs,
      constants: nodeFs.constants,
      openSync() {
        throw denied;
      },
    };
    expect(() => makeScratchDir(fixtureRoot, "promise-condition-", fs)).toThrow(denied);
    expect(existsSync(join(fixtureRoot, ".scratch"))).toBe(false);
  });
});
