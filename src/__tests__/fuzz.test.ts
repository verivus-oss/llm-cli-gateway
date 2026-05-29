import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCodexJsonStream } from "../codex-json-parser.js";
import { parseGeminiJson, parseGeminiStreamJson } from "../gemini-json-parser.js";
import { parseProcStat, parseVmRss } from "../process-monitor.js";
import { sanitizeCliArgValues } from "../request-helpers.js";
import { parseStreamJson, type StreamJsonResult } from "../stream-json-parser.js";

const FUZZ_RUNS = Number.parseInt(process.env.FUZZ_RUNS ?? "200", 10);
const FUZZ_OPTIONS = {
  numRuns: Number.isFinite(FUZZ_RUNS) && FUZZ_RUNS > 0 ? FUZZ_RUNS : 200,
};

const jsonScalar = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null)
);

const jsonObject = fc.dictionary(fc.string({ minLength: 1, maxLength: 32 }), jsonScalar, {
  maxKeys: 8,
});

const streamEventLine = fc
  .record(
    {
      type: fc.oneof(
        fc.constantFrom("system", "assistant", "result", "error", "turn.completed"),
        fc.string({ maxLength: 32 })
      ),
      subtype: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
      result: fc.option(jsonScalar, { nil: undefined }),
      total_cost_usd: fc.option(jsonScalar, { nil: undefined }),
      duration_api_ms: fc.option(jsonScalar, { nil: undefined }),
      is_error: fc.option(jsonScalar, { nil: undefined }),
      num_turns: fc.option(jsonScalar, { nil: undefined }),
      session_id: fc.option(jsonScalar, { nil: undefined }),
      model: fc.option(jsonScalar, { nil: undefined }),
      usage: fc.option(jsonObject, { nil: undefined }),
      stats: fc.option(jsonObject, { nil: undefined }),
      message: fc.option(
        fc.record({
          role: fc.option(jsonScalar, { nil: undefined }),
          content: fc.option(fc.array(jsonObject, { maxLength: 8 }), { nil: undefined }),
          model: fc.option(jsonScalar, { nil: undefined }),
        }),
        { nil: undefined }
      ),
      item: fc.option(jsonObject, { nil: undefined }),
      error: fc.option(fc.oneof(jsonScalar, jsonObject), { nil: undefined }),
    },
    { requiredKeys: ["type"] }
  )
  .map(event => JSON.stringify(event));

const mixedJsonl = fc
  .array(fc.oneof(fc.string({ maxLength: 160 }), fc.json(), streamEventLine), { maxLength: 40 })
  .map(lines => lines.join("\n"));

function assertStreamResultShape(result: StreamJsonResult): void {
  expect(typeof result.text).toBe("string");
  expect(result.costUsd === null || Number.isFinite(result.costUsd)).toBe(true);
  expect(result.sessionId === null || typeof result.sessionId === "string").toBe(true);
  expect(result.model === null || typeof result.model === "string").toBe(true);
  expect(result.durationApiMs === null || Number.isFinite(result.durationApiMs)).toBe(true);
  expect(typeof result.isError).toBe("boolean");
  expect(result.numTurns === null || Number.isFinite(result.numTurns)).toBe(true);
  if (result.usage) {
    expect(Number.isFinite(result.usage.inputTokens)).toBe(true);
    expect(Number.isFinite(result.usage.outputTokens)).toBe(true);
    expect(Number.isFinite(result.usage.cacheReadInputTokens)).toBe(true);
    expect(Number.isFinite(result.usage.cacheCreationInputTokens)).toBe(true);
  }
}

describe("fuzzing integration", () => {
  it("fuzzes provider JSON/JSONL parsers without throwing or leaking invalid result shapes", () => {
    fc.assert(
      fc.property(mixedJsonl, stdout => {
        assertStreamResultShape(parseStreamJson(stdout));

        const codex = parseCodexJsonStream(stdout);
        expect(codex.threadId === undefined || typeof codex.threadId === "string").toBe(true);
        expect(codex.error === undefined || typeof codex.error === "string").toBe(true);
        expect(codex.finalMessage === undefined || typeof codex.finalMessage === "string").toBe(
          true
        );
        if (codex.usage) {
          expect(Number.isFinite(codex.usage.input_tokens)).toBe(true);
          expect(Number.isFinite(codex.usage.output_tokens)).toBe(true);
        }

        const geminiJson = parseGeminiJson(stdout);
        if (geminiJson) {
          expect(geminiJson.response === undefined || typeof geminiJson.response === "string").toBe(
            true
          );
        }

        const geminiStream = parseGeminiStreamJson(stdout);
        if (geminiStream) {
          expect(
            geminiStream.response === undefined || typeof geminiStream.response === "string"
          ).toBe(true);
        }
      }),
      FUZZ_OPTIONS
    );
  });

  it("fuzzes Linux proc parsers without returning NaN process metrics", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), content => {
        const proc = parseProcStat(content);
        if (proc) {
          expect(typeof proc.state).toBe("string");
          expect(Number.isFinite(proc.utime)).toBe(true);
          expect(Number.isFinite(proc.stime)).toBe(true);
        }

        const rss = parseVmRss(content);
        expect(rss === null || Number.isFinite(rss)).toBe(true);
      }),
      FUZZ_OPTIONS
    );
  });

  it("fuzzes CLI argument sanitizer so dash-prefixed values are always rejected", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 80 }), { maxLength: 20 }), values => {
        const hasUnsafeValue = values.some(value => value.startsWith("-"));
        if (hasUnsafeValue) {
          expect(() => sanitizeCliArgValues(values, "fuzz")).toThrow(/must not start with "-"/);
        } else {
          expect(sanitizeCliArgValues(values, "fuzz")).toBe(values);
        }
      }),
      FUZZ_OPTIONS
    );
  });
});
