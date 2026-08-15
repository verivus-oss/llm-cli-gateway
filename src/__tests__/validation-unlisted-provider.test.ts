import { describe, expect, it } from "vitest";
import { WorkspaceRegistryError } from "../workspace-registry.js";

// Issue #271: a provider missing from the selected workspace's `providers`
// list must degrade to `skipped`, not abort the whole multi-provider call.
//
// Observed condition: a host with [workspaces] default set, where every
// [[workspaces.repos]] entry lists ["claude","codex","gemini","grok","mistral"]
// and therefore omits cursor and devin. Any validation call including either
// failed outright rather than returning the other reviewers' opinions.
//
// These tests pin the CONTRACT that makes that degradation possible: the error
// is a distinguishable type, and the orchestrator's catch treats it as a
// per-provider skip rather than a call-level failure.

describe("issue #271: an unlisted provider is skipped, not fatal", () => {
  it("WorkspaceRegistryError is instanceof-detectable", () => {
    // The fix keys on `error instanceof WorkspaceRegistryError`. If this class
    // ever stops extending Error, or is re-thrown as a plain Error, the catch
    // silently reverts to aborting the whole call.
    const err = new WorkspaceRegistryError('Workspace "w" does not allow provider "cursor"');
    expect(err).toBeInstanceOf(WorkspaceRegistryError);
    expect(err).toBeInstanceOf(Error);
  });

  it("the orchestrator catch handles WorkspaceRegistryError before rethrowing", () => {
    // Structural assertion against the source: the catch must name
    // WorkspaceRegistryError, and must do so BEFORE the bare `throw error`.
    // A behavioural test would need a full workspace registry plus a live job
    // manager; this pins the specific ordering the defect turned on.
    const src = readOrchestrator();
    const catchStart = src.indexOf("if (isCliInputAdmissionError(error))");
    expect(catchStart).toBeGreaterThan(-1);
    const wre = src.indexOf("error instanceof WorkspaceRegistryError", catchStart);
    const rethrow = src.indexOf("throw error;", src.indexOf("}", wre));
    expect(wre).toBeGreaterThan(catchStart);
    expect(wre).toBeLessThan(rethrow);
  });

  it("the skip reason tells the operator how to fix it", () => {
    const src = readOrchestrator();
    const wre = src.indexOf("error instanceof WorkspaceRegistryError");
    const block = src.slice(wre, wre + 700);
    expect(block).toContain("normalizeSkippedProvider");
    // A skip with no remedy just moves the confusion.
    expect(block).toMatch(/providers\s*` \+|providers list/);
  });
});

function readOrchestrator(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "validation-orchestrator.ts"), "utf8");
}
