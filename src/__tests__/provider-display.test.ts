// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * Per-path goldens for the shared `applyProviderDisplayText` helper (design v5
 * section 5.4). Locks the display-swap routing for both response surfaces and,
 * critically, the deliberate grok-readback asymmetry: the inline path (buildCli
 * Response) applies the grok streaming-json swap; the llm_job_result readback
 * path does not. A future change that flips the readback flag must update the
 * asymmetry case here on purpose.
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
