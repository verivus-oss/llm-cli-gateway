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

// ---------------------------------------------------------------------------
// Agent capability set (parsed from the initialize response)
//
// Per the ACP spec (https://agentclientprotocol.com/protocol/schema) the agent
// advertises its supported methods through TYPED capability fields rather than a
// method list. Each schema below is vendor-tolerant (`.passthrough()`), so an
// unknown vendor field is PRESERVED on the parsed object (surfaced downstream as
// discovered-unmapped) rather than dropped or rejected.
// ---------------------------------------------------------------------------

/**
 * An optional session sub-capability. Per the ACP spec, an object (`{}`) means
 * the agent supports the method; `null`/omitted both mean it does not. Vendor
 * extension keys survive via passthrough.
 */
const SessionSubCapabilitySchema = z.object({ _meta: MetaSchema }).passthrough().nullish();

/** Prompt content-type capabilities advertised by the agent. */
export const PromptCapabilitiesSchema = z
  .object({
    image: z.boolean().optional(),
    audio: z.boolean().optional(),
    embeddedContext: z.boolean().optional(),
    _meta: MetaSchema,
  })
  .passthrough();
export type PromptCapabilities = z.infer<typeof PromptCapabilitiesSchema>;

/** MCP transport capabilities advertised by the agent. */
export const McpCapabilitiesSchema = z
  .object({
    http: z.boolean().optional(),
    sse: z.boolean().optional(),
    _meta: MetaSchema,
  })
  .passthrough();
export type McpCapabilities = z.infer<typeof McpCapabilitiesSchema>;

/** Session lifecycle capabilities advertised by the agent. */
export const SessionCapabilitiesSchema = z
  .object({
    resume: SessionSubCapabilitySchema,
    list: SessionSubCapabilitySchema,
    close: SessionSubCapabilitySchema,
    delete: SessionSubCapabilitySchema,
    additionalDirectories: SessionSubCapabilitySchema,
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

/** Authentication-related capabilities advertised by the agent. */
export const AgentAuthCapabilitiesSchema = z
  .object({
    logout: z.object({ _meta: MetaSchema }).passthrough().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type AgentAuthCapabilities = z.infer<typeof AgentAuthCapabilitiesSchema>;

/** The agent capability bag advertised in the `initialize` response. */
export const AgentCapabilitiesSchema = z
  .object({
    loadSession: z.boolean().optional(),
    promptCapabilities: PromptCapabilitiesSchema.optional(),
    mcpCapabilities: McpCapabilitiesSchema.optional(),
    sessionCapabilities: SessionCapabilitiesSchema.optional(),
    auth: AgentAuthCapabilitiesSchema.optional(),
    _meta: MetaSchema,
  })
  .passthrough();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** A single advertised authentication method. */
export const AuthMethodSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/**
 * `initialize` response. `protocolVersion` is required and strict. Capability
 * fields (`agentCapabilities`, `authMethods`) are parsed into typed, tolerant
 * schemas so method availability can be DERIVED from them
 * ({@link deriveAcpMethodAvailability}); vendor extras survive via passthrough
 * (Mistral nests `agentInfo.{name,version}`; Grok advertises a flat
 * `agentVersion` bag).
 */
export const InitializeResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    agentCapabilities: AgentCapabilitiesSchema.optional(),
    agentInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z.array(AuthMethodSchema).optional(),
    _meta: MetaSchema,
  })
  .passthrough();

export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

// ---------------------------------------------------------------------------
// Capability-driven method availability (pure derivation)
// ---------------------------------------------------------------------------

/**
 * ACP methods every conformant agent MUST support (spec baseline). They are
 * always available and never gated on an advertised capability.
 */
export const BASELINE_ACP_METHODS = [
  "session/new",
  "session/prompt",
  "session/cancel",
  "session/update",
] as const;

/** A session sub-capability is "present" (supported) when it is a non-null object. */
function subCapabilityPresent(value: unknown): boolean {
  return value !== null && value !== undefined && typeof value === "object";
}

/**
 * Derive the set of ACP methods a client may call from the parsed `initialize`
 * capability set. Pure: no I/O, no provider table, no hand-coded per-provider
 * branch. Baseline methods are always present; every optional method is added
 * ONLY when the agent advertised the matching capability.
 *
 * Note: `session/set_mode` and `session/set_config_option` are advertised
 * per-session (via `modes`/`configOptions` on the `session/new` /
 * `session/load` response), not in `initialize`; augment the initialize-derived
 * set with {@link sessionResponseMethods} once a session is created/loaded.
 */
export function deriveAcpMethodAvailability(init: InitializeResponse): ReadonlySet<string> {
  const methods = new Set<string>(BASELINE_ACP_METHODS);
  const caps = init.agentCapabilities;
  if (caps?.loadSession === true) {
    methods.add("session/load");
  }
  const sc = caps?.sessionCapabilities;
  if (sc) {
    if (subCapabilityPresent(sc.resume)) methods.add("session/resume");
    if (subCapabilityPresent(sc.list)) methods.add("session/list");
    if (subCapabilityPresent(sc.close)) methods.add("session/close");
    if (subCapabilityPresent(sc.delete)) methods.add("session/delete");
  }
  if (Array.isArray(init.authMethods) && init.authMethods.length > 0) {
    methods.add("authenticate");
  }
  return methods;
}

/**
 * Per-session methods advertised on a `session/new` / `session/load` response:
 * `session/set_mode` when the response carries `modes`, and
 * `session/set_config_option` when it carries `configOptions`. Pure.
 */
export function sessionResponseMethods(response: {
  readonly modes?: unknown;
  readonly configOptions?: unknown;
}): ReadonlySet<string> {
  const methods = new Set<string>();
  if (response.modes !== null && response.modes !== undefined) {
    methods.add("session/set_mode");
  }
  if (response.configOptions !== null && response.configOptions !== undefined) {
    methods.add("session/set_config_option");
  }
  return methods;
}

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
    modes: z.record(z.unknown()).nullish(),
    configOptions: z.array(z.record(z.unknown())).nullish(),
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
    modes: z.record(z.unknown()).nullish(),
    configOptions: z.array(z.record(z.unknown())).nullish(),
    _meta: MetaSchema,
  })
  .passthrough();

