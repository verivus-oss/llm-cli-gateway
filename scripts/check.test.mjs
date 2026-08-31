/**
 * The gate runner, and the property the `&&` chain did not have.
 *
 * The scheduler is driven with SYNTHETIC steps here: asserting the real gate by
 * running it would take five minutes and would test the checks rather than the
 * thing that was broken, which is what happens to the steps after a failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEPS, NOT_IN_GATE } from "./check-steps.mjs";
import { runSteps, summarise } from "./run-steps.mjs";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** An executor over a map of name to exit code, recording what actually ran. */
const executorFor =
  (codes, ran = []) =>
  step => {
    ran.push(step.name);
    return Promise.resolve({ code: codes[step.name] ?? 0, output: `output of ${step.name}` });
  };

describe("a failing step cannot hide an independent one", () => {
  it("runs every independent step even when the first fails", async () => {
    // THE DEFECT, as a test. Under `a && b && c` a failing `a` means b and c
    // never run and nothing says so. Here they run and are reported.
    const steps = [
      { name: "a", script: "a" },
      { name: "b", script: "b" },
      { name: "c", script: "c" },
    ];
    const ran = [];
    const results = await runSteps(steps, executorFor({ a: 1 }, ran), { concurrency: 1 });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(summarise(results)).toMatchObject({ pass: 2, fail: 1, skipped: 0 });
  });

  it("reports the LAST step even when an earlier one fails", async () => {
    // The concrete shape of the real defect: security:audit at 21 of 22 failing
    // meant verify:no-internal-mcp:check never ran, and it passes on its own,
    // so nothing surfaced it.
    const steps = Array.from({ length: 22 }, (_, i) => ({
      name: `s${i + 1}`,
      script: `s${i + 1}`,
    }));
    const results = await runSteps(steps, executorFor({ s21: 1 }), { concurrency: 1 });
    const last = results.find(r => r.name === "s22");
    expect(last).toBeDefined();
    expect(last.status).toBe("pass");
  });
});

