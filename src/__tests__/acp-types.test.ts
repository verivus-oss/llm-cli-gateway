import { describe, expect, it } from "vitest";

import { AcpProtocolError } from "../acp/errors.js";
import {
  ClientCapabilitiesSchema,
  InitializeRequestSchema,
  InitializeResponseSchema,
  KNOWN_SESSION_UPDATE_VARIANTS,
  RequestPermissionRequestSchema,
  RequestPermissionResponseSchema,
  SessionLoadRequestSchema,
  SessionLoadResponseSchema,
  SessionNewRequestSchema,
  SessionNewResponseSchema,
  SessionPromptRequestSchema,
  SessionPromptResponseSchema,
  SessionUpdateNotificationSchema,
  isUnknownSessionUpdate,
  parseInitializeResponse,
  parseReadTextFileRequest,
  parseRequestPermissionRequest,
  parseSessionNewResponse,
  parseSessionPromptResponse,
  parseSessionUpdateNotification,
  parseWriteTextFileRequest,
} from "../acp/types.js";

// Step: define-acp-protocol-types.
// Validation clause: schema tests cover valid Mistral and Grok smoke responses
// captured from local validation, missing required fields, provider-specific
// extra fields, and unknown notification variants.
//
// test_matrix.unit.schemas:
//  - initialize request and response
//  - session/new request and response
//  - session/load request and response
//  - session/prompt request and response
//  - session/update notification variants used by target providers
//  - permission callback request and response

// ---------------------------------------------------------------------------
// Captured smoke responses (docs/research/2026-06-12-acp-provider-transport-
// feasibility.md). Shapes reproduce the documented provider divergence: Mistral
// nests agentInfo.{name,version}; Grok advertises an agentVersion/MCP capability
// bag. Both must parse under tolerant rules while required fields stay strict.
// ---------------------------------------------------------------------------

const MISTRAL_INITIALIZE_RESPONSE = {
  protocolVersion: 1,
  agentInfo: { name: "@mistralai/mistral-vibe", version: "2.14.1" },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { embeddedContext: true },
  },
} as const;

const GROK_INITIALIZE_RESPONSE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
  },
  // Grok reports a flat metadata bag rather than a nested agentInfo object.
  agentVersion: "0.2.50",
} as const;