export type SessionLoadResponse = z.infer<typeof SessionLoadResponseSchema>;

// ---------------------------------------------------------------------------
// session/resume, session/list, session/close, session/delete,
// session/set_mode, session/set_config_option (client -> agent)
//
// Each is capability-gated by the client (see AcpClient). The request/response
// shapes follow the ACP spec; provider extras survive via passthrough.
// ---------------------------------------------------------------------------

export const SessionResumeRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    cwd: z.string().min(1),
    mcpServers: z.array(McpServerSchema).default([]),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionResumeRequest = z.infer<typeof SessionResumeRequestSchema>;

/** `session/resume` response mirrors `session/load` (modes/configOptions extras). */
export const SessionResumeResponseSchema = z
  .object({
    modes: z.record(z.unknown()).nullish(),
    configOptions: z.array(z.record(z.unknown())).nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionResumeResponse = z.infer<typeof SessionResumeResponseSchema>;

/**
 * ACP `SessionMode`: a mode the agent can operate in. `id` and `name` are
 * required per the spec; vendor extras survive via passthrough.
 */
export const SessionModeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionMode = z.infer<typeof SessionModeSchema>;

/**
 * ACP `SessionModeState` (the `modes` object on a session/new|load response):
 * `currentModeId` and `availableModes` are BOTH required per the spec. A
 * `modes` object missing either is rejected rather than accepted as success.
 */
export const SessionModeStateSchema = z
  .object({
    currentModeId: z.string().min(1),
    availableModes: z.array(SessionModeSchema),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionModeState = z.infer<typeof SessionModeStateSchema>;

/**
 * ACP `SessionConfigSelectValue`: one selectable value of a `select` config
 * option. `value` (the value id) is required per the spec; a human-readable
 * `label`/`description` and vendor extras survive via passthrough.
 */
export const SessionConfigSelectValueSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().nullish(),
    description: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionConfigSelectValue = z.infer<typeof SessionConfigSelectValueSchema>;

/**
 * ACP `SessionConfigOption`: a discriminated union on `type` describing a
 * config selector and its current state. Shared base fields `id`/`name` are
 * required (`description`/`category` optional). The `select` variant additionally
 * requires `currentValue` (a value id string) and `options`; the `boolean`
 * variant requires a boolean `currentValue`. A payload missing `type` or the
 * variant's required `currentValue` is rejected rather than accepted as a
 * success; vendor extras survive via passthrough.
 */
export const SessionConfigOptionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("select"),
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().nullish(),
      category: z.string().nullish(),
      currentValue: z.string().min(1),
      options: z.array(SessionConfigSelectValueSchema),
      _meta: MetaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("boolean"),
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().nullish(),
      category: z.string().nullish(),
      currentValue: z.boolean(),
      _meta: MetaSchema,
    })
    .passthrough(),
]);
export type SessionConfigOption = z.infer<typeof SessionConfigOptionSchema>;

/**
 * ACP `SessionInfo` (a `session/list` entry): `sessionId` and `cwd` are BOTH
 * required per the spec. An entry missing either is rejected (a malformed list
 * row is a protocol error, not a silently-accepted success).
 */
