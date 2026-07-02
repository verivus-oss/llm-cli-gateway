import { describe, it, expect } from "vitest";
import { parseGeminiJson, parseGeminiStreamJson } from "../gemini-json-parser.js";

describe("parseGeminiJson", () => {
  it("maps usageMetadata fields to the unified usage shape", () => {
    const stdout = JSON.stringify({
      response: "hello",
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 42,
        cachedContentTokenCount: 100,
        totalTokenCount: 192,
      },
    });

    const result = parseGeminiJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("hello");
    expect(result?.usage).toEqual({
      input_tokens: 150,
      output_tokens: 42,
      cache_read_tokens: 100,
    });
  });

  it("omits cache_read_tokens when cachedContentTokenCount is missing", () => {
    const stdout = JSON.stringify({
      response: "hi",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
      },
    });

    const result = parseGeminiJson(stdout);

    expect(result?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it("returns response only when usageMetadata is missing", () => {
    const stdout = JSON.stringify({ response: "no usage" });

    const result = parseGeminiJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("no usage");
    expect(result?.usage).toBeUndefined();
  });

  it("returns null on invalid JSON", () => {
    expect(parseGeminiJson("not json at all")).toBeNull();
    expect(parseGeminiJson("")).toBeNull();
  });

  it("returns null when the parsed value is not an object", () => {
    expect(parseGeminiJson("123")).toBeNull();
    expect(parseGeminiJson("null")).toBeNull();
  });
});

// Phase 4 slice ε: NDJSON event stream emitted by `gemini -p '...' -o stream-json`.
// Real-CLI sample captured 2026-05-27 against gemini 0.42.0:
//   {"type":"init","session_id":"...","model":"auto-gemini-3"}
//   {"type":"message","role":"user","content":"..."}
//   {"type":"message","role":"assistant","content":"4","delta":true}
//   {"type":"result","status":"success","stats":{"input_tokens":...,"output_tokens":...,"cached":...,...}}
describe("parseGeminiStreamJson", () => {
  const buildNdjson = (events: unknown[]): string =>
    events.map(e => JSON.stringify(e)).join("\n") + "\n";

  it("maps stats fields to the unified usage shape and concatenates assistant deltas", () => {
    const stdout = buildNdjson([
      { type: "init", session_id: "abc", model: "auto-gemini-3" },
      { type: "message", role: "user", content: "what is 2+2 just numbers" },
      { type: "message", role: "assistant", content: "The answer ", delta: true },
      { type: "message", role: "assistant", content: "is 4.", delta: true },
      {
        type: "result",
        status: "success",
        stats: {
          input_tokens: 150,
          output_tokens: 42,
          cached: 100,
          total_tokens: 192,
          duration_ms: 1234,
        },
      },
    ]);

    const result = parseGeminiStreamJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("The answer is 4.");
    expect(result?.usage).toEqual({
      input_tokens: 150,
      output_tokens: 42,
      cache_read_tokens: 100,
    });
  });

  it("omits cache_read_tokens when stats.cached is missing", () => {
    const stdout = buildNdjson([
      { type: "message", role: "assistant", content: "hi", delta: true },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 10, output_tokens: 3 },
      },
    ]);

    const result = parseGeminiStreamJson(stdout);

    expect(result?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it("ignores non-JSON banner lines emitted by the CLI before the event stream", () => {
    const stdout = [
      "Warning: True color (24-bit) support not detected.",
      "Ripgrep is not available. Falling back to GrepTool.",
      JSON.stringify({ type: "init", session_id: "x", model: "auto-gemini-3" }),
      JSON.stringify({ type: "message", role: "assistant", content: "4", delta: true }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 7, output_tokens: 1, cached: 0 },
      }),
    ].join("\n");

    const result = parseGeminiStreamJson(stdout);

    expect(result?.response).toBe("4");
    expect(result?.usage).toEqual({ input_tokens: 7, output_tokens: 1, cache_read_tokens: 0 });
  });

  it("does NOT append user-role messages into the response stream", () => {
    const stdout = buildNdjson([
      { type: "message", role: "user", content: "what is 2+2" },
      { type: "message", role: "assistant", content: "4", delta: true },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 5, output_tokens: 1 },
      },
    ]);

    const result = parseGeminiStreamJson(stdout);

    expect(result?.response).toBe("4");
    expect(result?.response ?? "").not.toContain("what is 2+2");
  });

  it("returns response without usage when the result event is missing stats", () => {
    const stdout = buildNdjson([
      { type: "message", role: "assistant", content: "partial", delta: true },
      { type: "result", status: "interrupted" },
    ]);

    const result = parseGeminiStreamJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("partial");
    expect(result?.usage).toBeUndefined();
  });

  it("returns null on empty / all-blank input", () => {
    expect(parseGeminiStreamJson("")).toBeNull();
    expect(parseGeminiStreamJson("   \n  \n")).toBeNull();
  });

  it("returns null when no line parses as JSON", () => {
    const stdout = ["Warning: foo", "Some banner", "not json either"].join("\n");
    expect(parseGeminiStreamJson(stdout)).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const stdout =
      JSON.stringify({ type: "message", role: "assistant", content: "ok", delta: true }) +
      "\r\n" +
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 1, output_tokens: 1, cached: 0 },
      }) +
      "\r\n";

    const result = parseGeminiStreamJson(stdout);

    expect(result?.response).toBe("ok");
    expect(result?.usage).toEqual({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 });
  });
});

describe("Gemini sessionId + stopReason (phase 7)", () => {
  it("extracts session_id from the stream-json init event (previously dropped)", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "conv-abc", model: "gemini" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hi", delta: true }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 1, output_tokens: 1 },
      }),
    ].join("\n");

    const result = parseGeminiStreamJson(stdout);
    // Mutation that flips this red: removing the init-event session_id branch
    // in parseGeminiStreamJson (audit: session id was present but dropped).
    expect(result?.sessionId).toBe("conv-abc");
    expect(result?.stopReason).toBe("success");
  });

  it("leaves sessionId undefined for -o json (capability fact: none emitted)", () => {
    const result = parseGeminiJson(JSON.stringify({ response: "hi" }));
    expect(result?.sessionId).toBeUndefined();
  });
});
