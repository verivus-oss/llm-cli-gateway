/**
 * Phase 4 slice β — Mistral Vibe `meta.json` parser unit tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseVibeMetaJson } from "../mistral-meta-json-parser.js";
import { extractUsageAndCost } from "../index.js";

const SESSION_ID = "01940000-0000-7000-8000-0000000000aa";

function writeMeta(home: string, sessionId: string, body: unknown): string {
  const dir = join(home, ".vibe", "logs", "session", sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "meta.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("parseVibeMetaJson", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "vibe-meta-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns {} when sessionId is undefined", () => {
    expect(parseVibeMetaJson(home, undefined)).toEqual({});
  });

  it("returns {} when sessionId uses the reserved gw- prefix", () => {
    expect(parseVibeMetaJson(home, "gw-anything")).toEqual({});
  });

  it("returns {} when meta.json does not exist", () => {
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({});
  });

  it("returns {} when meta.json contains malformed JSON", () => {
    writeMeta(home, SESSION_ID, "{not json}");
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({});
  });

  it("returns {} when stats key is missing", () => {
    writeMeta(home, SESSION_ID, { model: "mistral-medium-3.5" });
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({});
  });

  it("maps stats.session_prompt_tokens, session_completion_tokens, session_cost", () => {
    writeMeta(home, SESSION_ID, {
      stats: {
        session_prompt_tokens: 1234,
        session_completion_tokens: 567,
        session_cost: 0.0421,
      },
    });
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.0421,
    });
  });

  it("ignores non-numeric or negative values in stats", () => {
    writeMeta(home, SESSION_ID, {
      stats: {
        session_prompt_tokens: "1234",
        session_completion_tokens: -3,
        session_cost: 0.5,
      },
    });
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: 0.5,
    });
  });

  it("integrates with extractUsageAndCost: mistral branch reads meta.json from disk", () => {
    writeMeta(home, SESSION_ID, {
      stats: {
        session_prompt_tokens: 100,
        session_completion_tokens: 50,
        session_cost: 0.0012,
      },
    });
    const usage = extractUsageAndCost("mistral", "stdout ignored for mistral", undefined, {
      sessionId: SESSION_ID,
      home,
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.costUsd).toBe(0.0012);
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("integrates with extractUsageAndCost: returns {} when no sessionId context is given", () => {
    writeMeta(home, SESSION_ID, {
      stats: { session_prompt_tokens: 100, session_completion_tokens: 50, session_cost: 0.5 },
    });
    const usage = extractUsageAndCost("mistral", "stdout", undefined, { home });
    expect(usage).toEqual({});
  });

  it("partial stats payloads return only the fields present", () => {
    writeMeta(home, SESSION_ID, {
      stats: {
        session_prompt_tokens: 7,
      },
    });
    expect(parseVibeMetaJson(home, SESSION_ID)).toEqual({
      inputTokens: 7,
      outputTokens: undefined,
      costUsd: undefined,
    });
  });
});
