/**
 * ACP protocol types and Zod schemas.
 *
 * This module owns the provider-neutral, Zod-backed schemas for the Agent
 * Client Protocol (ACP) methods this slice needs:
 *
 *   - `initialize`
 *   - `session/new`
 *   - `session/load` (resume)
 *   - `session/prompt`
 *   - `session/cancel` (notification)
 *   - `session/update` (notification, discriminated union)
 *   - `session/request_permission` (agent -> client callback)
 *   - a minimal slice of HostServices file requests (`fs/read_text_file`,
 *     `fs/write_text_file`)
 *
 * Parsing policy (from the DAG step `define-acp-protocol-types`):
 *
 *   - Required protocol fields are STRICT: `protocolVersion`, `sessionId`,
 *     discriminators (`sessionUpdate`, content-block `type`), etc. are validated
 *     and missing/wrong-typed required fields are rejected.
 *   - Provider-specific metadata is TOLERANT: objects that providers extend with
 *     vendor fields (`agentInfo`, `agentCapabilities`, `_meta`, capability bags)
 *     are parsed with `.passthrough()` so unknown extra keys survive instead of
 *     failing the parse. The Mistral Vibe and Grok smoke responses differ in
 *     exactly this way (Mistral reports `agentInfo.{name,version}`; Grok reports
 *     an `agentVersion` style metadata bag plus MCP capability advertisements),
 *     and both must parse.
 *   - Unknown `session/update` variants do not throw: the discriminated union
 *     has a tolerant fallback variant so forward-compatible notifications are
 *     preserved as `{ sessionUpdate: <string>, ... }` rather than crashing the
 *     event loop.
 *
 * Security invariants honoured here:
 *
 *   - No `console.log`; this module performs no I/O and writes nothing to
 *     stdout (`stdout_reserved_for_mcp`).
 *   - Parse failures throw {@link AcpProtocolError}, whose user-facing message is
 *     redacted at construction. We deliberately do NOT embed the raw rejected
 *     payload in the thrown error (`no_prompt_payloads_in_default_logs`,
 *     `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`). Only the
 *     Zod issue *paths* (field locations, not values) are attached to debug
 *     metadata, which the error class redacts again before any log sink.
 */

import { z } from "zod/v3";

import { AcpProtocolError } from "./errors.js";
import type { CliType } from "../session-manager.js";

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/** ACP protocol version. Target providers (Mistral, Grok) report `1`. */
export const ProtocolVersionSchema = z.number().int().nonnegative();

/** Opaque provider-owned session id. Never reused as a gateway session id. */
export const SessionIdSchema = z.string().min(1);

/** Reserved ACP extensibility bag. Always tolerant. */
const MetaSchema = z.record(z.unknown()).optional();

// ---------------------------------------------------------------------------
// Content blocks (session/prompt input + streamed chunks)
// ---------------------------------------------------------------------------

/**
 * Discriminators with a strict schema above. The tolerant fallback excludes
 * these so a malformed *known* block fails validation instead of degrading.
 */
const KNOWN_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource_link", "resource"]);

/**
 * ACP `ContentBlock` union. The `type` discriminator is strict; vendor fields
 * are tolerated via passthrough. An *unknown* content type degrades to a
 * tolerant `{ type: <string> }` shape rather than failing; a *known* type that
 * omits its required fields is rejected (it does not fall through to the
 * tolerant shape).
 */
export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), text: z.string(), _meta: MetaSchema }).passthrough(),
    z
      .object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
        _meta: MetaSchema,
      })
      .passthrough(),
    z
      .object({
        type: z.literal("audio"),
        data: z.string(),
        mimeType: z.string(),
        _meta: MetaSchema,
      })
      .passthrough(),
    z
      .object({
        type: z.literal("resource_link"),
        uri: z.string(),
        _meta: MetaSchema,
      })
      .passthrough(),
    z.object({ type: z.literal("resource"), _meta: MetaSchema }).passthrough(),
    // Tolerant fallback: keep forward-compatible content types alive as long as
    // they carry a string discriminator. Restricted to UNKNOWN discriminators so
    // a malformed known block (e.g. `{ type: "text" }` with no `text`) fails its
    // strict schema instead of silently degrading to the tolerant shape.
    z
      .object({
        type: z.string().refine(t => !KNOWN_CONTENT_BLOCK_TYPES.has(t), {
          message: "known content block type missing required fields",
        }),
      })
      .passthrough(),
  ])
);

