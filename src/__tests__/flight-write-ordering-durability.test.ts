import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlightRecorder, type FlightLogResult } from "../flight-recorder.js";

// s6, design 3.4: the failure modes an in-process queue cannot cover, driven
// against a real database rather than a mock. Revision 1 proposed that queue
// and called it sufficient; these are the cases that withdrew it.
//
// Several tests here are CHARACTERISATIONS, not guarantees. They pin what the
// recorder does today, including where it loses a write, so s7 has a target
// with a number on it instead of a paragraph. Each says so on its own line.

const SRC = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, "");

function completion(
  response: string,
  status: "completed" | "failed" = "completed"
): FlightLogResult {
  return {
    response,
    durationMs: 7,
    retryCount: 0,
    circuitBreakerState: "closed",
    optimizationApplied: false,
    exitCode: status === "completed" ? 0 : 1,
    status,
  };
}

/**
 * Run one logStart in a child process and SIGKILL it from inside, so nothing
 * drains, nothing closes, and no shutdown hook runs. Node 24 executes the
 * recorder's TypeScript directly; the resolver hook only maps the tree's `.js`
 * import specifiers onto their `.ts` sources.
 */
function crashAfterLogStart(dir: string, dbPath: string, correlationId: string): void {
  const hooks = join(dir, "hooks.mjs");
  const register = join(dir, "register.mjs");
  const child = join(dir, "child.ts");
  writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
       if (/^\\.{1,2}\\//.test(specifier) && specifier.endsWith(".js")) {
         try { return await next(specifier.slice(0, -3) + ".ts", context); } catch { /* real .js */ }
       }
       return next(specifier, context);
     }\n`
  );
  writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(hooks)}, import.meta.url);\n`
  );
  writeFileSync(
    child,
    `const { FlightRecorder } = await import(${JSON.stringify(join(SRC, "flight-recorder.ts"))});
     const fr = new FlightRecorder(process.argv[2]);
     fr.logStart({ correlationId: process.argv[3], cli: "claude", model: "opus", prompt: "crash me" });
     process.kill(process.pid, "SIGKILL");\n`
  );
  const run = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", register, child, dbPath, correlationId],
    { encoding: "utf8" }
  );
  expect(run.signal).toBe("SIGKILL");
}

