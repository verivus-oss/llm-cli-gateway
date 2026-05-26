/**
 * Phase 4 slice β — Mistral Vibe `meta.json` parser unit tests.
 *
 * Vibe writes per-session telemetry into
 * `~/.vibe/logs/session/session_<YYYYMMDD>_<HHMMSS>_<first8hex>/meta.json`,
 * where `<first8hex>` is the leading 8 chars of the session UUID. Callers
 * pass the full UUID; the parser resolves it to the directory by globbing
 * and (on collision) matching `session_id` inside meta.json.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseVibeMetaJson } from "../mistral-meta-json-parser.js";
import { extractUsageAndCost } from "../index.js";

// Lowercase-hex UUID. The first 8 chars (`01940000`) become the dir suffix.
const SESSION_UUID = "01940000-0000-7000-8000-0000000000aa";
const SECOND_UUID = "01940000-0000-7000-8000-0000000000bb"; // same short prefix
const DIRNAME = "session_20260525_193106_01940000";
const DIRNAME_2 = "session_20260525_200000_01940000";

function writeMetaUnder(
  home: string,
  dirname: string,
  body: unknown,
  opts: { sessionId?: string } = {}
): string {
  const dir = join(home, ".vibe", "logs", "session", dirname);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "meta.json");
  let payload: string;
  if (typeof body === "string") {
    payload = body;
  } else {
    const wrapper: Record<string, unknown> =
      opts.sessionId !== undefined ? { session_id: opts.sessionId, ...(body as object) } : (body as object);
    payload = JSON.stringify(wrapper);
  }
  writeFileSync(path, payload);
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

  it("returns {} when no Vibe session directory exists for the UUID", () => {
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({});
  });

  it("returns {} when meta.json contains malformed JSON", () => {
    writeMetaUnder(home, DIRNAME, "{not json}");
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({});
  });

  it("returns {} when stats key is missing", () => {
    writeMetaUnder(home, DIRNAME, { model: "mistral-medium-3.5" }, { sessionId: SESSION_UUID });
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({});
  });

  it("resolves UUID → session_<ts>_<short8> dir and maps stats fields", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      {
        stats: {
          session_prompt_tokens: 1234,
          session_completion_tokens: 567,
          session_cost: 0.0421,
        },
      },
      { sessionId: SESSION_UUID }
    );
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.0421,
    });
  });

  it("disambiguates two dirs sharing the same 8-hex prefix by session_id", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 1, session_completion_tokens: 2, session_cost: 0.1 } },
      { sessionId: SESSION_UUID }
    );
    writeMetaUnder(
      home,
      DIRNAME_2,
      { stats: { session_prompt_tokens: 9, session_completion_tokens: 8, session_cost: 0.9 } },
      { sessionId: SECOND_UUID }
    );
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.1,
    });
    expect(parseVibeMetaJson(home, SECOND_UUID)).toEqual({
      inputTokens: 9,
      outputTokens: 8,
      costUsd: 0.9,
    });
  });

  it("accepts a directory basename verbatim (caller already resolved)", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 5, session_completion_tokens: 6, session_cost: 0.05 } },
      { sessionId: SESSION_UUID }
    );
    expect(parseVibeMetaJson(home, DIRNAME)).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      costUsd: 0.05,
    });
  });

  it("ignores non-numeric or negative values in stats", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      {
        stats: {
          session_prompt_tokens: "1234",
          session_completion_tokens: -3,
          session_cost: 0.5,
        },
      },
      { sessionId: SESSION_UUID }
    );
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: 0.5,
    });
  });

  it("returns {} when the only short-prefix candidate has a different full UUID (no cross-session leak)", () => {
    // Two UUIDs sharing the first 8 hex chars; only the SECOND one's
    // directory exists on disk. A naive resolver would happily return its
    // stats under the first UUID's name.
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 999, session_completion_tokens: 999, session_cost: 9.99 } },
      { sessionId: SECOND_UUID }
    );
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({});
  });

  it("rejects a session dir that is a symlink to a directory outside baseDir", () => {
    // Plant an out-of-tree directory containing a fully valid meta.json,
    // then symlink it under ~/.vibe/logs/session/<dirname>. An unhardened
    // parser would happily read it.
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "meta.json"),
      JSON.stringify({
        session_id: SESSION_UUID,
        stats: {
          session_prompt_tokens: 1_000_000,
          session_completion_tokens: 500_000,
          session_cost: 42,
        },
      })
    );
    const sessionRoot = join(home, ".vibe", "logs", "session");
    mkdirSync(sessionRoot, { recursive: true });
    symlinkSync(outside, join(sessionRoot, DIRNAME), "dir");
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({});
    expect(parseVibeMetaJson(home, DIRNAME)).toEqual({});
  });

  it("rejects path-traversal sessionIds (../, absolute, control chars)", () => {
    // Create a file outside the session log root that an unsanitised join
    // would happily read.
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ stats: { session_cost: 999 } }));
    for (const malicious of [
      "../../secrets",
      "../secrets",
      "foo/../bar",
      "..",
      "/etc/passwd",
      "session_20260525_193106_01940000/../../../secrets",
      "session_20260525_193106_01940000\n",
    ]) {
      expect(parseVibeMetaJson(home, malicious)).toEqual({});
    }
  });

  it("rejects sessionIds that are neither a valid dir basename nor a UUID", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 1, session_completion_tokens: 2, session_cost: 0.1 } },
      { sessionId: SESSION_UUID }
    );
    expect(parseVibeMetaJson(home, "not-a-uuid")).toEqual({});
    expect(parseVibeMetaJson(home, "01940000")).toEqual({});
    expect(parseVibeMetaJson(home, "abc123")).toEqual({});
  });

  it("integrates with extractUsageAndCost: mistral branch reads meta.json from disk", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      {
        stats: {
          session_prompt_tokens: 100,
          session_completion_tokens: 50,
          session_cost: 0.0012,
        },
      },
      { sessionId: SESSION_UUID }
    );
    const usage = extractUsageAndCost("mistral", "stdout ignored for mistral", undefined, {
      sessionId: SESSION_UUID,
      home,
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.costUsd).toBe(0.0012);
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
  });

  it("integrates with extractUsageAndCost: returns {} when no sessionId context is given", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 100, session_completion_tokens: 50, session_cost: 0.5 } },
      { sessionId: SESSION_UUID }
    );
    const usage = extractUsageAndCost("mistral", "stdout", undefined, { home });
    expect(usage).toEqual({});
  });

  it("partial stats payloads return only the fields present", () => {
    writeMetaUnder(
      home,
      DIRNAME,
      { stats: { session_prompt_tokens: 7 } },
      { sessionId: SESSION_UUID }
    );
    expect(parseVibeMetaJson(home, SESSION_UUID)).toEqual({
      inputTokens: 7,
      outputTokens: undefined,
      costUsd: undefined,
    });
  });
});
