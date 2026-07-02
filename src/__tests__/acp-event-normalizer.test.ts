/**
 * ACP event-normalizer tests (plan step normalize-session-updates).
 *
 * Verifies each session/update variant maps to a structured progress event,
 * that the synchronous final text accumulates ONLY agent message chunks, and
 * that binary/content payloads (image/audio/resource) are summarized — never
 * embedded — in either the text or the events.
 */
import { describe, expect, it } from "vitest";

import {
  AcpEventNormalizer,
  normalizeSessionUpdate,
  summarizeContentBlock,
} from "../acp/event-normalizer.js";
import type { ContentBlock, SessionUpdateNotification } from "../acp/types.js";

function note(update: Record<string, unknown>): SessionUpdateNotification {
  return { sessionId: "s1", update } as unknown as SessionUpdateNotification;
}

function textChunk(variant: string, text: string): SessionUpdateNotification {
  return note({ sessionUpdate: variant, content: { type: "text", text } });
}

describe("ACP event-normalizer — summarizeContentBlock (content redaction)", () => {
  it("returns the text of a text block", () => {
    expect(summarizeContentBlock({ type: "text", text: "hello" } as ContentBlock)).toBe("hello");
  });

  it.each(["image", "audio", "resource", "resource_link", "future_kind"])(
    "summarizes a %s block as [type] without embedding its payload",
    type => {
      const block = {
        type,
        data: "AAAABASE64SECRETPAYLOAD",
        mimeType: "image/png",
        uri: "/home/secret.png",
      } as unknown as ContentBlock;
      const summary = summarizeContentBlock(block);
      expect(summary).toBe(`[${type}]`);
      expect(summary).not.toContain("AAAABASE64SECRETPAYLOAD");
      expect(summary).not.toContain("/home/secret.png");
    }
  );
});

describe("ACP event-normalizer — normalizeSessionUpdate variants", () => {
  it("maps agent_message_chunk to an agent_message event with text", () => {
    expect(normalizeSessionUpdate(textChunk("agent_message_chunk", "hi"))).toEqual({
      kind: "agent_message",
      text: "hi",
    });
  });

  it("maps agent_thought_chunk and user_message_chunk distinctly", () => {
    expect(normalizeSessionUpdate(textChunk("agent_thought_chunk", "thinking")).kind).toBe(
      "agent_thought"
    );
    expect(normalizeSessionUpdate(textChunk("user_message_chunk", "echo")).kind).toBe(
      "user_message"
    );
  });

  it("maps tool_call with id/title/status/kind", () => {
    const ev = normalizeSessionUpdate(
      note({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit file",
        status: "in_progress",
        kind: "edit",
      })
    );
    expect(ev).toEqual({
      kind: "tool_call",
      toolCallId: "tc1",
      title: "Edit file",
      status: "in_progress",
      toolKind: "edit",
    });
  });

  it("maps tool_call_update", () => {
    const ev = normalizeSessionUpdate(
      note({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" })
    );
    expect(ev).toMatchObject({ kind: "tool_update", toolCallId: "tc1", status: "completed" });
  });

  it("maps plan to an entry count (not the entries themselves)", () => {
    const ev = normalizeSessionUpdate(
      note({ sessionUpdate: "plan", entries: [{ a: 1 }, { b: 2 }, { c: 3 }] })
    );
    expect(ev).toEqual({ kind: "plan", entryCount: 3 });
  });

  it("maps current_mode_update and usage_update", () => {
    expect(
      normalizeSessionUpdate(note({ sessionUpdate: "current_mode_update", currentModeId: "plan" }))
    ).toEqual({
      kind: "mode",
      currentModeId: "plan",
    });
    expect(
      normalizeSessionUpdate(note({ sessionUpdate: "usage_update", size: 100, used: 40 }))
    ).toEqual({
      kind: "usage",
      size: 100,
      used: 40,
    });
  });

  it("degrades an unknown/future variant to kind:other", () => {
    expect(normalizeSessionUpdate(note({ sessionUpdate: "brand_new_variant" }))).toEqual({
      kind: "other",
      sessionUpdate: "brand_new_variant",
    });
  });

  it("tolerates malformed updates without throwing (missing content, non-array entries, missing fields)", () => {
    // Defense in depth: the client parses notifications before this runs, but a
    // missing/oddly-typed field must degrade gracefully, never throw.
    expect(normalizeSessionUpdate(note({ sessionUpdate: "agent_message_chunk" }))).toEqual({
      kind: "agent_message",
      text: "",
    });
    expect(normalizeSessionUpdate(note({ sessionUpdate: "plan", entries: "nope" }))).toEqual({
      kind: "plan",
      entryCount: 0,
    });
    expect(normalizeSessionUpdate(note({ sessionUpdate: "tool_call" }))).toMatchObject({
      kind: "tool_call",
      toolCallId: "",
      title: "",
    });
    expect(normalizeSessionUpdate(note({}))).toEqual({ kind: "other", sessionUpdate: "" });
  });
});

describe("ACP event-normalizer — AcpEventNormalizer accumulation", () => {
  it("accumulates final text from agent message chunks in order", () => {
    const n = new AcpEventNormalizer();
    n.handle(textChunk("agent_message_chunk", "Hello, "));
    n.handle(textChunk("agent_message_chunk", "world"));
    n.handle(textChunk("agent_message_chunk", "!"));
    expect(n.finalText).toBe("Hello, world!");
  });

  it("never accumulates thoughts, user echoes, tool calls, or other events into final text", () => {
    const n = new AcpEventNormalizer();
    n.handle(textChunk("agent_thought_chunk", "(private reasoning)"));
    n.handle(textChunk("user_message_chunk", "(user echo)"));
    n.handle(note({ sessionUpdate: "tool_call", toolCallId: "t", title: "do" }));
    n.handle(textChunk("agent_message_chunk", "answer"));
    expect(n.finalText).toBe("answer");
  });

  it("accumulates a summarized placeholder for a binary block, never its payload", () => {
    const n = new AcpEventNormalizer();
    n.handle(
      note({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "BASE64SECRET", mimeType: "image/png" },
      })
    );
    expect(n.finalText).toBe("[image]");
    expect(n.finalText).not.toContain("BASE64SECRET");
  });

  it("returns the structured event for each handled update", () => {
    const n = new AcpEventNormalizer();
    const ev = n.handle(note({ sessionUpdate: "tool_call", toolCallId: "x", title: "t" }));
    expect(ev.kind).toBe("tool_call");
  });
});

describe("AcpEventNormalizer — stop reason + error (phase 7)", () => {
  it("records the terminal stop reason from the session/prompt response", () => {
    const n = new AcpEventNormalizer();
    n.handle(note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }));
    const ev = n.completeWith("end_turn");
    // Mutation that flips this red: completeWith not returning a
    // session_complete event or not storing stopReason.
    expect(ev).toEqual({ kind: "session_complete", stopReason: "end_turn" });
    expect(n.stopReason).toBe("end_turn");
    // Stop reason must not pollute the reply text (agent chunks only).
    expect(n.finalText).toBe("hi");
  });

  it("records an error event without embedding it in the reply text", () => {
    const n = new AcpEventNormalizer();
    const ev = n.error("agent crashed");
    expect(ev).toEqual({ kind: "error", message: "agent crashed" });
    expect(n.errorMessage).toBe("agent crashed");
    expect(n.finalText).toBe("");
  });

  it("leaves stopReason/errorMessage undefined until set (no fabrication)", () => {
    const n = new AcpEventNormalizer();
    expect(n.stopReason).toBeUndefined();
    expect(n.errorMessage).toBeUndefined();
  });
});
