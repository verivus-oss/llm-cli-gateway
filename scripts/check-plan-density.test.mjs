import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PLANS = join(ROOT, "docs", "plans");
const BASELINE = join(PLANS, ".density-baseline.json");

function run() {
  try {
    return {
      code: 0,
      out: execFileSync("node", ["scripts/check-plan-density.mjs"], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("plan-density ratchet", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  // TRACKED files, deliberately not a directory listing and deliberately not the
  // checker's wider scan set. The baseline is committed, so the contract it must
  // match is what git carries: a gitignored plan file must not earn a ceiling,
  // and an untracked one has no ceiling yet by definition. The checker also
  // scans untracked-not-ignored files, because that is what NEW_FILE_CAP is for.
  const present = execFileSync("git", ["ls-files", "--", "docs/plans/*.dag.toml"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map(f => f.slice("docs/plans/".length));

  it("passes on the tree as committed", () => {
    expect(run().code).toBe(0);
  });

  it("has a ceiling for every plan file, and no ceiling for a file that is gone", () => {
    expect(Object.keys(baseline).sort()).toEqual(present.sort());
  });

  it("FAILS when a plan file grows past its ceiling", () => {
    // The defect it exists to catch, and the direction that actually happened:
    // 2,499 lines added to docs/plans against 1,095 of src.
    const victim = join(PLANS, present[0]);
    const original = readFileSync(victim, "utf8");
    try {
      writeFileSync(victim, `${original}\n# padding\n# padding\n`);
      const r = run();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/lines, ceiling/);
    } finally {
      writeFileSync(victim, original);
    }
  });

  it("FAILS a NEW plan file over the 150-line cap", () => {
    const probe = join(PLANS, "zz-density-probe.dag.toml");
    try {
      // Valid TOML, deliberately. `"x = 1\n".repeat(200)` is 200 duplicate
      // keys, so the parse check added after the unparseable-plan incident
      // fires first and this control stops testing the line cap it is named
      // for. A fixture standing in for a plan file has to BE one.
      const body = Array.from({ length: 200 }, (_, i) => `x${i} = 1`).join("\n");
      writeFileSync(probe, `# probe\n${body}\n`);
      const r = run();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/NEW and \d+ lines/);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it("FAILS when a plan file is not valid TOML", () => {
    // The incident: a merge resolution put two `id =` keys under one [[node]]
    // header and the document stopped being TOML. This gate counted lines and
    // the citation gate regexed for paths, so both stayed green for a day, and
    // the hand-check run to verify the merge matched `^id = ` over raw text and
    // reported a healthy node count on a file nothing could read.
    const victim = join(PLANS, present[0]);
    const original = readFileSync(victim, "utf8");
    try {
      // Duplicate keys: valid lines, invalid document. That is the shape the
      // incident had, rather than a syntax error a reader would notice.
      writeFileSync(victim, `${original}\nduplicate_probe = 1\nduplicate_probe = 2\n`);
      const r = run();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/does not parse as TOML/);
      expect(r.out).toContain(present[0]);
    } finally {
      writeFileSync(victim, original);
    }
  });

  it("FAILS when a file with a ceiling disappears, so the ceiling cannot silently return", () => {
    const victim = join(PLANS, present[0]);
    const original = readFileSync(victim, "utf8");
    try {
      rmSync(victim);
      const r = run();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/GONE/);
    } finally {
      writeFileSync(victim, original);
    }
  });
});