export const SessionInfoSchema = z
  .object({
    sessionId: SessionIdSchema,
    cwd: z.string().min(1),
    additionalDirectories: z.array(z.string()).optional(),
    title: z.string().nullish(),
    updatedAt: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ListSessionsRequestSchema = z
  .object({
    cursor: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type ListSessionsRequest = z.infer<typeof ListSessionsRequestSchema>;

/**
 * `session/list` response: `sessions` is REQUIRED per the ACP spec (an array of
 * {@link SessionInfoSchema} entries). A response omitting `sessions`, or with a
 * malformed entry, fails to parse instead of being accepted as an empty success.
 */
export const ListSessionsResponseSchema = z
  .object({
    sessions: z.array(SessionInfoSchema),
    nextCursor: z.string().nullish(),
    _meta: MetaSchema,
  })
  .passthrough();
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const CloseSessionRequestSchema = z
  .object({ sessionId: SessionIdSchema, _meta: MetaSchema })
  .passthrough();
export type CloseSessionRequest = z.infer<typeof CloseSessionRequestSchema>;

export const CloseSessionResponseSchema = z.object({ _meta: MetaSchema }).passthrough();
export type CloseSessionResponse = z.infer<typeof CloseSessionResponseSchema>;

export const DeleteSessionRequestSchema = z
  .object({ sessionId: SessionIdSchema, _meta: MetaSchema })
  .passthrough();
export type DeleteSessionRequest = z.infer<typeof DeleteSessionRequestSchema>;

export const DeleteSessionResponseSchema = z.object({ _meta: MetaSchema }).passthrough();
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

export const SetSessionModeRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    modeId: z.string().min(1),
    _meta: MetaSchema,
  })
  .passthrough();
export type SetSessionModeRequest = z.infer<typeof SetSessionModeRequestSchema>;

export const SetSessionModeResponseSchema = z.object({ _meta: MetaSchema }).passthrough();
export type SetSessionModeResponse = z.infer<typeof SetSessionModeResponseSchema>;

export const SetSessionConfigOptionRequestSchema = z
  .object({
    sessionId: SessionIdSchema,
    configId: z.string().min(1),
    // Per the ACP spec `value` is a SessionConfigValueId (a non-empty string,
    // the id of the option value to select), not an arbitrary payload.
    value: z.string().min(1),
    _meta: MetaSchema,
  })
  .passthrough();
export type SetSessionConfigOptionRequest = z.infer<typeof SetSessionConfigOptionRequestSchema>;

/**
 * `session/set_config_option` response: `configOptions` (the full set of
 * options and their current values) is REQUIRED per the ACP spec. A response
 * omitting it, or carrying a malformed option, fails to parse rather than being
 * accepted as a success.
 */
export const SetSessionConfigOptionResponseSchema = z
  .object({
    configOptions: z.array(SessionConfigOptionSchema),
    _meta: MetaSchema,
  })
  .passthrough();
export type SetSessionConfigOptionResponse = z.infer<typeof SetSessionConfigOptionResponseSchema>;

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
 * `config_option_update` (ConfigOptionUpdate): the agent reports the full set of
 * configuration options and their current values. `configOptions` is REQUIRED
 * per the ACP spec (an array of {@link SessionConfigOptionSchema}); a malformed
 * update is rejected rather than degrading to the tolerant fallback.
 */
const ConfigOptionUpdate = z
  .object({
    sessionUpdate: z.literal("config_option_update"),
    configOptions: z.array(SessionConfigOptionSchema),
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
  config_option_update: ConfigOptionUpdate,
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

/**
 * Canonical known `sessionUpdate` discriminators, for normalizers.
 *
 * MUST stay in lock-step with {@link KNOWN_UPDATE_SCHEMAS}: every entry here is a
 * variant whose required fields are strictly validated. A variant listed here
 * but missing a schema would be reported "known" by {@link isUnknownSessionUpdate}
 * while the schema layer silently accepts it unvalidated (the two notions must
 * not disagree). `session_info_update` is intentionally absent: it has no strict
 * schema and no normalizer handling, so it is treated as a forward-compatible
 * unknown variant (tolerant passthrough) exactly like any other unrecognised
 * discriminator.
 */
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

/** Parse a `session/resume` response. */
export function parseSessionResumeResponse(
  value: unknown,
  provider?: CliType
): SessionResumeResponse {
  return parseAcp(SessionResumeResponseSchema, value, { method: "session/resume", provider });
}

/** Parse a `session/list` response. */
export function parseListSessionsResponse(
  value: unknown,
  provider?: CliType
): ListSessionsResponse {
  return parseAcp(ListSessionsResponseSchema, value, { method: "session/list", provider });
}

/** Parse a `session/close` response. */
export function parseCloseSessionResponse(
  value: unknown,
  provider?: CliType
): CloseSessionResponse {
  return parseAcp(CloseSessionResponseSchema, value, { method: "session/close", provider });
}

/** Parse a `session/delete` response. */
export function parseDeleteSessionResponse(
  value: unknown,
  provider?: CliType
): DeleteSessionResponse {
  return parseAcp(DeleteSessionResponseSchema, value, { method: "session/delete", provider });
}

/** Parse a `session/set_mode` response. */
export function parseSetSessionModeResponse(
  value: unknown,
  provider?: CliType
): SetSessionModeResponse {
  return parseAcp(SetSessionModeResponseSchema, value, { method: "session/set_mode", provider });
}

/** Parse a `session/set_config_option` response. */
export function parseSetSessionConfigOptionResponse(
  value: unknown,
  provider?: CliType
): SetSessionConfigOptionResponse {
  return parseAcp(SetSessionConfigOptionResponseSchema, value, {
    method: "session/set_config_option",
    provider,
  });
}