describe("a step that did not run is not a pass", () => {
  it("marks a dependant SKIPPED when its dependency fails, and names the blocker", async () => {
    const steps = [
      { name: "build", script: "build" },
      { name: "needs-dist", script: "x", needs: ["build"] },
      { name: "independent", script: "y" },
    ];
    const ran = [];
    const results = await runSteps(steps, executorFor({ build: 1 }, ran), { concurrency: 1 });
    expect(ran).not.toContain("needs-dist");
    expect(ran).toContain("independent");
    const skipped = results.find(r => r.name === "needs-dist");
    expect(skipped.status).toBe("skipped");
    expect(skipped.blockedBy).toBe("build");
  });

  it("fails the gate on a skip alone, with nothing else wrong", async () => {
    const steps = [
      { name: "build", script: "build" },
      { name: "needs-dist", script: "x", needs: ["build"] },
    ];
    const results = await runSteps(steps, executorFor({ build: 1 }), { concurrency: 1 });
    const { fail, skipped } = summarise(results);
    // The CLI exits non-zero when either is non-zero; a skip must not be able
    // to pass as green just because no step reported failure.
    expect(fail).toBe(1);
    expect(skipped).toBe(1);
  });

  it("reports steps never reached under --fail-fast rather than dropping them", async () => {
    const steps = [
      { name: "a", script: "a" },
      { name: "b", script: "b" },
      { name: "c", script: "c" },
    ];
    const results = await runSteps(steps, executorFor({ a: 1 }), {
      concurrency: 1,
      failFast: true,
    });
    expect(results).toHaveLength(3);
    expect(results.filter(r => r.status === "skipped").map(r => r.name)).toEqual(["b", "c"]);
  });

  it("does not spin on a needs that names a step outside the list", async () => {
    const steps = [{ name: "a", script: "a", needs: ["nope"] }];
    const results = await runSteps(steps, executorFor({}), { concurrency: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");
  });
});

describe("heavy steps never run beside anything", () => {
  it("gives a heavy step the machine to itself", async () => {
    // Measured on this host: two concurrent full suites turn an UNMUTATED tree
    // red. A scheduler that overlapped them would manufacture failures.
    const steps = [
      { name: "cheap1", script: "a" },
      { name: "heavy", script: "b", heavy: true },
      { name: "cheap2", script: "c" },
    ];
    let inFlight = 0;
    let sawHeavyAlone = true;
    const execute = step => {
      inFlight++;
      if (step.heavy && inFlight > 1) sawHeavyAlone = false;
      return new Promise(resolve =>
        setTimeout(() => {
          if (step.heavy && inFlight > 1) sawHeavyAlone = false;
          inFlight--;
          resolve({ code: 0, output: "" });
        }, 5)
      );
    };
    await runSteps(steps, execute, { concurrency: 4 });
    expect(sawHeavyAlone).toBe(true);
  });
});

describe("the declared gate covers the tree", () => {
  it("wires npm run check to the runner", () => {
    expect(pkg.scripts.check).toContain("scripts/check.mjs");
    // The chain is gone. If it comes back, the property above is gone with it.
    expect(pkg.scripts.check).not.toContain("&&");
  });

  it("names only scripts that exist", () => {
    for (const step of STEPS) {
      expect(pkg.scripts[step.script], `${step.name} runs a missing script`).toBeDefined();
    }
  });

  it("puts every check-shaped script in the gate or in the exclusion list", () => {
    // DERIVED from package.json, and the exclusion list is INVERTED: a new
    // `*:check` script is either wired into the gate or named as excluded with
    // a reason. A hand-kept inclusion list would just silently stay short,
    // which is how the gate came to be missing things in the first place.
    const inGate = new Set(STEPS.map(s => s.script));
    const candidates = Object.keys(pkg.scripts).filter(
      n => /:check$/.test(n) || ["lint", "build", "test"].includes(n)
    );
    const unaccounted = candidates.filter(n => !inGate.has(n) && !(n in NOT_IN_GATE));
    expect(
      unaccounted,
      `wire these into scripts/check-steps.mjs or list them in NOT_IN_GATE with a reason: ${unaccounted.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the exclusion list honest: every excluded name still exists", () => {
    for (const [name, reason] of Object.entries(NOT_IN_GATE)) {
      expect(pkg.scripts[name], `${name} is excluded but no longer exists`).toBeDefined();
      expect(reason.length, `${name} is excluded with no reason`).toBeGreaterThan(10);
    }
  });

  it("drops nothing the && chain ran", () => {
    // A refactor that quietly loses a step is worse than the chain it replaces.
    // Pinned against the chain as it stood at bd5aaad, read from git rather
    // than retyped. ADDING is allowed and DROPPING is not, so this is a subset
    // test and not an equality one: the ratchet above is what forces additions
    // to be deliberate.
    const previous = execFileSync("git", ["show", "bd5aaad:package.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const before = JSON.parse(previous)
      .scripts.check.split("&&")
      .map(s =>
        s
          .trim()
          .replace(/^npm run /, "")
          .replace(/^npm /, "")
      );
    const now = new Set(STEPS.map(s => s.script));
    const dropped = before.filter(name => !now.has(name));
    expect(dropped, `the chain ran these and the runner does not: ${dropped.join(", ")}`).toEqual(
      []
    );
  });
});

describe("the CLI", () => {
  const run = args => {
    try {
      return {
        code: 0,
        out: execFileSync("node", ["scripts/check.mjs", ...args], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("lists the steps without running them", () => {
    const { code, out } = run(["--list"]);
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(STEPS.length);
    expect(out).toContain("security:audit");
  });

  it("refuses an unknown --only rather than silently running nothing", () => {
    const { code, out } = run(["--only", "no-such-step"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown step");
  });
});
