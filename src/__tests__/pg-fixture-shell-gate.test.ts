/**
 * The gate in scripts/test-pg.sh, executed.
 *
 * Round 6, from two reviewers independently: nothing in the tree drove that
 * script, so the whole gate could be deleted with `npm test` still green. Every
 * assertion about it was a claim in a report. This runs the SHIPPED TEXT of the
 * block, extracted from the script rather than retyped, against a producer the
 * test controls. Retyping it would be the round-5 defect again: a test that
 * asserts on a private copy of the thing it claims to test.
 *
 * No PostgreSQL server and no container are involved. The block ends at `eval`,
 * which is the decision under test.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = "scripts/test-pg.sh";
const BLOCK_START = "unset FIXTURE_HOST";
const BLOCK_END = 'eval "${fixture_env}"';
const PRODUCER_CALL = "node scripts/pg-fixture.mjs --print-env";

/** The gate exactly as shipped, with only the producer swapped for a stub. */
function extractGate(): string {
  const script = readFileSync(SCRIPT, "utf8");
  const start = script.indexOf(BLOCK_START);
  const end = script.indexOf(BLOCK_END);
  // If the block is renamed or removed, this test fails rather than passing
  // vacuously against an empty string.
  expect(start, `${SCRIPT} no longer contains ${BLOCK_START}`).toBeGreaterThanOrEqual(0);
  expect(end, `${SCRIPT} no longer contains the eval the gate protects`).toBeGreaterThan(start);
  const block = script.slice(start, end + BLOCK_END.length);
  expect(block, "the gate no longer calls the producer").toContain(PRODUCER_CALL);
  return block.replace(PRODUCER_CALL, '"$FAKE_PRODUCER"');
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pg-fixture-gate-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  accepted: boolean;
  port: string;
  sideEffect: boolean;
}

/**
 * Run the gate with `producer` standing in for pg-fixture.mjs.
 * `inherited` seeds the environment, which is how a stale value gets in.
 */
function runGate(producer: string, inherited: Record<string, string> = {}): Outcome {
  const producerPath = join(dir, "producer.sh");
  const witness = join(dir, "witness");
  rmSync(witness, { force: true });
  writeFileSync(producerPath, `#!/usr/bin/env bash\n${producer}\n`);
  chmodSync(producerPath, 0o755);

  // On acceptance the gate has eval'd the assignments, so echoing FIXTURE_PORT
  // reports the value the rest of the script would have used.
  const harness = `set -euo pipefail\nFAKE_PRODUCER=${JSON.stringify(producerPath)}\n${extractGate()}\necho "ACCEPTED:\${FIXTURE_PORT}"\n`;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["-c", harness], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WITNESS: witness, ...inherited },
    });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }
  const match = /ACCEPTED:(.*)/.exec(stdout);
  let sideEffect = false;
  try {
    readFileSync(witness);
    sideEffect = true;
  } catch {
    sideEffect = false;
  }
  return { accepted: match !== null, port: match?.[1] ?? "", sideEffect };
}

const REAL = "node scripts/pg-fixture.mjs --print-env";

