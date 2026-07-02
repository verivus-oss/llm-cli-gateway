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
  deriveAcpMethodAvailability,
  isUnknownSessionUpdate,
  parseInitializeResponse,
  parseListSessionsResponse,
  parseReadTextFileRequest,
  parseRequestPermissionRequest,
  parseSessionNewResponse,
  parseSessionPromptResponse,
  parseSessionUpdateNotification,
  parseSetSessionConfigOptionResponse,
  parseWriteTextFileRequest,
  sessionResponseMethods,
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

// Phase-5 Deliverable A: method availability is DERIVED from the parsed
// initialize capability set (a pure function), not a hand-coded provider table.
describe("acp types: deriveAcpMethodAvailability", () => {
  const baseline = ["session/new", "session/prompt", "session/cancel", "session/update"];

  it("returns only the baseline methods for a bare initialize response", () => {
    const methods = deriveAcpMethodAvailability(
      InitializeResponseSchema.parse({ protocolVersion: 1 })
    );
    for (const m of baseline) expect(methods.has(m)).toBe(true);
    expect(methods.has("session/resume")).toBe(false);
    expect(methods.has("session/load")).toBe(false);
    expect(methods.has("authenticate")).toBe(false);
  });

  it("adds session/load from the loadSession capability", () => {
    const methods = deriveAcpMethodAvailability(
      InitializeResponseSchema.parse({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      })
    );
    expect(methods.has("session/load")).toBe(true);
  });

  // Mutation that flips this red: dropping the sessionCapabilities branch in
  // deriveAcpMethodAvailability so advertised methods are no longer derived.
  it("adds resume/list/close/delete only when the matching session capability is present", () => {
    const methods = deriveAcpMethodAvailability(
      InitializeResponseSchema.parse({
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {}, list: {}, close: {}, delete: null },
        },
      })
    );
    expect(methods.has("session/resume")).toBe(true);
    expect(methods.has("session/list")).toBe(true);
    expect(methods.has("session/close")).toBe(true);
    // delete is null -> not advertised -> not available.
    expect(methods.has("session/delete")).toBe(false);
  });

  it("adds authenticate only when authMethods is non-empty", () => {
    const none = deriveAcpMethodAvailability(
      InitializeResponseSchema.parse({ protocolVersion: 1, authMethods: [] })
    );
    expect(none.has("authenticate")).toBe(false);
    const some = deriveAcpMethodAvailability(
      InitializeResponseSchema.parse({
        protocolVersion: 1,
        authMethods: [{ id: "oauth", name: "OAuth" }],
      })
    );
    expect(some.has("authenticate")).toBe(true);
  });

  it("preserves unknown capability keys via passthrough (never dropped)", () => {
    const parsed = InitializeResponseSchema.parse({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, vendorExtension: { foo: 1 } },
    });
    expect((parsed.agentCapabilities as Record<string, unknown>).vendorExtension).toEqual({
      foo: 1,
    });
  });
});

describe("acp types: sessionResponseMethods", () => {
  it("adds set_mode/set_config_option only when modes/configOptions are present", () => {
    expect([...sessionResponseMethods({})]).toEqual([]);
    expect([...sessionResponseMethods({ modes: { currentModeId: "code" } })]).toContain(
      "session/set_mode"
    );
    expect([...sessionResponseMethods({ configOptions: [{ configId: "x" }] })]).toContain(
      "session/set_config_option"
    );
  });
});

