import { describe, expect, it } from "vitest";
import { CLI_TYPES, getProviderDefinition } from "../provider-definitions.js";
import { generateProviderCapabilityRows } from "../provider-surface-generator.js";

/**
 * `stdoutBytes: 0` on a running job means two completely different things
 * depending on the provider: "healthy, still accumulating internally" for a
 * terminal-burst CLI, versus "produced nothing yet" for an incremental one.
 * A caller can only tell them apart if the registry declares which is which,
 * so this classification is a load-bearing fact, not documentation.
 *
 * The per-provider values were established by probing each installed CLI under
 * the exact argv the gateway spawns (see each definition's `evidence` string).
 * This is a static ratchet: changing a classification requires re-probing, and
 * the observable behaviour it describes lives in the child process, which no
 * unit test can exercise.
 */
describe("provider output discipline registry fact", () => {
  it("declares a discipline for every CLI provider", () => {
    for (const cli of CLI_TYPES) {
      const discipline = getProviderDefinition(cli).outputDiscipline;
      expect(["incremental", "terminal-burst"]).toContain(discipline.streaming);
      expect(typeof discipline.flushesOnSigterm).toBe("boolean");
      // Evidence must name how the claim was established, so it is re-verifiable.
      expect(discipline.evidence.length).toBeGreaterThan(40);
    }
  });

  it("pins the measured classification of each provider", () => {
    const actual = Object.fromEntries(
      CLI_TYPES.map(cli => {
        const d = getProviderDefinition(cli).outputDiscipline;
        return [cli, `${d.streaming}/${d.flushesOnSigterm ? "flushes" : "no-flush"}`];
      })
    );

    expect(actual).toEqual({
      // Streams token-level stream-json AND flushes pending bytes on SIGTERM,
      // which is the case the cancel-retention fix exists to preserve.
      claude: "incremental/flushes",
      // Streams per jsonl EVENT, so an agentic run advances but a single long
      // message does not.
      codex: "incremental/no-flush",
      grok: "incremental/no-flush",
      // Accumulate the whole answer and write it in one burst at clean exit:
      // a cancel or idle-kill of these retains nothing, by construction.
      gemini: "terminal-burst/no-flush",
      mistral: "terminal-burst/no-flush",
      devin: "terminal-burst/no-flush",
      cursor: "terminal-burst/no-flush",
    });
  });

  it("exposes the discipline on the provider capability surface", () => {
    const rows = generateProviderCapabilityRows();
    const byProvider = new Map(rows.map(r => [r.provider, r]));

    for (const cli of CLI_TYPES) {
      const def = getProviderDefinition(cli);
      const row = byProvider.get(cli);
      expect(row?.outputStreaming).toBe(def.outputDiscipline.streaming);
      expect(row?.flushesOnSigterm).toBe(def.outputDiscipline.flushesOnSigterm);
    }
  });

  it("does not let streamingFormats stand in for the discipline", () => {
    // grok streams plain text with no streaming format engaged, and cursor
    // buffers under the text mode the gateway uses despite shipping a
    // stream-json mode. Either mapping would misclassify a provider, which is
    // why this is a separate fact rather than a projection of streamingFormats.
    const grok = getProviderDefinition("grok");
    expect(grok.streamingFormats).not.toContain("text");
    expect(grok.outputDiscipline.streaming).toBe("incremental");

    const cursor = getProviderDefinition("cursor");
    expect(cursor.streamingFormats).toContain("stream-json");
    expect(cursor.outputDiscipline.streaming).toBe("terminal-burst");
  });

  it("scopes a terminal-burst provider that ships a streaming format to the default argv", () => {
    // A provider can be terminal-burst by default AND expose a streaming
    // output format a caller may opt into (cursor). The classification must
    // say so rather than read as an invariant over every possible argv, or the
    // capability surface is simply false for the opted-in invocation.
    for (const cli of CLI_TYPES) {
      const def = getProviderDefinition(cli);
      if (def.outputDiscipline.streaming !== "terminal-burst") continue;
      if (def.streamingFormats.length === 0) continue;
      expect(def.outputDiscipline.evidence).toMatch(/DEFAULT gateway argv/);
      expect(def.outputDiscipline.evidence).toMatch(/NOT covered by this classification/);
    }
  });
});