describe("the shell gate in scripts/test-pg.sh", () => {
  it("accepts the real producer and adopts its port", () => {
    const result = runGate(REAL);
    expect(result.accepted).toBe(true);
    expect(result.port).toBe("5433");
  });

  it("refuses a producer that omits a name, even when the shell already has it", () => {
    // THE case the `unset` exists for. Without it the stale 9999 survives, the
    // `:?` guards all pass because the name is set, and the suite runs against
    // whatever is listening on the inherited port. The gate must not merely
    // refuse; it must refuse rather than silently adopting 9999.
    const producer = `${REAL} | grep -v '^FIXTURE_PORT='`;
    const result = runGate(producer, { FIXTURE_PORT: "9999" });
    expect(result.accepted).toBe(false);
    expect(result.port).not.toBe("9999");
  });

  it("refuses an extra assignment the caller did not expect", () => {
    expect(runGate(`${REAL}; echo "FIXTURE_EXTRA='x'"`).accepted).toBe(false);
  });

  it("refuses a duplicate that would silently override the canonical value", () => {
    // Shape alone accepts this: both lines are well formed. Only the exact-set
    // comparison catches the second FIXTURE_PORT winning at eval.
    const result = runGate(`${REAL}; echo "FIXTURE_PORT='9999'"`);
    expect(result.accepted).toBe(false);
    expect(result.port).not.toBe("9999");
  });

  it("refuses a regex-legal name that is not in the expected set", () => {
    expect(runGate(`${REAL} | sed "s/^FIXTURE_HOST=/FIXTURE_HOSTNAME=/"`).accepted).toBe(false);
  });

  it("does not execute a command the producer smuggles into its output", () => {
    // The gate replaced `eval "$(node ...)"`, under which any stdout at all was
    // executed as shell before anything looked at it.
    const result = runGate(`${REAL}; echo 'touch "$WITNESS"'`);
    expect(result.accepted).toBe(false);
    expect(result.sideEffect, "the smuggled command ran").toBe(false);
  });

  it("refuses a command appended to an otherwise correct assignment", () => {
    // The name comparison CANNOT catch this: `sed "s/=.*//"` strips everything
    // from the first `=`, so `FIXTURE_HOST='x' ; touch ...` reduces to the
    // expected name `FIXTURE_HOST` and the expected set matches exactly. Only
    // the line-shape check refuses it. Mutation-probing this file is what
    // found the omission: deleting the shape check failed nothing until this
    // case existed, which made the two checks look redundant when they are not.
    const result = runGate(
      `${REAL} | sed "s|^FIXTURE_HOST=\\(.*\\)|FIXTURE_HOST=\\1 ; touch \\"$WITNESS\\"|"`
    );
    expect(result.accepted).toBe(false);
    expect(result.sideEffect, "the appended command ran").toBe(false);
  });

  it("refuses a value carrying an unescaped quote that would reopen quoting", () => {
    // Also passes the name comparison, for the same reason.
    const result = runGate(`${REAL} | sed "s|^FIXTURE_DB=.*|FIXTURE_DB='a'\\"'\\"'b'|"`);
    expect(result.accepted).toBe(false);
  });

  it("refuses a producer that prints assignments and THEN fails", () => {
    // `set -e` sees eval's own status, not the command substitution's, so this
    // shape used to leave the assignments in place and carry on.
    expect(runGate(`${REAL}; exit 1`).accepted).toBe(false);
  });

  it("refuses a producer that prints nothing", () => {
    const result = runGate("true", { FIXTURE_PORT: "9999" });
    expect(result.accepted).toBe(false);
    expect(result.port).not.toBe("9999");
  });

  it("refuses a stray warning printed alongside correct assignments", () => {
    expect(runGate(`echo "warning: something" >&1; ${REAL}`).accepted).toBe(false);
  });
});

/**
 * The guide drifted from the script in every round that touched either, and in
 * round 6 both reviewers found the same three contradictions independently:
 * Compose listed as a prerequisite, the runtime order reversed, and a suite
 * table naming two of eight files with counts that were already wrong.
 *
 * Prose cannot be kept true by remembering to update it. These are the claims
 * that actually drifted, asserted against the code they describe.
 */
describe("the testing guide against the script it documents", () => {
  const guide = (): string => readFileSync("docs/guides/TESTING_GUIDE.md", "utf8");
  const script = (): string => readFileSync(SCRIPT, "utf8");

  it("documents the runtime probe order the script really uses", () => {
    // `for candidate in podman docker` is the code. The guide said the reverse
    // for as long as the guide existed.
    const order = /for candidate in ([a-z]+) ([a-z]+); do/.exec(script());
    expect(order, "the script no longer probes for a container runtime").not.toBeNull();
    const [, first, second] = order as RegExpExecArray;
    expect(first).toBe("podman");
    expect(guide()).toContain(`auto-detect (\`${first}\`, then \`${second}\`)`);
  });

  it("does not ask the reader for a Compose provider the script never invokes", () => {
    // The script calls run/exec/rm directly. Its COMMENTS discuss compose, at
    // length, because explaining why it was removed is the point of them; the
    // executable lines must not invoke it.
    const code = script()
      .split("\n")
      .filter(line => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\bcompose\b/i);
    const prerequisites = guide().slice(0, guide().indexOf("## Quick Start"));
    expect(prerequisites).not.toMatch(/Compose (support|file)|with Compose/i);
  });

  it("names every PostgreSQL suite the script will actually run", () => {
    // The script discovers them with `find`, so adding a file silently adds a
    // suite. This is what makes the table fail rather than go quietly stale.
    const files = readdirSync("src/__tests__").filter(f => f.endsWith("-pg.test.ts"));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      expect(guide(), `${file} is not in the guide's suite table`).toContain(file);
    }
  });

  it("carries no hand-maintained test counts, which is what went stale", () => {
    const table = guide().slice(
      guide().indexOf("## Test Suites"),
      guide().indexOf("## Running Tests")
    );
    expect(table).not.toMatch(/\|\s*\d+\s*\|/);
  });
});
