import { describe, it, expect } from "vitest";
import { parseCodexJsonStream, codexDisplayText, codexFrResponse } from "../codex-json-parser.js";

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

  // slice 1.5: Codex CLI ≥0.133.0 emits `cached_input_tokens` in
  // turn.completed.usage. The parser must prefer the new name over the
  // legacy Anthropic-style `cache_read_input_tokens` so cache_read_tokens
  // stops being NULL on codex rows.
  it("extracts cache_read_tokens from cached_input_tokens (current Codex CLI)", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-new"}`,
      `{"type":"turn.completed","usage":{"input_tokens":13420,"output_tokens":256,"cached_input_tokens":4992}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);
    expect(result.usage).toEqual({
      input_tokens: 13420,
      output_tokens: 256,
      cache_read_tokens: 4992,
    });
  });

  it("prefers cached_input_tokens when both new and legacy fields are present", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-both"}`,
      `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":50,"cache_read_input_tokens":999}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);
    expect(result.usage?.cache_read_tokens).toBe(50);
  });

  it("still accepts the bare cache_read_tokens fallback when nothing else is present", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-bare"}`,
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2,"cache_read_tokens":3}}`,
    ].join("\n");

    const result = parseCodexJsonStream(stream);
    expect(result.usage?.cache_read_tokens).toBe(3);
  });

  // #44: finalMessage is the LAST agent_message. codex `exec` text mode prints
  // only the final one even when a turn emits several (verified on codex-cli
  // 0.139.0), so the last message is what reproduces text-mode stdout.
  it("finalMessage is the last agent_message when a turn emits several", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-multi"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"ALPHA"}}`,
      `{"type":"item.completed","item":{"type":"reasoning","text":"ignored"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"BETA"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    ].join("\n");

    expect(parseCodexJsonStream(stream).finalMessage).toBe("BETA");
  });
});

describe("codexDisplayText (#44 text-mode reply reconstruction, never raw JSONL)", () => {
  it("returns a single agent_message verbatim (matches codex text-mode stdout)", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-1"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"1. a\\n2. b\\n3. c"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}`,
    ].join("\n");

    expect(codexDisplayText(stream)).toBe("1. a\n2. b\n3. c");
  });

  it("returns ONLY the final agent_message for a multi-message turn (== text mode)", () => {
    // Regression guard: codex `exec` text mode prints just the last message.
    // A naive join of all messages would return "ALPHA\n\nBETA" — wrong.
    const stream = [
      `{"type":"item.completed","item":{"type":"agent_message","text":"ALPHA"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"BETA"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    ].join("\n");

    expect(codexDisplayText(stream)).toBe("BETA");
  });

  it("falls back to the parsed error text on an error turn (no agent_message)", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-err"}`,
      `{"type":"turn.failed","error":{"message":"model unavailable"}}`,
    ].join("\n");

    expect(codexDisplayText(stream)).toBe("model unavailable");
  });

  it("returns '' (never raw JSONL) for a recognized stream with no reply and no error", () => {
    // thread/usage events present but no agent_message: emptier beats dumping
    // the raw event stream at the caller.
    const stream = [
      `{"type":"thread.started","thread_id":"t-empty"}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    ].join("\n");

    expect(codexDisplayText(stream)).toBe("");
  });

  it("surfaces non-JSONL stdout verbatim (e.g. a pre-stream fatal line)", () => {
    expect(codexDisplayText("fatal: something broke before any event")).toBe(
      "fatal: something broke before any event"
    );
    expect(codexDisplayText("")).toBe("");
  });

  it("returns '' (never raw JSONL) for a stream of ONLY unhandled event types", () => {
    // turn.started / item.started are valid codex events the switch ignores.
    // `sawEvent` must still classify this as a codex stream so it never leaks.
    const stream = [
      `{"type":"turn.started","turn_id":"u-1"}`,
      `{"type":"item.started","item":{"type":"agent_message"}}`,
    ].join("\n");

    expect(codexDisplayText(stream)).toBe("");
  });

  it("returns '' (never raw JSONL) even for JSON-object lines that lack a string `type` (schema drift)", () => {
    // sawEvent is set for ANY parsed JSON object, not only typed events, so a
    // drifted/typeless event stream still resolves to "" rather than leaking.
    const stream = [`{"thread_id":"t-drift"}`, `{"foo":"bar","n":1}`].join("\n");
    expect(codexDisplayText(stream)).toBe("");
  });
});

describe("codexFrResponse (#44 flight-recorder response value, shared by sync + async writers)", () => {
  const stream = [
    `{"type":"thread.started","thread_id":"t-fr"}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"the reply"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":4}}`,
  ].join("\n");

  it("text mode (default) persists the reconstructed reply, NOT raw JSONL", () => {
    expect(codexFrResponse("text", stream)).toBe("the reply");
    expect(codexFrResponse(undefined, stream)).toBe("the reply");
  });

  it("json mode persists the raw JSONL event stream verbatim (caller asked for it)", () => {
    expect(codexFrResponse("json", stream)).toBe(stream);
  });
});

describe("parseCodexJsonStream — stopReason (phase 7)", () => {
  it("surfaces a stop reason only when turn.completed carries one", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-x"}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1},"stop_reason":"completed"}`,
    ].join("\n");
    // Mutation that flips this red: removing the defensive stop_reason/reason
    // extraction in the turn.completed branch.
    expect(parseCodexJsonStream(stream).stopReason).toBe("completed");
  });

  it("leaves stopReason undefined for a normal stream (codex -p capability fact)", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t-y"}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    ].join("\n");
    expect(parseCodexJsonStream(stream).stopReason).toBeUndefined();
  });
});