export interface ContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

/**
 * Client filesystem capabilities advertised in `initialize`. All default to
 * false so the read-only smoke phase advertises no write/terminal surface.
 */
export const ClientFsCapabilitiesSchema = z
  .object({
    readTextFile: z.boolean().optional(),
    writeTextFile: z.boolean().optional(),
  })
  .passthrough();

export const ClientCapabilitiesSchema = z
  .object({
    fs: ClientFsCapabilitiesSchema.optional(),
    terminal: z.boolean().optional(),
  })
  .passthrough();

export const InitializeRequestSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    clientCapabilities: ClientCapabilitiesSchema.optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type InitializeRequest = z.infer<typeof InitializeRequestSchema>;

/**
 * `initialize` response. `protocolVersion` is required and strict.
 * `agentCapabilities`, `agentInfo`, and `authMethods` are tolerant because
 * provider shapes diverge (Mistral nests `agentInfo.{name,version}`; Grok
 * advertises an `agentVersion`/MCP capability bag).
 */
export const InitializeResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    agentCapabilities: z.record(z.unknown()).optional(),
    agentInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z.array(z.record(z.unknown())).optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

/** A single MCP server descriptor passed to the agent at session creation. */
export const McpServerSchema = z.record(z.unknown());

export const SessionNewRequestSchema = z
  .object({
    cwd: z.string().min(1),
    mcpServers: z.array(McpServerSchema).default([]),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionNewRequest = z.infer<typeof SessionNewRequestSchema>;

/**
 * `session/new` response. `sessionId` is required and strict. `modes` and other
 * provider extras are tolerant.
 */
export const SessionNewResponseSchema = z
  .object({
    sessionId: SessionIdSchema,
    modes: z.record(z.unknown()).optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionNewResponse = z.infer<typeof SessionNewResponseSchema>;

// ---------------------------------------------------------------------------
// session/load (resume)
// ---------------------------------------------------------------------------

export const SessionLoadRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    cwd: z.string().min(1),
    mcpServers: z.array(McpServerSchema).default([]),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionLoadRequest = z.infer<typeof SessionLoadRequestSchema>;

/** `session/load` response carries no required fields beyond tolerant extras. */
export const SessionLoadResponseSchema = z
  .object({
    modes: z.record(z.unknown()).optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionLoadResponse = z.infer<typeof SessionLoadResponseSchema>;

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

export const SessionPromptRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    prompt: z.array(ContentBlockSchema).min(1),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionPromptRequest = z.infer<typeof SessionPromptRequestSchema>;

/**
 * Known ACP stop reasons. The schema accepts any string so an unknown future
 * stop reason does not reject a completed turn, but the canonical set is
 * exported for normalizers.
 */
export const STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;

export const SessionPromptResponseSchema = z
  .object({
    stopReason: z.string().min(1),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionPromptResponse = z.infer<typeof SessionPromptResponseSchema>;

// ---------------------------------------------------------------------------
// session/cancel (notification, client -> agent)
// ---------------------------------------------------------------------------

export const SessionCancelNotificationSchema = z
  .object({
    sessionId: SessionIdSchema,
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionCancelNotification = z.infer<typeof SessionCancelNotificationSchema>;

// ---------------------------------------------------------------------------
// session/update (notification, agent -> client)
// ---------------------------------------------------------------------------

const MessageChunkUpdate = (variant: string): z.ZodTypeAny =>
  z
    .object({
      sessionUpdate: z.literal(variant),
      content: ContentBlockSchema,
      messageId: z.string().nullish(),
      _meta: MetaSchema,
    })
    .passthrough();

const ToolCallUpdate = z
  .object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string().min(1),
    title: z.string(),
    status: z.string().optional(),
    kind: z.string().optional(),
    _meta: MetaSchema,
  })
  .passthrough();

const ToolCallUpdateUpdate = z
  .object({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string().min(1),
    status: z.string().nullish(),
    title: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();

const PlanUpdate = z
  .object({
    sessionUpdate: z.literal("plan"),
    entries: z.array(z.record(z.unknown())),
    _meta: MetaSchema,
  })
  .passthrough();

const AvailableCommandsUpdate = z
  .object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(z.record(z.unknown())),
    _meta: MetaSchema,
  })
  .passthrough();

const CurrentModeUpdate = z
  .object({
    sessionUpdate: z.literal("current_mode_update"),
    currentModeId: z.string().min(1),
    _meta: MetaSchema,
  })
  .passthrough();

const UsageUpdate = z
  .object({
    sessionUpdate: z.literal("usage_update"),
    size: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    cost: z.record(z.unknown()).nullish(),
    _meta: MetaSchema,
  })
  .passthrough();

/**
 * Strict per-variant schemas keyed by discriminator. When the discriminator is
 * one we recognise, that variant's required fields are enforced. When the
 * discriminator is unrecognised, parsing degrades to a tolerant passthrough so
 * a new provider variant cannot crash the event loop. This keeps required
 * fields strict for known variants (a malformed `agent_message_chunk` is
 * rejected) while staying forward compatible.
 */
const KNOWN_UPDATE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  user_message_chunk: MessageChunkUpdate("user_message_chunk"),
  agent_message_chunk: MessageChunkUpdate("agent_message_chunk"),
  agent_thought_chunk: MessageChunkUpdate("agent_thought_chunk"),
  tool_call: ToolCallUpdate,
  tool_call_update: ToolCallUpdateUpdate,
  plan: PlanUpdate,
  available_commands_update: AvailableCommandsUpdate,
  current_mode_update: CurrentModeUpdate,
  usage_update: UsageUpdate,
};

export const SessionUpdateSchema: z.ZodTypeAny = z
  .object({ sessionUpdate: z.string().min(1) })
  .passthrough()
  .superRefine((value, ctx) => {
    const known = KNOWN_UPDATE_SCHEMAS[value.sessionUpdate];
    if (!known) {
      // Unknown discriminator: accept via the tolerant fallback.
      return;
    }
    const result = known.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
    }
  });

export const SessionUpdateNotificationSchema = z
  .object({
    sessionId: SessionIdSchema,
    update: SessionUpdateSchema,
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionUpdateNotification = z.infer<typeof SessionUpdateNotificationSchema>;

/** Canonical known `sessionUpdate` discriminators, for normalizers. */
export const KNOWN_SESSION_UPDATE_VARIANTS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
] as const;

/** True when a parsed session/update is a forward-compatible unknown variant. */
export function isUnknownSessionUpdate(update: { sessionUpdate: string }): boolean {
  return !(KNOWN_SESSION_UPDATE_VARIANTS as readonly string[]).includes(update.sessionUpdate);
}

// ---------------------------------------------------------------------------
// session/request_permission (agent -> client callback)
// ---------------------------------------------------------------------------

export const PermissionOptionSchema = z
  .object({
    optionId: z.string().min(1),
    name: z.string(),
    kind: z.string().optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

export const RequestPermissionRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    options: z.array(PermissionOptionSchema).min(1),
    toolCall: z.record(z.unknown()),
    _meta: MetaSchema,
  })
  .passthrough();

export type RequestPermissionRequest = z.infer<typeof RequestPermissionRequestSchema>;

/**
 * `RequestPermissionOutcome` union. The host either selects an option id or
 * cancels the turn. The `outcome` discriminator is strict.
 */
export const RequestPermissionOutcomeSchema = z.union([
  z.object({ outcome: z.literal("cancelled") }).passthrough(),
  z.object({ outcome: z.literal("selected"), optionId: z.string().min(1) }).passthrough(),
]);

export const RequestPermissionResponseSchema = z
  .object({
    outcome: RequestPermissionOutcomeSchema,
    _meta: MetaSchema,
  })
  .passthrough();

export type RequestPermissionResponse = z.infer<typeof RequestPermissionResponseSchema>;

// ---------------------------------------------------------------------------
// Minimal HostServices file requests (agent -> client)
// ---------------------------------------------------------------------------

export const ReadTextFileRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    line: z.number().int().nonnegative().nullish(),
    limit: z.number().int().nonnegative().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();

export type ReadTextFileRequest = z.infer<typeof ReadTextFileRequestSchema>;

export const ReadTextFileResponseSchema = z
  .object({
    content: z.string(),
    _meta: MetaSchema,
  })
  .passthrough();

export type ReadTextFileResponse = z.infer<typeof ReadTextFileResponseSchema>;

export const WriteTextFileRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    content: z.string(),
    _meta: MetaSchema,
  })
  .passthrough();

export type WriteTextFileRequest = z.infer<typeof WriteTextFileRequestSchema>;

export const WriteTextFileResponseSchema = z.object({ _meta: MetaSchema }).passthrough();

export type WriteTextFileResponse = z.infer<typeof WriteTextFileResponseSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse `value` with `schema`, throwing a redacted {@link AcpProtocolError} on
 * failure. The thrown error never embeds the rejected payload: only the failing
 * field *paths* (not values) are attached as debug metadata, which the error
 * class redacts again before any log sink. This keeps raw JSON-RPC bodies and
 * prompt text out of logs and out of MCP-client-visible messages.
 */
export function parseAcp<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: { method: string; provider?: CliType }
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issuePaths = result.error.issues.map(issue => ({
    path: issue.path.join("."),
    code: issue.code,
  }));

  throw new AcpProtocolError(`Malformed ACP ${context.method} payload`, {
    provider: context.provider,
    debug: { method: context.method, issues: issuePaths },
  });
}

/** Parse an `initialize` response. */
export function parseInitializeResponse(value: unknown, provider?: CliType): InitializeResponse {
  return parseAcp(InitializeResponseSchema, value, { method: "initialize", provider });
}

/** Parse a `session/new` response. */
export function parseSessionNewResponse(value: unknown, provider?: CliType): SessionNewResponse {
  return parseAcp(SessionNewResponseSchema, value, { method: "session/new", provider });
}

/** Parse a `session/load` response. */
export function parseSessionLoadResponse(value: unknown, provider?: CliType): SessionLoadResponse {
  return parseAcp(SessionLoadResponseSchema, value, { method: "session/load", provider });
}

/** Parse a `session/prompt` response. */
export function parseSessionPromptResponse(
  value: unknown,
  provider?: CliType
): SessionPromptResponse {
  return parseAcp(SessionPromptResponseSchema, value, { method: "session/prompt", provider });
}

/** Parse a `session/update` notification. */
export function parseSessionUpdateNotification(
  value: unknown,
  provider?: CliType
): SessionUpdateNotification {
  return parseAcp(SessionUpdateNotificationSchema, value, {
    method: "session/update",
    provider,
  });
}

/** Parse a `session/request_permission` callback request. */
export function parseRequestPermissionRequest(
  value: unknown,
  provider?: CliType
): RequestPermissionRequest {
  return parseAcp(RequestPermissionRequestSchema, value, {
    method: "session/request_permission",
    provider,
  });
}

/** Parse an `fs/read_text_file` host request. */
export function parseReadTextFileRequest(value: unknown, provider?: CliType): ReadTextFileRequest {
  return parseAcp(ReadTextFileRequestSchema, value, {
    method: "fs/read_text_file",
    provider,
  });
}

/** Parse an `fs/write_text_file` host request. */
export function parseWriteTextFileRequest(
  value: unknown,
  provider?: CliType
): WriteTextFileRequest {
  return parseAcp(WriteTextFileRequestSchema, value, {
    method: "fs/write_text_file",
    provider,
  });
}
