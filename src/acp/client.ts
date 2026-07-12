/**
 * High-level ACP client.
 *
 * This module is the protocol wrapper gateway code uses to drive a provider
 * Agent Client Protocol (ACP) agent. It sits on top of the line-delimited
 * JSON-RPC transport (`src/acp/json-rpc-stdio.ts`) and exposes the small,
 * provider-neutral surface the architecture's `client` slice calls for:
 *
 *   - {@link AcpClient.initialize} once per process,
 *   - {@link AcpClient.newSession} / {@link AcpClient.loadSession} to create or
 *     resume an ACP session,
 *   - {@link AcpClient.prompt} to send a turn,
 *   - {@link AcpClient.cancel} to cancel an in-flight turn,
 *   - streamed `session/update` notifications surfaced through callbacks,
 *   - agent-initiated callbacks (`fs/read_text_file`, `fs/write_text_file`,
 *     `session/request_permission`) dispatched into {@link HostServices}.
 *
 * Binding constraints honoured here:
 *
 *   - The client is provider-spawn agnostic. It NEVER knows or constructs a
 *     provider command line; it receives an already-opened transport from the
 *     process manager. This keeps `no_shell_eval_for_entrypoints` and
 *     `no_arbitrary_subcommand_execution` out of this layer entirely.
 *   - No `console.log` and no writes to gateway stdout. The transport owns the
 *     provider stdio; this client only logs through the injected gateway logger
 *     (stderr) and restricts those logs to method names, providers, durations,
 *     and error classes (`stdout_reserved_for_mcp`,
 *     `no_prompt_payloads_in_default_logs`).
 *   - Every failure surfaces as a typed {@link AcpError}. Transport errors are
 *     already redacted {@link AcpError}s; any other thrown value is normalised
 *     into an {@link AcpProtocolError} whose user-facing message is redacted at
 *     construction. Raw JSON-RPC bodies, prompt text, and file contents never
 *     reach a thrown error's user message
 *     (`acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`).
 *   - Permission callbacks are NOT decided here. The client delegates every
 *     `session/request_permission` to {@link HostServices.requestPermission};
 *     the host (a later slice) routes them through ApprovalManager
 *     (`approval_manager_required_for_provider_permissions`). The client only
 *     marshals the request and the host's decision back onto the wire.
 */

