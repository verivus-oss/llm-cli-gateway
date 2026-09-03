// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * Per-path goldens for the shared `applyProviderDisplayText` helper (design v5
 * section 5.4). Locks the display-swap routing for both response surfaces and,
 * the explicit Grok projection switch used by low-level callers.
 */
import { describe, expect, it } from "vitest";
import { applyProviderDisplayText } from "../provider-display.js";
import { codexDisplayText } from "../codex-json-parser.js";
import { grokDisplayText } from "../grok-json-parser.js";

// Fixtures where the display swap actually transforms the text (so the goldens
// distinguish "routed through the swap" from "returned raw").
const CODEX_JSONL = [
  `{"type":"item.started","item":{"type":"agent_message"}}`,
  `{"type":"item.completed","item":{"type":"agent_message","text":"hello codex"}}`,
].join("\n");
const GROK_NDJSON = [
  JSON.stringify({ type: "text", text: "hel" }),
  JSON.stringify({ type: "text", text: "lo grok" }),
].join("\n");

const CAPTURED_JSON_CASES = [
  {
    cli: "claude",
    captureFormat: "stream-json",
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "result", result: "hello", session_id: "s1" }),
    ].join("\n"),
    expected: { type: "result", result: "hello", session_id: "s1" },
  },
  {
    cli: "gemini",
    captureFormat: "stream-json",
    stdout: [
      JSON.stringify({ event: "init", conversation_id: "g1" }),
      JSON.stringify({ event: "result", result: { response: "hello", status: "DONE" } }),
    ].join("\n"),
    expected: { response: "hello", status: "DONE" },
  },
  {
    cli: "grok",
    captureFormat: "streaming-json",
    stdout: [
      JSON.stringify({ type: "thought", data: "considering" }),
      JSON.stringify({ type: "text", data: "hello" }),
      JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "gr1" }),
    ].join("\n"),
    expected: {
      text: "hello",
      stopReason: "end_turn",
      sessionId: "gr1",
      thought: "considering",
    },
  },
  {
    cli: "mistral",
    captureFormat: "streaming",
    stdout: [
      JSON.stringify({ type: "reasoning", text: "considering", sessionId: "m1" }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        sessionId: "m1",
      }),
    ].join("\n"),
    expected: {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      sessionId: "m1",
    },
  },
  {
    cli: "cursor",
    captureFormat: "stream-json",
    stdout: [
      JSON.stringify({ type: "thinking", text: "considering", session_id: "c1" }),
      JSON.stringify({ type: "result", result: "hello", session_id: "c1" }),
    ].join("\n"),
    expected: { type: "result", result: "hello", session_id: "c1" },
  },
] as const;

describe("applyProviderDisplayText", () => {
  it("codex non-json: reconstructs the agent_message (both paths)", () => {
    const expected = codexDisplayText(CODEX_JSONL);
    expect(expected).not.toBe(CODEX_JSONL); // fixture actually transforms
    // codex ignores applyGrokDisplay, so inline and readback agree.
    for (const applyGrokDisplay of [true, false]) {
      expect(
        applyProviderDisplayText({
          cli: "codex",
          outputFormat: "text",
          stdout: CODEX_JSONL,
          applyGrokDisplay,
        })
      ).toBe(expected);
    }
  });

  it("codex json: returns the raw JSONL unchanged", () => {
    expect(
      applyProviderDisplayText({
        cli: "codex",
        outputFormat: "json",
        stdout: CODEX_JSONL,
        applyGrokDisplay: true,
      })
    ).toBe(CODEX_JSONL);
  });

  it.each(CAPTURED_JSON_CASES)(
    "$cli JSON presentation is projected from the rich capture",
    ({ cli, captureFormat, stdout, expected }) => {
      const projected = applyProviderDisplayText({
        cli,
        outputFormat: "json",
        captureFormat,
        stdout,
        applyGrokDisplay: true,
      });
      expect(JSON.parse(projected)).toEqual(expected);
      expect(projected).not.toBe(stdout);
    }
  );

  it("grok streaming-json INLINE (applyGrokDisplay=true): concatenates deltas", () => {
    const expected = grokDisplayText("streaming-json", GROK_NDJSON);
    expect(expected).not.toBe(GROK_NDJSON); // fixture actually transforms
    expect(
      applyProviderDisplayText({
        cli: "grok",
        outputFormat: "streaming-json",
        stdout: GROK_NDJSON,
        applyGrokDisplay: true,
      })
    ).toBe(expected);
  });

  it("grok streaming-json READBACK (applyGrokDisplay=false): raw is preserved (locked asymmetry)", () => {
    // The llm_job_result readback path passes applyGrokDisplay=false and must
    // keep returning the raw NDJSON, matching today's behavior. If this ever
    // becomes the transformed text, it is an intentional asymmetry fix and this
    // assertion should be updated deliberately.
    expect(
      applyProviderDisplayText({
        cli: "grok",
        outputFormat: "streaming-json",
        stdout: GROK_NDJSON,
        applyGrokDisplay: false,
      })
    ).toBe(GROK_NDJSON);
  });

  it("non-codex, non-grok providers are unchanged", () => {
    const text = "plain claude reply";
    for (const cli of ["claude", "gemini", "mistral", "unknown"]) {
      expect(
        applyProviderDisplayText({
          cli,
          outputFormat: "text",
          stdout: text,
          applyGrokDisplay: true,
        })
      ).toBe(text);
    }
  });
});