describe("acp types — initialize", () => {
  it("parses a valid initialize request", () => {
    const parsed = InitializeRequestSchema.parse({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(parsed.protocolVersion).toBe(1);
  });

  it("parses the captured Mistral initialize response and keeps nested agentInfo", () => {
    const parsed = parseInitializeResponse(MISTRAL_INITIALIZE_RESPONSE, "mistral");
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.agentInfo?.name).toBe("@mistralai/mistral-vibe");
    expect(parsed.agentInfo?.version).toBe("2.14.1");
  });

  it("parses the captured Grok initialize response and tolerates provider-specific extra fields", () => {
    const parsed = parseInitializeResponse(GROK_INITIALIZE_RESPONSE, "grok");
    expect(parsed.protocolVersion).toBe(1);
    // The Grok-specific top-level field survives passthrough.
    expect((parsed as Record<string, unknown>).agentVersion).toBe("0.2.50");
    // Nested provider capability bag is preserved untouched.
    expect((parsed.agentCapabilities as Record<string, unknown>).mcpCapabilities).toEqual({
      http: true,
      sse: true,
    });
  });

  it("rejects an initialize response missing the required protocolVersion", () => {
    expect(() => parseInitializeResponse({ agentInfo: { name: "x" } }, "mistral")).toThrow(
      AcpProtocolError
    );
  });

  it("rejects an initialize response with a non-numeric protocolVersion", () => {
    expect(() => parseInitializeResponse({ protocolVersion: "1" }, "grok")).toThrow(
      AcpProtocolError
    );
  });

  it("defaults client capabilities to read-only safe shape (no write/terminal advertised)", () => {
    const parsed = ClientCapabilitiesSchema.parse({});
    expect(parsed.fs).toBeUndefined();
    expect(parsed.terminal).toBeUndefined();
  });
});

describe("acp types — session/new", () => {
  it("parses a valid session/new request and defaults mcpServers to []", () => {
    const parsed = SessionNewRequestSchema.parse({ cwd: "/tmp/acp-smoke" });
    expect(parsed.cwd).toBe("/tmp/acp-smoke");
    expect(parsed.mcpServers).toEqual([]);
  });

  it("rejects a session/new request with an empty cwd", () => {
    expect(() => SessionNewRequestSchema.parse({ cwd: "" })).toThrow();
  });

  it("parses Mistral and Grok session/new responses returning a session id", () => {
    const mistral = parseSessionNewResponse({ sessionId: "vibe-sess-abc123" }, "mistral");
    const grok = parseSessionNewResponse(
      { sessionId: "grok-sess-def456", modes: { currentModeId: "code" } },
      "grok"
    );
    expect(mistral.sessionId).toBe("vibe-sess-abc123");
    expect(grok.sessionId).toBe("grok-sess-def456");
  });

  it("rejects a session/new response missing sessionId", () => {
    expect(() => parseSessionNewResponse({ modes: {} }, "mistral")).toThrow(AcpProtocolError);
  });

  it("rejects a session/new response with an empty sessionId", () => {
    expect(() => parseSessionNewResponse({ sessionId: "" }, "grok")).toThrow(AcpProtocolError);
  });
});

describe("acp types — session/load", () => {
  it("parses a valid session/load request", () => {
    const parsed = SessionLoadRequestSchema.parse({
      sessionId: "vibe-sess-abc123",
      cwd: "/tmp/acp-smoke",
    });
    expect(parsed.sessionId).toBe("vibe-sess-abc123");
    expect(parsed.mcpServers).toEqual([]);
  });

  it("rejects a session/load request missing sessionId", () => {
    expect(() => SessionLoadRequestSchema.parse({ cwd: "/tmp/x" })).toThrow();
  });

  it("parses a session/load response with tolerant extras", () => {
    const parsed = SessionLoadResponseSchema.parse({ modes: { currentModeId: "ask" } });
    expect((parsed.modes as Record<string, unknown>).currentModeId).toBe("ask");
  });
});

describe("acp types — session/prompt", () => {
  it("parses a valid session/prompt request with a text content block", () => {
    const parsed = SessionPromptRequestSchema.parse({
      sessionId: "vibe-sess-abc123",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(parsed.prompt[0].type).toBe("text");
  });

  it("tolerates an unknown content block type carrying a string discriminator", () => {
    const parsed = SessionPromptRequestSchema.parse({
      sessionId: "s1",
      prompt: [{ type: "vendor_thing", payload: { x: 1 } }],
    });
    expect(parsed.prompt[0].type).toBe("vendor_thing");
  });

  it("rejects a session/prompt request with an empty prompt array", () => {
    expect(() => SessionPromptRequestSchema.parse({ sessionId: "s1", prompt: [] })).toThrow();
  });

  it("rejects a content block missing its type discriminator", () => {
    expect(() =>
      SessionPromptRequestSchema.parse({ sessionId: "s1", prompt: [{ text: "no type" }] })
    ).toThrow();
  });

  it("rejects a known content block type that omits its required fields", () => {
    // Round-3 codex finding 3: a KNOWN discriminator (`text`/`image`/`audio`/
    // `resource_link`) missing its required field must fail its strict schema,
    // not silently degrade through the tolerant `{ type: <string> }` fallback.
    expect(() =>
      SessionPromptRequestSchema.parse({ sessionId: "s1", prompt: [{ type: "text" }] })
    ).toThrow();
    expect(() =>
      SessionPromptRequestSchema.parse({ sessionId: "s1", prompt: [{ type: "image", data: "x" }] })
    ).toThrow();
    expect(() =>
      SessionPromptRequestSchema.parse({
        sessionId: "s1",
        prompt: [{ type: "resource_link" }],
      })
    ).toThrow();
  });

  it("parses a session/prompt response stop reason", () => {
    const parsed = parseSessionPromptResponse({ stopReason: "end_turn" }, "mistral");
    expect(parsed.stopReason).toBe("end_turn");
  });

  it("rejects a session/prompt response missing stopReason", () => {
    expect(() => parseSessionPromptResponse({}, "grok")).toThrow(AcpProtocolError);
  });
});

describe("acp types — session/update notification variants", () => {
  it("parses an agent_message_chunk notification with text content", () => {
    const parsed = parseSessionUpdateNotification(
      {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
      "mistral"
    );
    expect((parsed.update as { sessionUpdate: string }).sessionUpdate).toBe("agent_message_chunk");
    expect(isUnknownSessionUpdate(parsed.update as { sessionUpdate: string })).toBe(false);
  });

  it("parses a tool_call notification", () => {
    const parsed = parseSessionUpdateNotification(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Read file",
          status: "pending",
          kind: "read",
        },
      },
      "grok"
    );
    expect((parsed.update as { toolCallId: string }).toolCallId).toBe("tc1");
  });

  it("parses a usage_update notification with token counts", () => {
    const parsed = parseSessionUpdateNotification(
      { sessionId: "s1", update: { sessionUpdate: "usage_update", size: 200000, used: 1234 } },
      "grok"
    );
    expect((parsed.update as { used: number }).used).toBe(1234);
  });

  it("preserves an unknown forward-compatible session/update variant instead of throwing", () => {
    const parsed = parseSessionUpdateNotification(
      {
        sessionId: "s1",
        update: { sessionUpdate: "vendor_future_event", vendorField: { z: 9 } },
      },
      "mistral"
    );
    const update = parsed.update as { sessionUpdate: string; vendorField?: unknown };
    expect(update.sessionUpdate).toBe("vendor_future_event");
    expect(update.vendorField).toEqual({ z: 9 });
    expect(isUnknownSessionUpdate(update)).toBe(true);
  });

  it("does not flag a known variant as unknown", () => {
    for (const variant of KNOWN_SESSION_UPDATE_VARIANTS) {
      expect(isUnknownSessionUpdate({ sessionUpdate: variant })).toBe(false);
    }
  });

  it("rejects a session/update notification missing sessionId", () => {
    expect(() =>
      parseSessionUpdateNotification(
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } },
        "mistral"
      )
    ).toThrow(AcpProtocolError);
  });

  it("rejects a session/update whose update lacks the sessionUpdate discriminator", () => {
    expect(() =>
      parseSessionUpdateNotification({ sessionId: "s1", update: { content: {} } }, "grok")
    ).toThrow(AcpProtocolError);
  });

  it("rejects an agent_message_chunk notification missing required content", () => {
    expect(() =>
      parseSessionUpdateNotification(
        { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
        "mistral"
      )
    ).toThrow(AcpProtocolError);
  });
});

describe("acp types — session/request_permission callback", () => {
  it("parses a valid permission callback request", () => {
    const parsed = parseRequestPermissionRequest(
      {
        sessionId: "s1",
        toolCall: { toolCallId: "tc1", title: "Write file" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
      "grok"
    );
    expect(parsed.options).toHaveLength(2);
    expect(parsed.options[0].optionId).toBe("allow");
  });

  it("rejects a permission request with no options", () => {
    expect(() =>
      parseRequestPermissionRequest({ sessionId: "s1", toolCall: {}, options: [] }, "grok")
    ).toThrow(AcpProtocolError);
  });

  it("rejects a permission request missing the toolCall field", () => {
    expect(() =>
      parseRequestPermissionRequest(
        { sessionId: "s1", options: [{ optionId: "allow", name: "Allow" }] },
        "grok"
      )
    ).toThrow(AcpProtocolError);
  });

  it("parses a selected permission response", () => {
    const parsed = RequestPermissionResponseSchema.parse({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(parsed.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("parses a cancelled permission response", () => {
    const parsed = RequestPermissionResponseSchema.parse({ outcome: { outcome: "cancelled" } });
    expect(parsed.outcome.outcome).toBe("cancelled");
  });

  it("rejects a selected outcome missing optionId", () => {
    expect(() =>
      RequestPermissionResponseSchema.parse({ outcome: { outcome: "selected" } })
    ).toThrow();
  });

  it("rejects an unknown permission outcome discriminator", () => {
    expect(() =>
      RequestPermissionResponseSchema.parse({ outcome: { outcome: "maybe" } })
    ).toThrow();
  });
});

describe("acp types — minimal HostServices file requests", () => {
  it("parses an fs/read_text_file request", () => {
    const parsed = parseReadTextFileRequest(
      { sessionId: "s1", path: "/ws/src/index.ts", line: 1, limit: 50 },
      "mistral"
    );
    expect(parsed.path).toBe("/ws/src/index.ts");
  });

  it("rejects an fs/read_text_file request missing path", () => {
    expect(() => parseReadTextFileRequest({ sessionId: "s1" }, "mistral")).toThrow(
      AcpProtocolError
    );
  });

  it("parses an fs/write_text_file request", () => {
    const parsed = parseWriteTextFileRequest(
      { sessionId: "s1", path: "/ws/out.txt", content: "data" },
      "grok"
    );
    expect(parsed.content).toBe("data");
  });

  it("rejects an fs/write_text_file request missing content", () => {
    expect(() =>
      parseWriteTextFileRequest({ sessionId: "s1", path: "/ws/out.txt" }, "grok")
    ).toThrow(AcpProtocolError);
  });
});

describe("acp types — redaction discipline on parse failure", () => {
  it("does not embed the rejected payload (prompt text / values) in the thrown error", () => {
    const secretPrompt = "SUPER_SECRET_PROMPT_TEXT_DO_NOT_LEAK";
    let caught: unknown;
    try {
      // Missing required stopReason but carrying sensitive material elsewhere.
      parseSessionPromptResponse({ extra: secretPrompt }, "mistral");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AcpProtocolError);
    const error = caught as AcpProtocolError;
    expect(error.message).not.toContain(secretPrompt);
    expect(JSON.stringify(error.debug)).not.toContain(secretPrompt);
    // Debug retains the field-path metadata for diagnosis, not the values.
    expect(error.debug.method).toBe("session/prompt");
  });
});
