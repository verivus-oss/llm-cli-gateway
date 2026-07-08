import { describe, it, expect } from "vitest";
import {
  parseGrokJson,
  parseGrokStreamingJson,
  parseGrokOutput,
  grokDisplayText,
} from "../grok-json-parser.js";

/**
 * Field shapes ground-truthed from the Grok Build CLI `-p` headless surface
 * (index.ts capability note, live-verified 2026-06-13):
 *   json           → { text, stopReason, sessionId, requestId, thought }
 *   streaming-json → {type:"thought"|"text"} deltas + {type:"end", stopReason,
 *                     sessionId, requestId}
 */
describe("parseGrokJson (-p --output-format json)", () => {
  it("extracts text, stopReason, sessionId, requestId, thought", () => {
    const stdout = JSON.stringify({
      text: "the answer is 42",
      stopReason: "stop",
      sessionId: "11111111-2222-3333-4444-555555555555",
      requestId: "req-abc",
      thought: "reasoning here",
    });

    const result = parseGrokJson(stdout);

    // Mutation that flips this red: dropping `parsed.stopReason` / `sessionId`
    // extraction in parseGrokJson (audit: Grok had no parser at all).
    expect(result?.text).toBe("the answer is 42");
    expect(result?.stopReason).toBe("stop");
    expect(result?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(result?.requestId).toBe("req-abc");
    expect(result?.thought).toBe("reasoning here");
  });

  it("marks usage as a typed capability fact (never fabricated)", () => {
    const result = parseGrokJson(JSON.stringify({ text: "hi", stopReason: "stop" }));
    // Mutation that flips this red: setting `usageAbsent` false or inventing
    // token fields on the Grok -p result.
    expect(result?.usageAbsent).toBe(true);
    expect(result as Record<string, unknown>).not.toHaveProperty("usage");
  });

  it("returns null for empty or non-object stdout", () => {
    expect(parseGrokJson("")).toBeNull();
    expect(parseGrokJson("not json")).toBeNull();
    expect(parseGrokJson("[1,2,3]")).toBeNull();
  });

  it("tolerates a missing stopReason without inventing one", () => {
    const result = parseGrokJson(JSON.stringify({ text: "hi" }));
    expect(result?.text).toBe("hi");
    expect(result?.stopReason).toBeUndefined();
  });
});

describe("parseGrokStreamingJson (-p --output-format streaming-json)", () => {
  it("concatenates text deltas and lifts terminal end metadata", () => {
    const stdout = [
      JSON.stringify({ type: "thought", thought: "let me think" }),
      JSON.stringify({ type: "text", text: "Hello " }),
      JSON.stringify({ type: "text", text: "world" }),
      JSON.stringify({
        type: "end",
        stopReason: "stop",
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        requestId: "req-9",
      }),
    ].join("\n");

    const result = parseGrokStreamingJson(stdout);

    // Mutation that flips this red: not accumulating "text" deltas, or not
    // lifting stopReason/sessionId from the terminal {type:"end"} event.
    expect(result?.text).toBe("Hello world");
    expect(result?.thought).toBe("let me think");
    expect(result?.stopReason).toBe("stop");
    expect(result?.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result?.requestId).toBe("req-9");
    expect(result?.usageAbsent).toBe(true);
  });

  it("extracts text/thought from the REAL {type,data} delta shape", () => {
    // Ground truth: the live grok `-p --output-format streaming-json` capture in
    // test-veracity-regressions-slice-epsilon.test.ts carries each delta payload
    // in a `data` field, NOT `text`. Mutation that flips this red: reverting
    // deltaText/deltaThought to omit `str(event.data)`. The real-shape text is
    // then dropped and these expects fail.
    const stdout =
      JSON.stringify({ type: "thought", data: "hello" }) +
      "\n" +
      JSON.stringify({ type: "text", data: "hello" }) +
      "\n" +
      JSON.stringify({ type: "text", data: " world" }) +
      "\n" +
      JSON.stringify({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "019ec070-26ab-7fa3-b66b-72fc6964f250",
        requestId: "64625ea0-6292-4dd1-9f43-263084223516",
      });

    const result = parseGrokStreamingJson(stdout);
    expect(result?.text).toBe("hello world");
    expect(result?.thought).toBe("hello");
    expect(result?.stopReason).toBe("EndTurn");
    expect(result?.sessionId).toBe("019ec070-26ab-7fa3-b66b-72fc6964f250");
    expect(result?.usageAbsent).toBe(true);

    // grokDisplayText must surface the real-shape reply, never raw NDJSON.
    expect(grokDisplayText("streaming-json", stdout)).toBe("hello world");
  });

  it("ignores non-JSON banner chatter but still parses the stream", () => {
    const stdout = [
      "Warning: ripgrep not available",
      JSON.stringify({ type: "text", text: "ok" }),
      JSON.stringify({ type: "end", stopReason: "stop" }),
    ].join("\n");

    const result = parseGrokStreamingJson(stdout);
    expect(result?.text).toBe("ok");
    expect(result?.stopReason).toBe("stop");
  });

  it("returns null when no parseable JSON line is present", () => {
    expect(parseGrokStreamingJson("just noise\nmore noise")).toBeNull();
    expect(parseGrokStreamingJson("")).toBeNull();
  });
});

describe("parseGrokOutput / grokDisplayText dispatch", () => {
  it("dispatches on outputFormat and returns null for plain mode", () => {
    expect(parseGrokOutput("plain", "hello")).toBeNull();
    expect(parseGrokOutput(undefined, "hello")).toBeNull();
    expect(parseGrokOutput("json", JSON.stringify({ text: "x" }))?.text).toBe("x");
    expect(
      parseGrokOutput("streaming-json", JSON.stringify({ type: "text", text: "y" }))?.text
    ).toBe("y");
  });

  it("grokDisplayText returns json verbatim, streaming reply text, plain unchanged", () => {
    const jsonOut = JSON.stringify({ text: "reply", stopReason: "stop" });
    expect(grokDisplayText("json", jsonOut)).toBe(jsonOut);

    const stream = [
      JSON.stringify({ type: "text", text: "abc" }),
      JSON.stringify({ type: "end", stopReason: "stop" }),
    ].join("\n");
    // Mutation that flips this red: leaking raw NDJSON instead of the reply.
    expect(grokDisplayText("streaming-json", stream)).toBe("abc");

    expect(grokDisplayText("plain", "just text")).toBe("just text");
  });
});
