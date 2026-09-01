/**
 * Can `npm run check` reach its own last step?
 *
 * It could not. The shrinkwrap is generated at pack time and never committed,
 * `security:audit` hard-failed on its absence, and the steps are `&&`-chained,
 * so on a clean developer tree the gate exited 1 every time and
 * `verify:no-internal-mcp:check` never ran at all. Both halves matter: a gate
 * whose exit code is constant carries no signal, and this one was also hiding a
 * release invariant behind the constant.
 *
 * These tests are about the CHAIN and the MODES, not about the audit's content.
 * Running the audit itself packs a tarball and installs it, which belongs in the
 * release path rather than in every suite run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const steps = pkg.scripts.check.split("&&").map(s => s.trim());

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

describe("the check chain", () => {
  it("puts security:audit before at least one further step", () => {
    // If this ever becomes the LAST step the regression below stops being
    // reachable, and this test should be deleted rather than quietly passing.
    const at = steps.findIndex(s => s.includes("security:audit"));
    expect(at, "security:audit is not in the check chain").toBeGreaterThanOrEqual(0);
    expect(steps.length - 1, "security:audit is now last; this suite is moot").toBeGreaterThan(at);
  });

  it("names the step that a constant failure used to hide", () => {
    // Named explicitly, because the defect was invisible: the hidden step
    // passes on its own, so nothing ever surfaced that it was not running.
    const at = steps.findIndex(s => s.includes("security:audit"));
    expect(steps.slice(at + 1).join(" ")).toContain("verify:no-internal-mcp:check");
  });
});

describe("the shrinkwrap step has two modes", () => {
  const audit = join(ROOT, "scripts", "release-security-audit.sh");
  const source = readFileSync(audit, "utf8");
  const shrinkwrap = join(ROOT, "npm-shrinkwrap.json");

  it.skipIf(existsSync(shrinkwrap))(
    "refuses a missing shrinkwrap under LLM_GATEWAY_REQUIRE_SHRINKWRAP=1",
    () => {
      // Release callers generate the shrinkwrap after the test step. A normal
      // clean checkout therefore exercises the actual strict refusal here.
      const { code, out } = run(["bash", audit], { LLM_GATEWAY_REQUIRE_SHRINKWRAP: "1" });
      expect(code).not.toBe(0);
      expect(out).toContain("npm-shrinkwrap.json missing under LLM_GATEWAY_REQUIRE_SHRINKWRAP=1");
      expect(existsSync(shrinkwrap)).toBe(false);
    }
  );

  it("checks strict release input before network-backed audit work", () => {
    const strictAt = source.indexOf("npm-shrinkwrap.json missing under");
    const networkAuditAt = source.indexOf('echo "==> npm vulnerability audit"');
    expect(strictAt).toBeGreaterThanOrEqual(0);
    expect(networkAuditAt).toBeGreaterThanOrEqual(0);
    expect(strictAt).toBeLessThan(networkAuditAt);
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
    for (const cleaned of ["EXPECTED_SHRINKWRAP", "TMP_DIR", "SHRINKWRAP_PATH"]) {
      expect(handler, cleaned).toContain(cleaned);
    }
    // Only ever its own: a shrinkwrap the caller supplied must survive.
    expect(handler).toContain('[ "${SHRINKWRAP_MADE_HERE}" = "1" ] && rm -f "${SHRINKWRAP_PATH}"');
    const shrinkwrapAt = source.indexOf('SHRINKWRAP_PATH="${ROOT_DIR}/npm-shrinkwrap.json"');
    const cleanupAt = source.indexOf("cleanup_audit_temporaries() {");
    expect(shrinkwrapAt).toBeGreaterThanOrEqual(0);
    expect(cleanupAt).toBeGreaterThanOrEqual(0);
    expect(shrinkwrapAt).toBeLessThan(cleanupAt);
  });

  it("serializes fixed-path generation and arms cleanup before writing", () => {
    const lockAt = source.indexOf("flock 9");
    const trapAt = source.indexOf("trap cleanup_audit_temporaries EXIT");
    const ownershipAt = source.indexOf("SHRINKWRAP_MADE_HERE=1");
    const generationAt = source.indexOf("node scripts/make-prod-shrinkwrap.mjs >/dev/null");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(trapAt).toBeGreaterThan(lockAt);
    expect(ownershipAt).toBeGreaterThan(trapAt);
    expect(generationAt).toBeGreaterThan(ownershipAt);
  });

  it("compares the packed shrinkwrap with the audited projection", () => {
    const packAt = source.indexOf('PACKAGE_TGZ="$(npm pack');
    const extractAt = source.indexOf('tar -xOf "${TMP_DIR}/${PACKAGE_TGZ}"');
    const compareAt = source.indexOf(
      'cmp -s "${EXPECTED_SHRINKWRAP}" "${TMP_DIR}/packed-npm-shrinkwrap.json"'
    );
    expect(packAt).toBeGreaterThanOrEqual(0);
    expect(extractAt).toBeGreaterThan(packAt);
    expect(compareAt).toBeGreaterThan(extractAt);
  });
});

describe("every release path asks for the strict mode", () => {
  const releaseInvocation =
    /(?:^|\s)(?:npm run (?:security:audit|check)\b|(?:bash|sh)\s+scripts\/release-security-audit\.sh\b|\.\/scripts\/release-security-audit\.sh\b)/;

  function workflowStep(lines, invocationAt) {
    const invocationIndent = lines[invocationAt].search(/\S/);
    let start = invocationAt;
    let stepIndent = invocationIndent;
    for (let index = invocationAt; index >= 0; index -= 1) {
      const match = /^(\s*)-\s+(?:name|run|uses):/.exec(lines[index]);
      if (match && match[1].length < invocationIndent) {
        start = index;
        stepIndent = match[1].length;
        break;
      }
    }
    let end = start + 1;
    while (end < lines.length) {
      const nextIndent = lines[end].search(/\S/);
      if (nextIndent >= 0 && nextIndent < stepIndent && !lines[end].trimStart().startsWith("#")) {
        break;
      }
      const match = /^(\s*)-\s+(?:name|run|uses):/.exec(lines[end]);
      if (match && match[1].length <= stepIndent) break;
      end += 1;
    }
    return lines.slice(start, end).join("\n");
  }

  // Derived per invocation, not per file. A second unflagged step in an
  // existing workflow must fail even when another step in that file is strict.
  it("binds the strict flag to every audit or release-gate invocation", () => {
    const tracked = execFileSync("git", ["ls-files", ".github/workflows", "scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        file => file && !file.endsWith(".test.mjs") && !file.endsWith("release-security-audit.sh")
      );
    const invocations = [];
    const missing = [];

    for (const file of tracked) {
      const lines = readFileSync(join(ROOT, file), "utf8").split(/\r?\n/);
      const isWorkflow = file.endsWith(".yml") || file.endsWith(".yaml");
      for (let index = 0; index < lines.length; index += 1) {
        const invokes = isWorkflow
          ? releaseInvocation.test(lines[index])
          : /^\s*(?:npm run (?:security:audit|check)\b|(?:bash|sh)\s+scripts\/release-security-audit\.sh\b|\.\/scripts\/release-security-audit\.sh\b)/.test(
              lines[index]
            );
        if (lines[index].trimStart().startsWith("#") || !invokes) continue;
        invocations.push(file);

        let context;
        if (isWorkflow) {
          context = workflowStep(lines, index);
          const executableContext = context
            .split("\n")
            .filter(line => !line.trimStart().startsWith("#"))
            .join("\n");
          if (!/LLM_GATEWAY_REQUIRE_SHRINKWRAP:\s*["']?1\b/.test(executableContext)) {
            missing.push(`${file} -> ${lines[index].trim()}`);
          }
        } else {
          context = lines.slice(Math.max(0, index - 5), index + 1).join("\n");
          if (!/(?:export\s+)?LLM_GATEWAY_REQUIRE_SHRINKWRAP=1\b/.test(context)) {
            missing.push(`${file} -> ${lines[index].trim()}`);
          }
        }
      }
    }

    expect(invocations.length, "no release audit or gate invocation was found").toBeGreaterThan(0);
    expect(missing, `these invocations lack a bound strict flag: ${missing.join(", ")}`).toEqual(
      []
    );
  });

  it("recognizes a command inside a multiline workflow run step", () => {
    const lines = [
      "      - name: release gate",
      "        env:",
      '          LLM_GATEWAY_REQUIRE_SHRINKWRAP: "1"',
      "        run: |",
      "          npm run check",
      "      - run: echo done",
    ];
    expect(workflowStep(lines, 4)).toContain("LLM_GATEWAY_REQUIRE_SHRINKWRAP");
    expect(workflowStep(lines, 4)).not.toContain("echo done");
  });

  it("recognizes named steps and every supported audit shell spelling", () => {
    for (const line of [
      "        run: npm run security:audit",
      "        run: npm run check",
      "        run: bash scripts/release-security-audit.sh",
      "          sh scripts/release-security-audit.sh",
      "          ./scripts/release-security-audit.sh",
    ]) {
      expect(releaseInvocation.test(line), line).toBe(true);
    }
  });

  it("does not let a following job provide the current step's strict flag", () => {
    const lines = [
      "      - run: npm run check",
      "",
      "  next-job:",
      "    env:",
      '      LLM_GATEWAY_REQUIRE_SHRINKWRAP: "1"',
      "    steps:",
      "      - run: echo done",
    ];
    expect(workflowStep(lines, 0)).toBe("      - run: npm run check\n");
  });
});