import {
  AcpError,
  AcpMethodUnsupportedError,
  AcpMutatingDisabledError,
  AcpProtocolError,
  isAcpError,
} from "./errors.js";
import type { JsonRpcStdioTransport, JsonRpcId } from "./json-rpc-stdio.js";
import {
  deriveAcpMethodAvailability,
  parseCloseSessionResponse,
  parseDeleteSessionResponse,
  parseInitializeResponse,
  parseListSessionsResponse,
  parseReadTextFileRequest,
  parseRequestPermissionRequest,
  parseSessionLoadResponse,
  parseSessionNewResponse,
  parseSessionPromptResponse,
  parseSessionResumeResponse,
  parseSessionUpdateNotification,
  parseSetSessionConfigOptionResponse,
  parseSetSessionModeResponse,
  parseWriteTextFileRequest,
  sessionResponseMethods,
  type CloseSessionResponse,
  type ContentBlock,
  type DeleteSessionResponse,
  type InitializeResponse,
  type ListSessionsResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionLoadResponse,
  type SessionNewResponse,
  type SessionPromptResponse,
  type SessionResumeResponse,
  type SessionUpdateNotification,
  type SetSessionConfigOptionResponse,
  type SetSessionModeResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "./types.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import { gatewayVersion } from "../provider-capability-discovery.js";
import type { CliType } from "../session-manager.js";

/** Default ACP protocol version advertised by the client to the agent. */
export const DEFAULT_ACP_PROTOCOL_VERSION = 1;

/**
 * Gateway-owned ACP HostServices boundary, as seen by the client.
 *
 * The client dispatches agent-initiated callbacks here. This interface is the
 * dispatch contract only: the concrete implementation (filesystem under the
 * workspace registry, terminal, MCP bridge, ApprovalManager-backed permission
 * decisions, and the deny-by-default policy) is owned by a later slice
 * (`src/acp/host-services.ts`). Keeping the interface here lets the client be
 * tested against mock hosts without importing side-effecting host code.
 *
 * Each method receives the parsed, schema-validated request plus the session
 * context. A method that is not provided is treated as "unsupported by this
 * host" and the client answers the agent with a JSON-RPC error.
 */
export interface HostServices {
  /**
   * Resolve an `fs/read_text_file` request. Implementations MUST enforce the
   * workspace boundary and the read-only/default-deny policy
   * (`workspace_required_for_filesystem_host_services`).
   */
  readTextFile?(
    request: ReadTextFileRequest,
    context: HostCallbackContext
  ): Promise<ReadTextFileResponse>;
  /**
   * Resolve an `fs/write_text_file` request. Disabled by default
   * (`write_host_services_disabled_by_default`); implementations throw when
   * writes are not permitted.
   */
  writeTextFile?(
    request: WriteTextFileRequest,
    context: HostCallbackContext
  ): Promise<WriteTextFileResponse>;
  /**
   * Decide a `session/request_permission` callback. MUST route through
   * ApprovalManager before allowing any side effect
   * (`approval_manager_required_for_provider_permissions`).
   */
  requestPermission?(
    request: RequestPermissionRequest,
    context: HostCallbackContext
  ): Promise<RequestPermissionResponse>;
}

/** Context passed to every {@link HostServices} callback. */
export interface HostCallbackContext {
  /** Provider this agent belongs to. */
  readonly provider: CliType;
  /** ACP method name of the inbound request. */
  readonly method: string;
}

/** Callbacks for streamed `session/update` notifications and lifecycle events. */
export interface AcpClientCallbacks {
  /**
   * Invoked for every parsed `session/update` notification. Parse failures do
   * not reach here: a malformed notification is logged and dropped so a single
   * bad frame cannot crash the turn.
   */
  readonly onSessionUpdate?: (update: SessionUpdateNotification) => void;
  /**
   * Invoked when the underlying transport reports the provider process exited
   * or the protocol channel closed. Useful for async-job bookkeeping.
   */
  readonly onProcessExit?: (error: AcpError) => void;
}

/** Construction options for {@link AcpClient}. */
export interface AcpClientOptions {
  /** The already-opened JSON-RPC transport over provider stdio. */
  readonly transport: JsonRpcStdioTransport;
  /** Provider this client speaks to, for attribution and error context. */
  readonly provider: CliType;
  /** Gateway-owned host services for agent callbacks. */
  readonly hostServices: HostServices;
  /** Streaming + lifecycle callbacks. */
  readonly callbacks?: AcpClientCallbacks;
  /** Gateway logger (stderr sink). Defaults to a no-op. */
  readonly logger?: Logger;
  /** Protocol version advertised in `initialize`. */
  readonly protocolVersion?: number;
  /** Per-method timeouts (ms). 0 / undefined uses the transport default. */
  readonly timeouts?: AcpClientTimeouts;
  /**
   * Whether state-mutating ACP admin ops (`session/delete`, `session/set_mode`,
   * `session/set_config_option`) may be invoked. Deny-by-default: when false (the
   * default), these ops fail closed with a {@link AcpMutatingDisabledError} even
   * if the agent advertises them. Sourced from the operator's [acp] config.
   */
  readonly allowMutatingSessionOps?: boolean;
}

/** Per-method ACP timeouts in milliseconds. */
export interface AcpClientTimeouts {
  readonly initializeMs?: number;
  readonly sessionNewMs?: number;
  readonly sessionLoadMs?: number;
  readonly promptMs?: number;
}

/** Client capabilities advertised at `initialize`, derived from host support. */
export interface InitializeOptions {
  /** Advertise filesystem read capability to the agent. */
  readonly readTextFile?: boolean;
  /** Advertise filesystem write capability to the agent. */
  readonly writeTextFile?: boolean;
  /** Advertise terminal capability to the agent. */
  readonly terminal?: boolean;
}

/** Parameters for creating a new ACP session. */
export interface NewSessionParams {
  /** Working directory the agent should resolve relative paths against. */
  readonly cwd: string;
  /** MCP servers exposed to the agent. Empty by default. */
  readonly mcpServers?: ReadonlyArray<Record<string, unknown>>;
}

/** Parameters for resuming an existing ACP session. */
export interface LoadSessionParams extends NewSessionParams {
  /** Provider-owned ACP session id to resume. */
  readonly sessionId: string;
}

/** Parameters for sending a prompt turn. */
export interface PromptParams {
  /** Provider-owned ACP session id the prompt belongs to. */
  readonly sessionId: string;
  /** Prompt content blocks. At least one block is required by the schema. */
  readonly prompt: ReadonlyArray<ContentBlock>;
}

/** Parameters for resuming an existing ACP session (`session/resume`). */
export interface ResumeSessionParams extends NewSessionParams {
  /** Provider-owned ACP session id to resume. */
  readonly sessionId: string;
}

/** Parameters for setting a session mode (`session/set_mode`). */
export interface SetSessionModeParams {
  readonly sessionId: string;
  /** The mode id to switch to (from the session's advertised mode state). */
  readonly modeId: string;
}

/** Parameters for setting a session config option (`session/set_config_option`). */
export interface SetSessionConfigOptionParams {
  readonly sessionId: string;
  /** The config option id (from the session's advertised config options). */
  readonly configId: string;
  /**
   * The new value for the config option: the id of the value to select. Per the
   * ACP spec this is a non-empty `SessionConfigValueId` string, not an arbitrary
   * payload.
   */
  readonly value: string;
}

/**
 * High-level ACP client over a single provider process transport.
 *
 * One client wraps one transport (one provider process). The client is
 * stateless beyond a single "initialized" latch; session state lives in the
 * gateway session map (a later slice), not here.
 */
export class AcpClient {
  private readonly transport: JsonRpcStdioTransport;
  private readonly provider: CliType;
  private readonly hostServices: HostServices;
  private readonly callbacks?: AcpClientCallbacks;
  private readonly logger: Logger;
  private readonly protocolVersion: number;
  private readonly timeouts: AcpClientTimeouts;
  private readonly allowMutatingSessionOps: boolean;

  private initialized = false;
  private initializeResult: InitializeResponse | null = null;
  /**
   * Methods the agent advertised as available, derived from the parsed
   * `initialize` capability set and augmented as sessions are created/loaded
   * (per-session `modes`/`configOptions` add set_mode/set_config_option). This
   * is the single runtime source for method availability; there is no
   * hand-coded per-provider method table.
   */
  private methodAvailability = new Set<string>();

  /** Mutating ACP admin methods gated behind the operator config flag. */
  private static readonly MUTATING_METHODS: ReadonlySet<string> = new Set([
    "session/delete",
    "session/set_mode",
    "session/set_config_option",
  ]);

  constructor(options: AcpClientOptions) {
    this.transport = options.transport;
    this.provider = options.provider;
    this.hostServices = options.hostServices;
    this.callbacks = options.callbacks;
    this.logger = options.logger ?? noopLogger;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_ACP_PROTOCOL_VERSION;
    this.timeouts = options.timeouts ?? {};
    this.allowMutatingSessionOps = options.allowMutatingSessionOps ?? false;
  }

  /** Whether {@link initialize} has completed successfully. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** The parsed `initialize` result once available, else `null`. */
  get agentInfo(): InitializeResponse | null {
    return this.initializeResult;
  }

  /**
   * The ACP methods the agent advertised as available at runtime (derived from
   * the parsed capability set, augmented per-session). Read-only snapshot.
   */
  get availableMethods(): ReadonlySet<string> {
    return new Set(this.methodAvailability);
  }

  /** Whether the agent advertised support for a given ACP method. */
  supportsMethod(method: string): boolean {
    return this.methodAvailability.has(method);
  }

  /**
   * Perform the ACP `initialize` handshake. Idempotent: a second call returns
   * the cached result without re-issuing the request.
   *
   * Advertised client capabilities default to all-false (the read-only smoke
   * posture); callers opt in to read/write/terminal explicitly.
   */
  async initialize(options: InitializeOptions = {}): Promise<InitializeResponse> {
    if (this.initialized && this.initializeResult) {
      return this.initializeResult;
    }

    const params = {
      protocolVersion: this.protocolVersion,
      // Mistral Vibe forwards this identity as request metadata and rejects
      // empty values. Supplying the gateway identity also makes the ACP
      // handshake conformant for agents that require client metadata.
      clientInfo: {
        name: "llm-cli-gateway",
        version: gatewayVersion(),
      },
      clientCapabilities: {
        fs: {
          readTextFile: options.readTextFile ?? false,
          writeTextFile: options.writeTextFile ?? false,
        },
        terminal: options.terminal ?? false,
      },
    };

    const raw = await this.send("initialize", params, this.timeouts.initializeMs);
    const result = parseInitializeResponse(raw, this.provider);
    this.initialized = true;
    this.initializeResult = result;
    // Derive method availability from the parsed capability set (never a
    // hand-coded per-provider table). Per-session methods are added later, when a
    // session/new or session/load response advertises modes/configOptions.
    this.methodAvailability = new Set(deriveAcpMethodAvailability(result));
    return result;
  }

  /**
   * Create a new ACP session. The returned `sessionId` is provider-owned and
   * MUST NOT be reused as a gateway session id (the session map owns that).
   */
  async newSession(params: NewSessionParams): Promise<SessionNewResponse> {
    this.assertInitialized("session/new");
    const raw = await this.send(
      "session/new",
      { cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
      this.timeouts.sessionNewMs
    );
    const response = parseSessionNewResponse(raw, this.provider);
    this.augmentSessionMethods(response);
    return response;
  }

  /** Resume an existing provider ACP session by id. */
  async loadSession(params: LoadSessionParams): Promise<SessionLoadResponse> {
    this.assertInitialized("session/load");
    const raw = await this.send(
      "session/load",
      {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      },
      this.timeouts.sessionLoadMs
    );
    const response = parseSessionLoadResponse(raw, this.provider);
    this.augmentSessionMethods(response);
    return response;
  }

  /**
   * Send a prompt turn and resolve with the terminal `session/prompt` response
   * (its `stopReason`). Streamed `session/update` notifications arrive through
   * {@link AcpClientCallbacks.onSessionUpdate} while the turn runs.
   */
  async prompt(params: PromptParams): Promise<SessionPromptResponse> {
    this.assertInitialized("session/prompt");
    const raw = await this.send(
      "session/prompt",
      { sessionId: params.sessionId, prompt: params.prompt },
      this.timeouts.promptMs
    );
    return parseSessionPromptResponse(raw, this.provider);
  }

  /**
   * Cancel an in-flight turn for a session. `session/cancel` is a notification:
   * it has no response, so this resolves immediately after the frame is queued.
   * The pending `prompt` promise typically settles afterwards with a cancelled
   * stop reason or a process error.
   */
  cancel(sessionId: string): void {
    this.transport.notify("session/cancel", { sessionId });
  }

  // -------------------------------------------------------------------------
  // Capability-gated session lifecycle methods (Phase-5 Deliverable C)
  //
  // Each method is GATED on the advertised capability set derived from
  // initialize (+ per-session augmentation). Calling a method the agent did not
  // advertise throws a precise {@link AcpMethodUnsupportedError}, never a generic
  // process/protocol failure. State-mutating admin ops (delete/set_mode/
  // set_config_option) are additionally gated behind the operator config flag and
  // throw {@link AcpMutatingDisabledError} when it is off (deny-by-default).
  // -------------------------------------------------------------------------

  /**
   * Resume an existing provider ACP session (`session/resume`), when advertised.
   * Distinct from {@link loadSession}: `resume` is gated on the `resume` session
   * capability; `load` on the top-level `loadSession` capability.
   */
  async resumeSession(params: ResumeSessionParams): Promise<SessionResumeResponse> {
    this.assertMethodAvailable("session/resume");
    const raw = await this.send(
      "session/resume",
      { sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
      this.timeouts.sessionLoadMs
    );
    const response = parseSessionResumeResponse(raw, this.provider);
    this.augmentSessionMethods(response);
    return response;
  }

  /** List provider ACP sessions (`session/list`), when advertised. */
  async listSessions(params: { cursor?: string } = {}): Promise<ListSessionsResponse> {
    this.assertMethodAvailable("session/list");
    const raw = await this.send("session/list", { cursor: params.cursor });
    return parseListSessionsResponse(raw, this.provider);
  }

  /** Close a provider ACP session (`session/close`), when advertised. */
  async closeSession(sessionId: string): Promise<CloseSessionResponse> {
    this.assertMethodAvailable("session/close");
    const raw = await this.send("session/close", { sessionId });
    return parseCloseSessionResponse(raw, this.provider);
  }

  /**
   * Delete a provider ACP session (`session/delete`), when advertised AND the
   * operator enabled mutating session ops. State-mutating admin op: fails closed.
   */
  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    this.assertMethodAvailable("session/delete");
    const raw = await this.send("session/delete", { sessionId });
    return parseDeleteSessionResponse(raw, this.provider);
  }

  /**
   * Set a session mode (`session/set_mode`), when advertised AND the operator
   * enabled mutating session ops. State-mutating admin op: fails closed.
   */
  async setSessionMode(params: SetSessionModeParams): Promise<SetSessionModeResponse> {
    this.assertMethodAvailable("session/set_mode");
    const raw = await this.send("session/set_mode", {
      sessionId: params.sessionId,
      modeId: params.modeId,
    });
    return parseSetSessionModeResponse(raw, this.provider);
  }

  /**
   * Set a session config option (`session/set_config_option`), when advertised
   * AND the operator enabled mutating session ops. State-mutating admin op:
   * fails closed.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionParams
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertMethodAvailable("session/set_config_option");
    const raw = await this.send("session/set_config_option", {
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    return parseSetSessionConfigOptionResponse(raw, this.provider);
  }

  /**
   * Fold per-session advertised methods (set_mode when `modes` is present,
   * set_config_option when `configOptions` is present) into the availability set.
   */
  private augmentSessionMethods(response: {
    readonly modes?: unknown;
    readonly configOptions?: unknown;
  }): void {
    for (const method of sessionResponseMethods(response)) {
      this.methodAvailability.add(method);
    }
  }

  /**
   * Enforce capability + mutating-op gates before issuing a gated method.
   * Order: initialize must be complete; the method must be advertised (else a
   * precise capability error); mutating admin ops additionally require the
   * config gate. All checks are pure reads (no side effect, no spawn) so a
   * refused call never touches the provider.
   */
  private assertMethodAvailable(method: string): void {
    this.assertInitialized(method);
    if (!this.methodAvailability.has(method)) {
      throw new AcpMethodUnsupportedError(this.provider, method, {
        reason: "capability_not_advertised",
      });
    }
    if (AcpClient.MUTATING_METHODS.has(method) && !this.allowMutatingSessionOps) {
      throw new AcpMutatingDisabledError(this.provider, method, { reason: "config_gate_off" });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: request marshalling + error normalisation
  // -------------------------------------------------------------------------

  /**
   * Issue a request through the transport and normalise any thrown value into a
   * typed {@link AcpError}. Transport-thrown errors are already typed and
   * redacted; non-ACP throwables (should not occur in practice) are wrapped in
   * a redacted {@link AcpProtocolError}.
   */
  private async send(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      return await this.transport.request(method, params, timeoutMs);
    } catch (err) {
      throw this.normalizeError(method, err);
    }
  }

  /** Map an arbitrary thrown value to a typed, redacted ACP error. */
  private normalizeError(method: string, err: unknown): AcpError {
    if (isAcpError(err)) {
      return err;
    }
    // Defensive: the transport only ever rejects with AcpError subclasses, but
    // a wrapper guarantees the client never leaks a raw error to callers. The
    // message is redacted at AcpProtocolError construction; we never embed the
    // raw error value, only its class name.
    return new AcpProtocolError(`ACP request ${method} failed unexpectedly.`, {
      provider: this.provider,
      debug: { method, errorClass: err instanceof Error ? err.name : "unknown" },
    });
  }

  /** Throw if the client has not completed `initialize`. */
  private assertInitialized(method: string): void {
    if (!this.initialized) {
      throw new AcpProtocolError(`ACP ${method} requires initialize to complete first.`, {
        provider: this.provider,
        debug: { method, reason: "not_initialized" },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Transport handler wiring
  //
  // The transport's `onNotification` / `onRequest` options are supplied at
  // construction by the process manager, which routes them into the methods
  // below. These are the canonical handlers for agent-initiated traffic.
  // -------------------------------------------------------------------------

  /**
   * Handle an agent-initiated `session/update` notification. The process
   * manager wires the transport's `onNotification` to call this. Parse failures
   * are logged (method + error class only) and dropped.
   */
  handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
    // Unknown notifications are forward-compatible: log the method only.
    this.logger.debug("acp.client.unknown_notification", {
      provider: this.provider,
      method,
    });
  }

  private handleSessionUpdate(params: unknown): void {
    let parsed: SessionUpdateNotification;
    try {
      parsed = parseSessionUpdateNotification(params, this.provider);
    } catch (err) {
      this.logger.error("acp.client.session_update.parse_error", {
        provider: this.provider,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
      return;
    }
    try {
      this.callbacks?.onSessionUpdate?.(parsed);
    } catch (err) {
      this.logger.error("acp.client.session_update.handler_error", {
        provider: this.provider,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  /**
   * Handle an agent-initiated request (host callback). The process manager
   * wires the transport's `onRequest` to call this. The client parses the
   * request, dispatches into {@link HostServices}, and answers the agent with
   * either a result or a JSON-RPC error. It never throws to the transport.
   */
  handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    void this.dispatchRequest(id, method, params);
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const context: HostCallbackContext = { provider: this.provider, method };
    try {
      switch (method) {
        case "fs/read_text_file": {
          const request = parseReadTextFileRequest(params, this.provider);
          const result = await this.requireHandler(this.hostServices.readTextFile, method)(
            request,
            context
          );
          this.transport.respond(id, result);
          return;
        }
        case "fs/write_text_file": {
          const request = parseWriteTextFileRequest(params, this.provider);
          const result = await this.requireHandler(this.hostServices.writeTextFile, method)(
            request,
            context
          );
          this.transport.respond(id, result);
          return;
        }
        case "session/request_permission": {
          const request = parseRequestPermissionRequest(params, this.provider);
          const result = await this.requireHandler(this.hostServices.requestPermission, method)(
            request,
            context
          );
          this.transport.respond(id, result);
          return;
        }
        default: {
          // Unknown host method: answer with a JSON-RPC method-not-found.
          this.logger.debug("acp.client.unknown_host_request", {
            provider: this.provider,
            method,
          });
          this.transport.respondError(id, {
            code: -32601,
            message: "Method not found",
          });
          return;
        }
      }
    } catch (err) {
      // Any host-side failure (including ApprovalManager denials surfaced as
      // thrown AcpErrors) becomes a JSON-RPC error to the agent. The message is
      // redacted: we never forward raw error text to the agent.
      const acpError = isAcpError(err) ? err : this.normalizeError(method, err);
      this.logger.error("acp.client.host_request.failed", {
        provider: this.provider,
        method,
        errorClass: acpError.name,
        kind: acpError.kind,
      });
      this.transport.respondError(id, {
        code: -32000,
        message: acpError.userMessage,
      });
    }
  }

  /**
   * Bind a host handler that must exist. When a host does not implement a
   * surface (deny-by-default posture: write/terminal disabled), the missing
   * method throws a redacted protocol error mapped to method-not-found.
   */
  private requireHandler<A extends unknown[], R>(
    handler: ((...args: A) => Promise<R>) | undefined,
    method: string
  ): (...args: A) => Promise<R> {
    if (!handler) {
      throw new AcpProtocolError(`Host does not support ACP ${method}.`, {
        provider: this.provider,
        debug: { method, reason: "unsupported_host_method" },
      });
    }
    return handler.bind(this.hostServices);
  }

  /**
   * Notify lifecycle observers that the provider process exited. The process
   * manager calls this after it observes the transport's terminal state.
   */
  notifyProcessExit(error: AcpError): void {
    try {
      this.callbacks?.onProcessExit?.(error);
    } catch (err) {
      this.logger.error("acp.client.process_exit.handler_error", {
        provider: this.provider,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
