import { describe, it, expect } from "vitest";
import { parseCodexJsonStream } from "../codex-json-parser.js";

describe("parseCodexJsonStream", () => {
  it("extracts usage from a complete event stream", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-abc123"}`,
      `{"type":"turn.started","turn_id":"u-001"}`,
      `{"type":"item.started","item":{"type":"agent_message"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":150,"output_tokens":42,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"cost_usd":0.0012}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);

    expect(result.threadId).toBe("t-abc123");
    expect(result.finalMessage).toBe("hello");
    expect(result.error).toBeUndefined();
    expect(result.usage).toEqual({
      input_tokens: 150,
      output_tokens: 42,
      cache_read_tokens: 100,
      cache_creation_tokens: 0,
      cost_usd: 0.0012,
    });
  });

  it("returns no usage when the stream is partial (no turn.completed)", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-xyz"}`,
      `{"type":"turn.started","turn_id":"u-002"}`,
      `{"type":"item.started","item":{"type":"agent_message"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);

    expect(result.usage).toBeUndefined();
    expect(result.threadId).toBe("t-xyz");
    expect(result.finalMessage).toBe("partial");
    expect(result.error).toBeUndefined();
  });

  it("surfaces error events", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-err"}`,
      `{"type":"error","message":"context length exceeded"}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);

    expect(result.error).toBe("context length exceeded");
    expect(result.usage).toBeUndefined();
  });

  it("surfaces turn.failed events", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-fail"}`,
      `{"type":"turn.failed","error":{"message":"model unavailable"}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);
    expect(result.error).toBe("model unavailable");
  });

  it("ignores garbage preamble lines that are not valid JSON", () => {
    const stream = [
      `Warning: using experimental json mode`,
      `not-json at all`,
      `{"type":"thread.started","thread_id":"t-noise"}`,
      `{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":7}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);
    expect(result.threadId).toBe("t-noise");
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it("returns an empty result for empty input", () => {
    expect(parseCodexJsonStream("")).toEqual({});
  });
});
