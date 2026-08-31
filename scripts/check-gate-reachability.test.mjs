/**
 * The audit's two modes.
 *
 * The shrinkwrap is generated at pack time and never committed, and this step
 * hard-failed on its absence, so `npm run check` exited 1 on every developer
 * tree. Under the old `&&` chain that also meant the step after it never ran at
 * all; the chain is gone (scripts/check.mjs) and THAT property is pinned in
 * check.test.mjs, but the mode split is still what makes the gate runnable.
 *
 * These tests are about the MODES, not the audit's content: running the audit
 * itself packs a tarball and installs it, which belongs in the release path
 * rather than in every suite run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const run = (argv, env = {}) => {
  try {
    return {
      code: 0,
      out: execFileSync(argv[0], argv.slice(1), {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

describe("the shrinkwrap step has two modes", () => {
  const audit = join(ROOT, "scripts", "release-security-audit.sh");
  const source = readFileSync(audit, "utf8");

  it("refuses a missing shrinkwrap under LLM_GATEWAY_REQUIRE_SHRINKWRAP=1", () => {
    // The RELEASE behaviour, unchanged. Asserted by running the audit far
    // enough to reach the step: it exits non-zero and says why.
    expect(existsSync(join(ROOT, "npm-shrinkwrap.json"))).toBe(false);
    const { code, out } = run(["bash", audit], { LLM_GATEWAY_REQUIRE_SHRINKWRAP: "1" });
    expect(code).not.toBe(0);
    expect(out).toContain("npm-shrinkwrap.json missing under LLM_GATEWAY_REQUIRE_SHRINKWRAP=1");
    // And it must not have created one while refusing.
    expect(existsSync(join(ROOT, "npm-shrinkwrap.json"))).toBe(false);
  });

  it("says out loud what the dev mode does NOT check", () => {
    // The mode exists so the gate can pass; it must not read afterwards as
    // though parity had been verified. An unasserted figure reads as coverage.
    expect(source).toContain("PARITY AGAINST A COMMITTED FILE IS NOT CHECKED IN THIS MODE");
  });

  it("installs exactly one EXIT trap, so the cleanups compose", () => {
    // Three `trap ... EXIT` calls did not compose: each REPLACED the last, so
    // the generated shrinkwrap would have been stranded by the temp-file trap
    // set three lines later, and again by the pack step's trap. A stranded
    // shrinkwrap is not litter: npm treats a present one as the authoritative
    // lockfile for every later install in the checkout.
    const traps = source.split("\n").filter(l => /^\s*trap\s/.test(l));
    expect(traps, traps.join(" | ")).toHaveLength(1);
    expect(traps[0]).toContain("cleanup_audit_temporaries");
  });

  it("removes a shrinkwrap it generated, on the failure path too", () => {
    const handler = source.slice(
      source.indexOf("cleanup_audit_temporaries() {"),
      source.indexOf("trap cleanup_audit_temporaries EXIT")
    );
    for (const cleaned of ["EXPECTED_SHRINKWRAP", "TMP_DIR", "npm-shrinkwrap.json"]) {
      expect(handler, cleaned).toContain(cleaned);
    }
    // Only ever its own: a shrinkwrap the caller supplied must survive.
    expect(handler).toContain('[ "${SHRINKWRAP_MADE_HERE}" = "1" ] && rm -f npm-shrinkwrap.json');
  });
});

describe("every release path asks for the strict mode", () => {
  // Derived from the tree, not from a list: any workflow that runs the audit or
  // the gate is a release path and must opt in, or the dev mode silently
  // becomes the release mode. A new workflow added without it fails here.
  const callers = [
    ".github/workflows/ci.yml",
    ".github/workflows/npm-publish.yml",
    ".github/workflows/release-tag-publish.yml",
    "scripts/pre-release.sh",
  ];

  it.each(callers)("%s sets LLM_GATEWAY_REQUIRE_SHRINKWRAP", file => {
    expect(readFileSync(join(ROOT, file), "utf8")).toContain("LLM_GATEWAY_REQUIRE_SHRINKWRAP");
  });

  it("finds no OTHER caller of the audit or the gate that skips it", () => {
    const tracked = execFileSync("git", ["ls-files", ".github/workflows", "scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const missing = tracked.filter(file => {
      if (callers.includes(file)) return false;
      if (file.endsWith(".test.mjs")) return false;
      const text = readFileSync(join(ROOT, file), "utf8");
      const invokes =
        /^\s*-?\s*run:\s*npm run (security:audit|check)\b/m.test(text) ||
        /^\s*npm run (security:audit|check)\b/m.test(text);
      return invokes && !text.includes("LLM_GATEWAY_REQUIRE_SHRINKWRAP");
    });
    expect(missing, `these run the gate without the strict flag: ${missing.join(", ")}`).toEqual(
      []
    );
  });
});