describe("flight write ordering across processes and restarts (s6, design 3.4)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s6-write-ordering-"));
    dbPath = join(dir, "logs.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a SIGKILL after logStart leaves a durable started row a new process can complete", () => {
    crashAfterLogStart(dir, dbPath, "crash-1");

    const restarted = new FlightRecorder(dbPath);
    try {
      const orphan = restarted.readRequestById("crash-1");
      expect(orphan?.status).toBe("started");
      expect(orphan?.response).toBeNull();

      // The point of the durable start row: a restarted process can attach the
      // completion the dead one never wrote.
      restarted.logComplete("crash-1", completion("recovered by the next process"));
      const settled = restarted.readRequestById("crash-1");
      expect(settled?.status).toBe("completed");
      expect(settled?.response).toBe("recovered by the next process");
    } finally {
      restarted.close();
    }
  });

  it("a second recorder instance completes the first instance's started row", () => {
    const instanceA = new FlightRecorder(dbPath);
    const instanceB = new FlightRecorder(dbPath);
    try {
      instanceA.logStart({ correlationId: "orphan-1", cli: "codex", model: "gpt", prompt: "p" });
      // The #139 sweep: another gateway instance owns the completion for a job
      // whose start row it never wrote. An in-process queue cannot see this.
      instanceB.logComplete("orphan-1", completion("orphaned by instance B", "failed"));

      const row = instanceB.readRequestById("orphan-1");
      expect(row?.status).toBe("failed");
      expect(row?.response).toBe("orphaned by instance B");
      // Not duplicated: the writer that never saw the start row updated it in
      // place, and the instance that DID write the start row reads the same one.
      expect(instanceA.readRequestById("orphan-1")?.response).toBe("orphaned by instance B");
    } finally {
      instanceA.close();
      instanceB.close();
    }
  });

  it("a completion with no start row changes nothing and loses the response", () => {
    const recorder = new FlightRecorder(dbPath);
    try {
      recorder.logComplete("never-started", completion("this body is dropped"));
      // CHARACTERISATION. Both halves match zero rows and nothing is raised.
      // FlightLogResult carries no cli, model, prompt or start time, so an
      // upsert could not build a valid row either: s7 owes this a side table.
      expect(recorder.readRequestById("never-started")).toBeNull();
    } finally {
      recorder.close();
    }
  });

  it("routing telemetry written before the start row is lost", () => {
    const recorder = new FlightRecorder(dbPath);
    try {
      recorder.recordRouting("route-1", { estCostUsd: 0.5, reason: "cheapest", considered: 3 });
      recorder.logStart({ correlationId: "route-1", cli: "grok", model: "g", prompt: "p" });
      recorder.logComplete("route-1", completion("done"));

      // CHARACTERISATION. recordRouting is a post-hoc update keyed on the
      // request id and is NOT on FlightOwnership's chain, so arriving early it
      // matches nothing and the routing facts are gone for good.
      expect(recorder.readRoutingDecisions(10)).toEqual([]);
      recorder.recordRouting("route-1", { estCostUsd: 0.5, reason: "cheapest", considered: 3 });
      expect(recorder.readRoutingDecisions(10).length).toBe(1);
    } finally {
      recorder.close();
    }
  });

  it("a read issued immediately after logStart observes the row", () => {
    const recorder = new FlightRecorder(dbPath);
    try {
      recorder.logStart({ correlationId: "raw-1", cli: "claude", model: "opus", prompt: "hello" });
      // The reads run on a SEPARATE read-only connection, so this is not a
      // tautology: a reader holding an older snapshot would return null here.
      expect(recorder.readRequestById("raw-1")?.prompt).toBe("hello");
      recorder.logComplete("raw-1", completion("hi"));
      expect(recorder.readRequestById("raw-1")?.response).toBe("hi");
    } finally {
      recorder.close();
    }
  });

  it("a reused correlation id attaches the completion to the first row", () => {
    const recorder = new FlightRecorder(dbPath);
    try {
      recorder.logStart({ correlationId: "dup-1", cli: "claude", model: "opus", prompt: "first" });
      // CHARACTERISATION. The request id is the primary key, so the second
      // flight cannot start. The sinks swallow this, so the caller is told
      // nothing and the later completion lands on the EARLIER request.
      expect(() =>
        recorder.logStart({ correlationId: "dup-1", cli: "grok", model: "g", prompt: "second" })
      ).toThrow();
      recorder.logComplete("dup-1", completion("answer to the second prompt"));

      const row = recorder.readRequestById("dup-1");
      expect(row?.prompt).toBe("first");
      expect(row?.cli).toBe("claude");
      expect(row?.response).toBe("answer to the second prompt");
    } finally {
      recorder.close();
    }
  });

  it("a late second completion refreshes the response and leaves the status monotonic", () => {
    const recorder = new FlightRecorder(dbPath);
    try {
      recorder.logStart({ correlationId: "late-1", cli: "claude", model: "opus", prompt: "p" });
      recorder.logComplete("late-1", completion("partial", "failed"));
      // The deliberate second call: a terminal status can be decided while the
      // child is still flushing. Merge, not no-op, or those bytes are dropped.
      recorder.logComplete("late-1", completion("partial plus the late bytes"));

      const row = recorder.readRequestById("late-1");
      expect(row?.response).toBe("partial plus the late bytes");
      // CHARACTERISATION of the missing fence: status is monotonic because the
      // metadata half is guarded to `started`, but the body is last-writer-wins
      // with no revision, so an out-of-order arrival would win too.
      expect(row?.status).toBe("failed");
      expect(row?.exit_code).toBe(1);
    } finally {
      recorder.close();
    }
  });
});
