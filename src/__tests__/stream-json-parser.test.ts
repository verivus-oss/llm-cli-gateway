import { describe, it, expect } from "vitest";
import { parseStreamJson } from "../stream-json-parser.js";

// Fixtures captured from live `claude --output-format stream-json --include-partial-messages`
const FULL_STREAM = [
  '{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-opus-4-6","tools":[],"mcp_servers":[]}',
  '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","stop_reason":null,"stop_sequence":null}}}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world!"}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world!"}],"model":"claude-opus-4-6"}}',
  '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
  '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}}',
  '{"type":"stream_event","event":{"type":"message_stop"}}',
  '{"type":"result","subtype":"success","result":"Hello world!","total_cost_usd":0.137,"duration_ms":3067,"duration_api_ms":2650,"num_turns":1,"session_id":"abc-123","usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}',
].join("\n");

describe("parseStreamJson", () => {
  it("should extract text from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.text).toBe("Hello world!");
  });

  it("should extract cost from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.costUsd).toBe(0.137);
  });

  it("should extract usage from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
    });
  });

  it("should extract sessionId from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.sessionId).toBe("abc-123");
  });

  it("should extract model from system init event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("should extract durationApiMs from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.durationApiMs).toBe(2650);
  });

  it("should extract numTurns from result event", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.numTurns).toBe(1);
  });

  it("should not mark as error for successful result", () => {
    const result = parseStreamJson(FULL_STREAM);
    expect(result.isError).toBe(false);
  });

  it("should mark as error when is_error is true", () => {
    const errorStream =
      '{"type":"result","subtype":"error","result":"Something went wrong","is_error":true,"total_cost_usd":0.01}';
    const result = parseStreamJson(errorStream);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Something went wrong");
  });

  it("should fall back to assistant event when no result event", () => {
    const noResult = [
      '{"type":"system","subtype":"init","session_id":"abc-456","model":"claude-sonnet-4-5-20250929"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Fallback text"}],"model":"claude-sonnet-4-5-20250929"}}',
    ].join("\n");
    const result = parseStreamJson(noResult);
    expect(result.text).toBe("Fallback text");
    expect(result.costUsd).toBeNull();
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.sessionId).toBe("abc-456");
  });

  it("should handle empty stdout", () => {
    const result = parseStreamJson("");
    expect(result.text).toBe("");
    expect(result.costUsd).toBeNull();
    expect(result.usage).toBeNull();
  });

  it("should skip malformed JSON lines gracefully", () => {
    const mixedStream = [
      "not valid json",
      '{"type":"result","result":"good","total_cost_usd":0.05}',
      "another bad line",
    ].join("\n");
    const result = parseStreamJson(mixedStream);
    expect(result.text).toBe("good");
    expect(result.costUsd).toBe(0.05);
  });

  it("should handle stream with only system init event", () => {
    const initOnly =
      '{"type":"system","subtype":"init","session_id":"init-only","model":"claude-opus-4-6"}';
    const result = parseStreamJson(initOnly);
    expect(result.text).toBe("");
    expect(result.sessionId).toBe("init-only");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("should handle assistant with multiple text blocks", () => {
    const multiBlock =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Part 1 "},{"type":"text","text":"Part 2"}]}}';
    const result = parseStreamJson(multiBlock);
    expect(result.text).toBe("Part 1 Part 2");
  });

  it("should handle missing usage fields with defaults", () => {
    const minimalResult =
      '{"type":"result","result":"minimal","usage":{"input_tokens":10,"output_tokens":5}}';
    const result = parseStreamJson(minimalResult);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});
