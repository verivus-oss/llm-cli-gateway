import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractProviderOutputMetadata } from "../provider-output-metadata.js";
import { parseVibeStream } from "../vibe-stream-parser.js";
import { parseCursorStreamJson } from "../cursor-stream-parser.js";
import { parseGeminiStreamJson } from "../gemini-json-parser.js";

/**
 * #296. The fixtures are REAL captured output, not hand-written shapes: one
 * line per event type from the c1 probe of 2026-09-02, host paths scrubbed.
 * A hand-written fixture would encode this file's belief about the wire, which
 * is exactly the belief that was wrong (the gateway recorded mistral and cursor
 * as emitting no session id while both stamped one on every line).
 */
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "provider-streams", name), "utf8");

const VIBE = fixture("vibe-2026-09-02.ndjson");
const CURSOR = fixture("cursor-2026-09-02.ndjson");
const AGY = fixture("agy-2026-09-02.ndjson");

describe("mistral: the Vibe session id was on the wire all along", () => {
  it("reads the real session UUID out of a streaming capture", () => {
    expect(parseVibeStream(VIBE)?.sessionId).toBe("32c3e0db-e7df-0ade-d836-a0e6b4c50259");
  });

  it("reaches the flight recorder through the shared dispatcher", () => {
    const meta = extractProviderOutputMetadata("mistral", VIBE, "streaming");
    expect(meta.sessionId).toBe("32c3e0db-e7df-0ade-d836-a0e6b4c50259");
    expect(meta.absentFields).not.toContain("sessionId");
  });

  it("accepts the stream-json alias the tool schema still takes", () => {
    expect(extractProviderOutputMetadata("mistral", VIBE, "stream-json").sessionId).toBe(
      "32c3e0db-e7df-0ade-d836-a0e6b4c50259"
    );
  });

  it("uses the captured streaming grammar for a text projection", () => {
    const meta = extractProviderOutputMetadata("mistral", VIBE, "text");
    expect(meta.sessionId).toBe("32c3e0db-e7df-0ade-d836-a0e6b4c50259");
    expect(meta.absentFields).not.toContain("sessionId");
  });

  it("takes the stop reason from the LAST entry, not the first", () => {
    const trailing = `${VIBE.trim()}\n${JSON.stringify({
      id: "z",
      sessionId: "32c3e0db-e7df-0ade-d836-a0e6b4c50259",
      type: "message",
      role: "assistant",
      generationStatus: "cancelled",
      content: [{ type: "text", text: "..." }],
    })}\n`;
    expect(parseVibeStream(trailing)?.stopReason).toBe("cancelled");
  });

  it("survives a banner line rather than discarding the capture", () => {
    expect(parseVibeStream(`Trust this folder? [y/N]\n${VIBE}`)?.sessionId).toBe(
      "32c3e0db-e7df-0ade-d836-a0e6b4c50259"
    );
  });

  it("returns null when nothing in the buffer is a Vibe entry", () => {
    expect(parseVibeStream("plain text reply\n")).toBeNull();
    expect(parseVibeStream("")).toBeNull();
  });
});

describe("cursor: session id, stop reason and usage from stream-json", () => {
  it("reads all three out of a real capture", () => {
    const parsed = parseCursorStreamJson(CURSOR);
    expect(parsed?.sessionId).toBe("a8951d8d-9de2-4258-ab7a-761a99a84a16");
    expect(parsed?.stopReason).toBe("success");
    expect(parsed?.usage).toMatchObject({ input_tokens: 3532, output_tokens: 214 });
    expect(parsed?.usage?.cache_read_tokens).toBe(30720);
  });

  it("reaches the flight recorder through the shared dispatcher", () => {
    const meta = extractProviderOutputMetadata("cursor", CURSOR, "stream-json");
    expect(meta.sessionId).toBe("a8951d8d-9de2-4258-ab7a-761a99a84a16");
    expect(meta.stopReason).toBe("success");
    expect(meta.absentFields).toEqual([]);
  });

  it("uses captured stream-json metadata for a text projection", () => {
    const meta = extractProviderOutputMetadata("cursor", CURSOR, "text");
    expect(meta.sessionId).toBe("a8951d8d-9de2-4258-ab7a-761a99a84a16");
    expect(meta.stopReason).toBe("success");
    expect(meta.absentFields).not.toContain("sessionId");
    expect(meta.absentFields).not.toContain("stopReason");
  });

  it("names a failure even when subtype is missing", () => {
    const line = JSON.stringify({ type: "result", is_error: true, session_id: "s1" });
    expect(parseCursorStreamJson(`${line}\n`)?.stopReason).toBe("error");
  });

  it("returns null on output that is not this wire", () => {
    expect(parseCursorStreamJson("MARKER\n")).toBeNull();
  });

  it("records malformed token fields as absent instead of fabricating zero", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { inputTokens: "3532", outputTokens: 214 },
    });
    expect(parseCursorStreamJson(`${line}\n`)?.usage).toBeUndefined();
    expect(
      extractProviderOutputMetadata("cursor", `${line}\n`, "stream-json").absentFields
    ).toContain("usage");
  });
});

describe("gemini: the agy grammar is a second grammar behind one flag value", () => {
  it("takes conversation_id, status and usage from an agy capture", () => {
    const parsed = parseGeminiStreamJson(AGY);
    expect(parsed?.sessionId).toBe("ab2d5972-70f5-46b7-b09a-7045650dd5e9");
    expect(parsed?.stopReason).toBe("CANCELED");
    expect(parsed?.usage).toMatchObject({ input_tokens: 14546, output_tokens: 282 });
  });

  it("reaches the flight recorder through the shared dispatcher", () => {
    expect(extractProviderOutputMetadata("gemini", AGY, "stream-json").sessionId).toBe(
      "ab2d5972-70f5-46b7-b09a-7045650dd5e9"
    );
  });

  it("still reads the type-keyed grammar it was written for", () => {
    // The two are disjoint (`type` vs `event`), and adding one must not cost
    // the other.
    const legacy =
      `${JSON.stringify({ type: "init", session_id: "legacy-1" })}\n` +
      `${JSON.stringify({ type: "message", role: "assistant", content: "he", delta: true })}\n` +
      `${JSON.stringify({ type: "message", role: "assistant", content: "llo", delta: true })}\n` +
      `${JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 2 } })}\n`;
    const parsed = parseGeminiStreamJson(legacy);
    expect(parsed?.sessionId).toBe("legacy-1");
    expect(parsed?.response).toBe("hello");
    expect(parsed?.stopReason).toBe("success");
  });
});
