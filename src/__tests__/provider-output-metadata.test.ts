import { describe, it, expect } from "vitest";
import { extractProviderOutputMetadata } from "../provider-output-metadata.js";

describe("extractProviderOutputMetadata (phase 7 dispatch + capability facts)", () => {
  it("grok: extracts sessionId + stopReason and records usage as absent", () => {
    const stdout = JSON.stringify({ text: "x", stopReason: "stop", sessionId: "g-1" });
    const meta = extractProviderOutputMetadata("grok", stdout, "json");
    expect(meta.sessionId).toBe("g-1");
    expect(meta.stopReason).toBe("stop");
    // Mutation that flips this red: dropping the "usage" capability fact for grok.
    expect(meta.absentFields).toContain("usage");
  });

  it("claude: extracts sessionId + stopReason from a stream-json result event", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"c-1","model":"claude"}',
      '{"type":"result","subtype":"success","result":"ok","stop_reason":"end_turn","session_id":"c-1"}',
    ].join("\n");
    const meta = extractProviderOutputMetadata("claude", stdout, "stream-json");
    expect(meta.sessionId).toBe("c-1");
    expect(meta.stopReason).toBe("end_turn");
    expect(meta.absentFields).toHaveLength(0);
  });

  it("codex: extracts thread id as session; stop reason is a capability fact", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n");
    const meta = extractProviderOutputMetadata("codex", stdout, undefined);
    expect(meta.sessionId).toBe("t-1");
    expect(meta.stopReason).toBeUndefined();
    expect(meta.absentFields).toContain("stopReason");
  });

  it("gemini: session id only from stream-json; json mode records it absent", () => {
    const stream = [
      '{"type":"init","session_id":"gm-1","model":"gemini"}',
      '{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n");
    const meta = extractProviderOutputMetadata("gemini", stream, "stream-json");
    expect(meta.sessionId).toBe("gm-1");
    expect(meta.stopReason).toBe("success");

    const jsonMeta = extractProviderOutputMetadata("gemini", '{"response":"hi"}', "json");
    expect(jsonMeta.sessionId).toBeUndefined();
    expect(jsonMeta.absentFields).toContain("sessionId");
  });

  it("mistral: both session id and stop reason are typed capability facts", () => {
    const meta = extractProviderOutputMetadata("mistral", "plain reply", undefined);
    expect(meta.sessionId).toBeUndefined();
    expect(meta.stopReason).toBeUndefined();
    expect(meta.absentFields).toEqual(expect.arrayContaining(["sessionId", "stopReason"]));
  });
});
