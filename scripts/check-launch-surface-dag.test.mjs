import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLaunchSurfaceDag, DAG_PATH } from "./check-launch-surface-dag.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_FILES = [
  DAG_PATH,
  "src/validation-tools.ts",
  "src/validation-orchestrator.ts",
  "src/workspace-registry.ts",
  "src/review-run-authorization.ts",
];

describe("launch-surface DAG checker", () => {
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "launch-surface-dag-"));
    for (const relative of FIXTURE_FILES) {
      const destination = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(ROOT, relative), destination);
    }
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function mutate(relative, transform) {
    const target = path.join(fixtureRoot, relative);
    const before = readFileSync(target, "utf8");
    const after = transform(before);
    expect(after).not.toBe(before);
    writeFileSync(target, after);
  }

  function problemText() {
    return checkLaunchSurfaceDag({ rootDir: fixtureRoot }).problems.join("\n");
  }

  it("accepts the complete checked map", () => {
    expect(checkLaunchSurfaceDag({ rootDir: fixtureRoot })).toMatchObject({
      problems: [],
      nodesChecked: 17,
      invariantsChecked: 6,
      flowsChecked: 9,
    });
  });

  it("finds a second call hidden on a function declaration line", () => {
    mutate(
      "src/validation-orchestrator.ts",
      source =>
        `${source}\nfunction forgedDispatch() { dispatchProviderJob(undefined, "codex", "", "", {}, {}); }\n`
    );

    expect(problemText()).toContain(
      "invariant dispatchProviderJob: DAG says 1 call(s), source has 2"
    );
  });

  it("rejects a same-count substitution by checking caller identity", () => {
    mutate("src/validation-orchestrator.ts", source => {
      const withoutRealCaller = source.replace(
        "const outcome = dispatchProviderJob(",
        "const outcome = dispatchProviderJobRenamed("
      );
      return `${withoutRealCaller}\nfunction forgedDispatch() { dispatchProviderJob(undefined, "codex", "", "", {}, {}); }\n`;
    });

    expect(problemText()).toContain(
      "invariant dispatchProviderJob: expected callers [launchProviderSeat], found [forgedDispatch]"
    );
  });

  it("rejects removal of the durable persistence hop", () => {
    mutate("src/validation-orchestrator.ts", source =>
      source.replace(
        "...(args.reviewAuthorization ? { reviewAuthorization: args.reviewAuthorization } : {}),",
        "...{},"
      )
    );

    expect(problemText()).toContain(
      'field.trustCursorWorkspace.flow[4]: src/validation-orchestrator.ts:905 no longer carries "reviewAuthorization"'
    );
  });

  it("rejects a node with its coordinate declaration removed", () => {
    mutate(DAG_PATH, source =>
      source.replace(
        'file = "src/validation-tools.ts"\nline = 417',
        'file = "src/validation-tools.ts"'
      )
    );

    expect(problemText()).toContain("node[0].line: missing positive integer");
  });

  it("rejects an invariant with its caller count removed", () => {
    mutate(DAG_PATH, source =>
      source.replace(
        'symbol = "dispatchProviderJob"\ncallers = 1',
        'symbol = "dispatchProviderJob"'
      )
    );

    expect(problemText()).toContain("invariant[0].callers: missing non-negative integer");
  });

  it("rejects deletion of the structured flow", () => {
    mutate(DAG_PATH, source =>
      source.replace("flow_count = 9", "flow_count = 0").replace("flow = [", "removed_flow = [")
    );

    const problems = problemText();
    expect(problems).toContain("meta.flow_count: must remain 9, declared 0");
    expect(problems).toContain("coverage flow_count: requires 9 flow hop(s), parsed 0");
    expect(problems).toContain(
      "field.trustCursorWorkspace.flow: missing non-empty structured flow"
    );
  });
});
