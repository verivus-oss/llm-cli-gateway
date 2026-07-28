// The idle timeout must agree with each provider's probed output discipline.
//
// A hand-maintained table previously gave gemini, mistral and cursor a 600000ms
// "idle" timeout with comments asserting they "stream in real-time". Their own
// registry evidence says the opposite: outputDiscipline.streaming is
// "terminal-burst", meaning stdout stays at zero bytes until the process exits
// under the default invocation. Cursor streams under outputFormat stream-json,
// which resolveIdleTimeout does not currently distinguish (see #259).
// An idle timer that never resets is a wall-clock cap, and it killed a real
// cross-LLM review job at exactly 600000ms of "inactivity" while that job was
// perfectly healthy.
//
// These tests pin the invariant rather than a magic number: whatever the
// registry says about a provider, the resolved timeout has to match it.

import { describe, it, expect } from "vitest";
import { CLI_TYPES, type CliType } from "../provider-types.js";
import { getProviderDefinition } from "../provider-definitions.js";
import { resolveIdleTimeout } from "../index.js";

function isTerminalBurst(cli: CliType): boolean {
  return getProviderDefinition(cli).outputDiscipline?.streaming === "terminal-burst";
}

describe("idle timeout policy vs probed output discipline", () => {
  it("every provider declares an output discipline", () => {
    for (const cli of CLI_TYPES) {
      const streaming = getProviderDefinition(cli).outputDiscipline?.streaming;
      expect(streaming, `${cli} has no outputDiscipline.streaming`).toBeDefined();
      expect(["incremental", "terminal-burst"]).toContain(streaming);
    }
  });

  it("records which providers cannot be governed by an idle timer", () => {
    // Guards the assumption the fix rests on. If a discipline is re-probed and
    // changes, this fails and the timeout policy gets revisited rather than
    // silently drifting back out of agreement with reality.
    expect(CLI_TYPES.filter(isTerminalBurst).sort()).toEqual([
      "cursor",
      "devin",
      "gemini",
      "mistral",
    ]);
  });

  it("never resolves a 10 minute default for a provider that emits nothing until exit", () => {
    for (const cli of CLI_TYPES.filter(isTerminalBurst)) {
      const resolved = resolveIdleTimeout(cli);
      expect(
        resolved,
        `${cli} resolved no bound at all; a hung child would run forever`
      ).toBeDefined();
      expect(
        resolved,
        `${cli} still resolves ${resolved}ms, which its zero-byte output makes a wall-clock cap`
      ).toBeGreaterThan(600_000);
    }
  });

  it("keeps the streaming providers on a genuine idle timeout", () => {
    for (const cli of CLI_TYPES.filter(c => !isTerminalBurst(c))) {
      // claude/codex/grok do emit progress, so 10 minutes of true silence is a
      // meaningful stall signal for them.
      expect(resolveIdleTimeout(cli), `${cli} lost its idle timeout`).toBe(600_000);
    }
  });

  it("always honours an explicit caller override", () => {
    for (const cli of CLI_TYPES) {
      expect(resolveIdleTimeout(cli, 45_000), `${cli} ignored an explicit idleTimeoutMs`).toBe(
        45_000
      );
    }
  });
});
