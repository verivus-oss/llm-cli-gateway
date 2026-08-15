import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertUpstreamCliArgs } from "../upstream-contracts.js";

// Issue #270: cursor and devin failed deterministically on every review seat.
//
// cursor: the review argv never contained --trust, so cursor refused with
//   "Workspace Trust Required". Made deterministic by the neutral temp cwd,
//   which can never be in trusted_folders.toml.
// devin:  --sandbox is emitted unconditionally and resolves through bubblewrap.
//   Without bwrap it failed at spawn, and nothing probed for it.

function orchestrator(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "validation-orchestrator.ts"),
    "utf8"
  );
}

describe("issue #270: cursor trust and devin sandbox prerequisites", () => {
  it("cursor review argv includes --trust", () => {
    const src = orchestrator();
    // Slice to the NEXT arm rather than a fixed length: the explanatory
    // comment is long, and a fixed window silently missed the flag it was
    // meant to assert on.
    const arm = src.slice(src.indexOf('provider === "cursor"'), src.indexOf('provider === "codex"'));
    expect(arm).toContain('"--trust"');
  });

  it("cursor --trust is review-only, not granted for ordinary asks", () => {
    // An `ask` is not a review; granting trust there would widen the change
    // beyond the defect.
    const src = orchestrator();
    const arm = src.slice(src.indexOf('provider === "cursor"'), src.indexOf('provider === "codex"'));
    expect(arm).toMatch(/review \? \["--trust"\]|\.\.\.\(review \? \["--trust"\]/);
  });

  it("--trust is a real cursor flag that passes argv admission", () => {
    // Guards against emitting a flag the contract would reject at admission,
    // which would replace one deterministic failure with another.
    expect(() =>
      assertUpstreamCliArgs("cursor", [
        "--print",
        "--mode",
        "plan",
        "--sandbox",
        "enabled",
        "--trust",
        "review this",
      ])
    ).not.toThrow();
  });

  it("devin refuses up front when bubblewrap is absent", () => {
    const src = orchestrator();
    const arm = src.slice(src.indexOf('provider === "devin"'), src.indexOf('provider === "cursor"'));
    expect(arm).toContain("hasBubblewrap()");
    expect(arm).toContain("CliInvalidInputError");
  });

  it("devin does NOT drop --sandbox to make itself run", () => {
    // The tempting wrong fix. A review that asked for isolation and silently
    // ran without it is a worse outcome than a skipped provider.
    const src = orchestrator();
    const arm = src.slice(src.indexOf('provider === "devin"'), src.indexOf('provider === "cursor"'));
    expect(arm).toContain('"--sandbox"');
  });

  it("the bubblewrap probe is cached, not run per invocation", () => {
    const src = orchestrator();
    expect(src).toContain("bubblewrapAvailable");
    expect(src).toMatch(/bubblewrapAvailable === null/);
  });
});