// BLOCKER 3 (correctness): response schemas must be strict on the fields the ACP
// spec marks required, so a malformed response is a protocol error, not a
// silently-accepted success. Mutation that flips each red: reverting the schema
// field back to optional/loose (e.g. `sessions: ...optional()`, `configOptions`
// absent, `SessionInfo` without required cwd). The malformed payload would then
// parse and these expects flip.
describe("acp types: strict-but-passthrough required-field validation", () => {
  it("session/list requires `sessions` and rejects an entry missing required cwd", () => {
    // Valid: sessions present, each entry has sessionId + cwd (spec-required).
    const ok = parseListSessionsResponse({
      sessions: [{ sessionId: "s1", cwd: "/abs/work", title: "t" }],
    });
    expect(ok.sessions).toHaveLength(1);

    // Missing `sessions` entirely => protocol error (not an empty success).
    expect(() => parseListSessionsResponse({ nextCursor: "c" })).toThrow(AcpProtocolError);

    // Entry missing the required `cwd` => protocol error.
    expect(() => parseListSessionsResponse({ sessions: [{ sessionId: "s1" }] })).toThrow(
      AcpProtocolError
    );

    // Vendor extras on entries survive via passthrough.
    const extra = parseListSessionsResponse({
      sessions: [{ sessionId: "s1", cwd: "/abs/work", vendorField: 42 }],
    });
    expect((extra.sessions[0] as Record<string, unknown>).vendorField).toBe(42);
  });

  it("session/set_config_option requires `configOptions` with well-formed union entries", () => {
    // Valid `select` variant: type + currentValue + options are spec-required.
    // Mutation that flips this red: dropping `currentValue`/`options` from the
    // select member of SessionConfigOptionSchema (or reverting to the flat
    // { id, name } shape) would make this well-formed option fail to parse.
    const ok = parseSetSessionConfigOptionResponse({
      configOptions: [
        {
          type: "select",
          id: "theme",
          name: "Theme",
          currentValue: "dark",
          options: [{ value: "dark", label: "Dark" }, { value: "light" }],
          vendorFlag: true,
        },
      ],
    });
    expect(ok.configOptions).toHaveLength(1);
    // Vendor extras survive via passthrough.
    expect((ok.configOptions[0] as Record<string, unknown>).vendorFlag).toBe(true);

    // Valid `boolean` variant: type + boolean currentValue are spec-required.
    const okBool = parseSetSessionConfigOptionResponse({
      configOptions: [{ type: "boolean", id: "wrap", name: "Wrap", currentValue: false }],
    });
    expect((okBool.configOptions[0] as Record<string, unknown>).currentValue).toBe(false);

    // Missing `configOptions` entirely => protocol error (not an empty success).
    // Mutation: making `configOptions` optional/nullish would let {} parse.
    expect(() => parseSetSessionConfigOptionResponse({})).toThrow(AcpProtocolError);

    // Entry missing the discriminant `type` => protocol error (union rejects it).
    // Mutation: reverting to a flat object schema (no `type` discriminator).
    expect(() =>
      parseSetSessionConfigOptionResponse({ configOptions: [{ id: "theme", name: "Theme" }] })
    ).toThrow(AcpProtocolError);

    // A `select` entry missing the required `currentValue` => protocol error.
    // Mutation: making `currentValue` optional on the select member.
    expect(() =>
      parseSetSessionConfigOptionResponse({
        configOptions: [
          { type: "select", id: "theme", name: "Theme", options: [{ value: "dark" }] },
        ],
      })
    ).toThrow(AcpProtocolError);
  });

  it("config_option_update is a strict known union variant (requires configOptions)", () => {
    // Valid config_option_update: configOptions array of well-formed union options.
    const ok = parseSessionUpdateNotification({
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ type: "boolean", id: "theme", name: "Theme", currentValue: true }],
      },
    });
    expect((ok.update as Record<string, unknown>).sessionUpdate).toBe("config_option_update");

    // A config_option_update missing its required `configOptions` is rejected as
    // a KNOWN variant (it does not fall through to the tolerant unknown shape).
    expect(() =>
      parseSessionUpdateNotification({
        sessionId: "s1",
        update: { sessionUpdate: "config_option_update" },
      })
    ).toThrow(AcpProtocolError);

    // A config_option_update whose entry omits the discriminant `type` is a
    // protocol error. Mutation: reverting to the flat { id, name } shape.
    expect(() =>
      parseSessionUpdateNotification({
        sessionId: "s1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "theme", name: "Theme" }],
        },
      })
    ).toThrow(AcpProtocolError);
  });
});
