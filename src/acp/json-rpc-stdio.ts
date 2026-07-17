/**
 * Newline-delimited JSON-RPC transport over an already-opened provider stdio
 * pair.
 *
 * This module is the internal ACP transport described by the architecture
 * (`internal_acp_transport = "JSON-RPC over provider stdio"`). It owns the
 * line framing, request/response correlation, notification dispatch, JSON-RPC
 * error surfacing, per-request timeouts, and propagation of a process exit to
 * every pending request.
 *
 * Binding constraints honoured here:
 *
 *  - It does NOT spawn processes. Spawn-safe wiring (argv arrays, env, cwd) is
 *    owned by the process manager; this transport receives the already-opened
 *    `stdin`/`stdout`/`stderr` streams. This keeps `no_shell_eval_for_entrypoints`
 *    and `no_arbitrary_subcommand_execution` entirely in the process manager.
 *  - It NEVER writes to the gateway's own stdout. Provider stdout is consumed
 *    only as ACP protocol frames (`provider_stdout_is_protocol_only`); provider
 *    stderr is forwarded exclusively through the injected gateway logger to
 *    stderr (`provider_stderr_logged_through_gateway_logger`,
 *    `stdout_reserved_for_mcp`), and each stderr line is run through the ACP
 *    redactor before logging so prompt fragments, file contents, credential
 *    paths, or tokens an agent echoes onto its own stderr never reach a log sink
 *    (`no_prompt_payloads_in_default_logs`).
 *  - It does not persist raw JSON-RPC bodies. Logging is restricted to method
 *    names, ids, and error classes, so no prompt text or full payload reaches a
 *    log sink from this layer (`no_prompt_payloads_in_default_logs`).
 */

import type { Readable, Writable } from "node:stream";

import {
  AcpProcessExitError,
  AcpProtocolError,
  AcpTimeoutError,
  redactAcpMessage,
} from "./errors.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { CliType } from "../session-manager.js";

/** JSON-RPC request id: either a number or a string per the spec. */
export type JsonRpcId = number | string;

/** A JSON-RPC error object as returned by the agent. */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A JSON-RPC notification (no id) dispatched by the transport. */
export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

/**
 * A JSON-RPC request originating from the agent (has both `method` and `id`).
 * The host must answer these via {@link JsonRpcStdioTransport.respond}.
 */
export interface JsonRpcInboundRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

/** Streams supplied by the process manager. The transport never opens these. */
export interface ProviderStdioStreams {
  /** Provider stdin: the transport writes outbound JSON-RPC frames here. */
  readonly stdin: Writable;
  /** Provider stdout: ACP protocol frames only. Never forwarded to gateway stdout. */
  readonly stdout: Readable;
  /** Provider stderr: forwarded through the gateway logger. Optional. */
  readonly stderr?: Readable | null;
}

/** Exact provider channel and stable reason that made the transport unusable. */
export type AcpTransportTerminal =
  | {
      readonly channel: "stdin";
      readonly reason: "stdin_write_failed";
      readonly error: AcpProcessExitError;
    }
  | {
      readonly channel: "stdout";
      readonly reason: "stdout_channel_closed";
      readonly error: AcpProcessExitError;
    };

/** Options controlling transport behaviour. */
export interface JsonRpcStdioTransportOptions {
  /** Streams from the process manager. */
  readonly streams: ProviderStdioStreams;
  /** Gateway logger (stderr sink). Defaults to a no-op logger. */
  readonly logger?: Logger;
  /** Provider this transport speaks to, for error/log attribution. */
  readonly provider?: CliType;
  /** Default per-request timeout in ms. Overridable per call. 0 disables. */
  readonly defaultTimeoutMs?: number;
  /**
   * Handler for agent-initiated notifications (no id). Errors thrown here are
   * caught and logged; they never crash the transport.
   */
  readonly onNotification?: (notification: JsonRpcNotification) => void;
  /**
   * Handler for agent-initiated requests (method + id). The handler must
   * eventually call {@link JsonRpcStdioTransport.respond}. Errors thrown here
   * are caught and logged.
   */
  readonly onRequest?: (request: JsonRpcInboundRequest) => void;
  /**
   * Fired on ANY protocol activity: an outbound request issued, or an inbound
   * notification, request, or response observed. The process manager uses this
   * to reset its idle timer so a process is not killed immediately after a
   * client request/response exchange (only after genuine quiescence). Errors
   * thrown here are swallowed — activity signalling must never affect framing.
   */
  readonly onActivity?: () => void;
  /**
   * Fired exactly once with the typed terminal channel/reason when provider
   * stdin fails, or stdout ends/errors, without a preceding process-exit
   * signal. The process manager quarantines the unusable process and preserves
   * the supplied typed error for lifecycle observers. Not fired when the
   * manager initiates teardown via {@link JsonRpcStdioTransport.handleProcessExit}
   * or {@link JsonRpcStdioTransport.dispose}.
   */
  readonly onTerminal?: (terminal: AcpTransportTerminal) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Minimal shape of any inbound JSON-RPC message after JSON.parse. */
interface ParsedMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "number" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Newline-delimited JSON-RPC transport over provider stdio.
 *
 * Lifecycle: construct with already-opened streams, call methods to issue
 * requests/notifications, and call {@link dispose} (or let the provider process
 * exit) to fail pending requests. The transport is single-process; one instance
 * wraps one provider process.
 */
export class JsonRpcStdioTransport {
  private readonly streams: ProviderStdioStreams;
  private readonly logger: Logger;
  private readonly provider?: CliType;
  private readonly defaultTimeoutMs: number;
  private readonly onNotification?: (notification: JsonRpcNotification) => void;
  private readonly onRequest?: (request: JsonRpcInboundRequest) => void;
  private readonly onActivity?: () => void;
  private readonly onTerminal?: (terminal: AcpTransportTerminal) => void;

  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  /** Terminal error once the process has exited; rejects all later writes. */
  private exitError: Error | null = null;

  constructor(options: JsonRpcStdioTransportOptions) {
    this.streams = options.streams;
    this.logger = options.logger ?? noopLogger;
    this.provider = options.provider;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onActivity = options.onActivity;
    this.onTerminal = options.onTerminal;

    this.attach();
  }

  /** Wire stream listeners. Called once at construction. */
  private attach(): void {
    const { stdin, stdout, stderr } = this.streams;

    // Child stdin failures are asynchronous even when write() itself returns
    // normally. Own the Writable error channel for the transport lifetime so a
    // provider exit can never become a process-level uncaught EPIPE.
    stdin.on("error", (err: Error) => this.handleStdinError(err));

    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onStdoutData(chunk));
    stdout.on("error", (err: Error) => {
      this.logger.error("acp.transport.stdout.error", {
        provider: this.provider,
        errorClass: err.name,
      });
      // A stdout error breaks the only protocol channel. Node does not guarantee
      // a `close`/`end` follows every `error`, so terminate here too: reject
      // pending requests and mark the transport closed (idempotent — a later
      // `close` is a no-op once `handleStreamClose` has run).
      this.handleStreamClose();
    });
    // A stdout close without a separate process-exit signal still terminates
    // pending requests: there is no further protocol channel.
    stdout.on("close", () => this.handleStreamClose());
    stdout.on("end", () => this.handleStreamClose());

    if (stderr) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => this.onStderrData(chunk));
      stderr.on("error", (err: Error) => {
        this.logger.error("acp.transport.stderr.error", {
          provider: this.provider,
          errorClass: err.name,
        });
      });
    }
  }

  /** A broken outbound protocol channel terminalizes every pending request. */
  private handleStdinError(error: Error): void {
    this.logger.error("acp.transport.stdin.error", {
      provider: this.provider,
      errorClass: error.name,
      errorCode: (error as NodeJS.ErrnoException).code,
    });
    if (this.exitError || this.closed) return;
    const terminalError = new AcpProcessExitError(this.provider ?? ("unknown" as CliType), {
      debug: {
        reason: "stdin_write_failed",
        errorClass: error.name,
        errorCode: (error as NodeJS.ErrnoException).code,
      },
    });
    this.exitError = terminalError;
    this.failPending(terminalError);
    this.closed = true;
    this.emitTerminal({
      channel: "stdin",
      reason: "stdin_write_failed",
      error: terminalError,
    });
  }

  /** Write one outbound frame and route deferred Writable failures terminally. */
  private writeFrame(frame: string): void {
    try {
      this.streams.stdin.write(frame, error => {
        if (error) this.handleStdinError(error);
      });
    } catch (error) {
      this.handleStdinError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Accumulate provider stdout and split on newline boundaries. */
  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  /**
   * Summarize provider stderr through the gateway logger, line by line.
   *
   * Provider stderr is untrusted free-form text: an agent can (and some do)
   * echo prompt fragments, file contents, credential paths, or tokens onto its
   * own stderr. Even debug logs must not preserve arbitrary diagnostic prose,
   * because pattern redaction cannot prove all prompt/file text is scrubbed.
   * Keep only a byte count and whether the known redactor would have changed
   * the line.
   */
  private onStderrData(chunk: string): void {
    this.stderrBuffer += chunk;

    let newlineIndex = this.stderrBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const redacted = redactAcpMessage(line) !== line;
        this.logger.debug("acp.provider.stderr", {
          provider: this.provider,
          bytes: Buffer.byteLength(line, "utf8"),
          redacted,
        });
      }
      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  /** Parse and route a single newline-delimited frame. */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: ParsedMessage;
    try {
      parsed = JSON.parse(trimmed) as ParsedMessage;
    } catch {
      // Invalid JSON must not crash the transport. Log the error class only;
      // never log the raw line (it may carry prompt or payload text).
      this.logger.error("acp.transport.invalid_json", {
        provider: this.provider,
        errorClass: "SyntaxError",
        bytes: trimmed.length,
      });
      return;
    }

    if (parsed === null || typeof parsed !== "object") {
      this.logger.error("acp.transport.invalid_message", { provider: this.provider });
      return;
    }

    const hasId = isJsonRpcId(parsed.id);
    const hasMethod = typeof parsed.method === "string";

    // Any well-formed inbound frame is protocol activity (resets idle timer).
    if (hasMethod || hasId) {
      this.emitActivity();
    }

    if (hasMethod && hasId) {
      // Agent-initiated request (host callback / permission request).
      this.dispatchInboundRequest(
        parsed as Required<Pick<ParsedMessage, "id" | "method">> & ParsedMessage
      );
      return;
    }

    if (hasMethod && !hasId) {
      // Notification.
      this.dispatchNotification(parsed.method as string, parsed.params);
      return;
    }

    if (hasId) {
      // Response (success or error) to one of our requests.
      this.resolveResponse(parsed.id as JsonRpcId, parsed);
      return;
    }

    this.logger.error("acp.transport.unroutable_message", { provider: this.provider });
  }

  private dispatchNotification(method: string, params: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try {
      this.onNotification?.(notification);
    } catch (err) {
      this.logger.error("acp.transport.notification_handler_error", {
        provider: this.provider,
        method,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  private dispatchInboundRequest(parsed: ParsedMessage): void {
    const request: JsonRpcInboundRequest = {
      jsonrpc: "2.0",
      id: parsed.id as JsonRpcId,
      method: parsed.method as string,
      params: parsed.params,
    };
    try {
      this.onRequest?.(request);
    } catch (err) {
      this.logger.error("acp.transport.request_handler_error", {
        provider: this.provider,
        method: request.method,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  private resolveResponse(id: JsonRpcId, parsed: ParsedMessage): void {
    const pending = this.pending.get(id);
    if (!pending) {
      // Late or duplicate response after timeout/exit. Drop quietly.
      this.logger.debug("acp.transport.orphan_response", { provider: this.provider });
      return;
    }
    this.pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if (parsed.error !== undefined && parsed.error !== null) {
      if (isJsonRpcErrorObject(parsed.error)) {
        // The agent-supplied `error.message` is untrusted free-form text that can
        // echo prompt fragments or file contents. Keep it OUT of the client-facing
        // message (which the pattern redactor cannot scrub of arbitrary prose) and
        // route it only into the redacted debug bag. The user message carries the
        // method + code, which are non-sensitive.
        pending.reject(
          new AcpProtocolError(
            `ACP request ${pending.method} failed with JSON-RPC error ${parsed.error.code}.`,
            {
              provider: this.provider,
              code: parsed.error.code,
              debug: {
                method: pending.method,
                code: parsed.error.code,
                providerMessage: parsed.error.message,
              },
            }
          )
        );
        return;
      }
      pending.reject(
        new AcpProtocolError(`ACP request ${pending.method} returned a malformed error object.`, {
          provider: this.provider,
          debug: { method: pending.method },
        })
      );
      return;
    }

    pending.resolve(parsed.result);
  }

  /**
   * Issue a JSON-RPC request and resolve with the agent's `result`.
   *
   * Rejects with {@link AcpTimeoutError} on timeout, {@link AcpProtocolError}
   * on a JSON-RPC error response, and {@link AcpProcessExitError} if the
   * process exits before the response arrives.
   */
  public request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }
    if (this.closed) {
      return Promise.reject(
        new AcpProcessExitError(this.provider ?? ("unknown" as CliType), {
          debug: { method, reason: "transport_closed" },
        })
      );
    }

    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    // Issuing an outbound request is protocol activity (resets idle timer).
    this.emitActivity();

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject, timer: null };

      if (effectiveTimeout > 0) {
        pending.timer = setTimeout(() => {
          // Only act if still pending; resolveResponse may have raced in.
          if (this.pending.get(id) === pending) {
            this.pending.delete(id);
            this.logger.error("acp.transport.timeout", {
              provider: this.provider,
              method,
              timeoutMs: effectiveTimeout,
            });
            reject(
              new AcpTimeoutError(method, effectiveTimeout, {
                provider: this.provider,
                debug: { method },
              })
            );
          }
        }, effectiveTimeout);
        // Do not keep the event loop alive solely for a pending ACP request.
        pending.timer.unref?.();
      }

      this.pending.set(id, pending);

      const frame =
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }) + "\n";
      this.writeFrame(frame);
      if (this.exitError || this.closed) {
        // A synchronous write failure may already have failed and removed this
        // request. Guard unusual Writable implementations that throw without
        // allowing the shared terminal path to observe the pending entry.
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        reject(this.exitError ?? new AcpProcessExitError(this.provider ?? ("unknown" as CliType)));
      }
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.exitError || this.closed) {
      return;
    }
    const frame =
      JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) +
      "\n";
    this.writeFrame(frame);
  }

  /** Respond to an agent-initiated request with a result. */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.exitError || this.closed) {
      return;
    }
    const frame = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.writeFrame(frame);
  }

  /** Respond to an agent-initiated request with a JSON-RPC error. */
  respondError(id: JsonRpcId, error: JsonRpcErrorObject): void {
    if (this.exitError || this.closed) {
      return;
    }
    const frame =
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: error.code,
          message: error.message,
          ...(error.data !== undefined ? { data: error.data } : {}),
        },
      }) + "\n";
    this.writeFrame(frame);
  }

  /**
   * Propagate a provider process exit to every pending request.
   *
   * The process manager calls this when the provider process emits `exit`.
   * After this, all new requests reject immediately. Idempotent.
   */
  handleProcessExit(exitCode: number | null, signal: string | null): void {
    if (this.exitError) {
      return;
    }
    this.exitError = new AcpProcessExitError(this.provider ?? ("unknown" as CliType), {
      exitCode,
      signal,
      debug: { exitCode, signal },
    });
    this.logger.error("acp.process.exit", {
      provider: this.provider,
      exitCode,
      signal,
      pending: this.pending.size,
    });
    this.failPending(this.exitError);
    this.closed = true;
  }

  /** A stdout `close`/`end`/`error` with no explicit exit still terminates the channel. */
  private handleStreamClose(): void {
    if (this.exitError || this.closed) {
      return;
    }
    const terminalError = new AcpProcessExitError(this.provider ?? ("unknown" as CliType), {
      debug: { reason: "stdout_channel_closed" },
    });
    this.exitError = terminalError;
    this.logger.error("acp.transport.stdout_closed", {
      provider: this.provider,
      pending: this.pending.size,
    });
    this.failPending(terminalError);
    this.closed = true;
    // Tell the manager the protocol channel is gone even though the child may
    // not have emitted `exit` yet, so it stops reporting the process healthy.
    this.emitTerminal({
      channel: "stdout",
      reason: "stdout_channel_closed",
      error: terminalError,
    });
  }

  /** Notify the manager of protocol activity; never let a hook break framing. */
  private emitActivity(): void {
    try {
      this.onActivity?.();
    } catch {
      // Activity signalling is best-effort; swallow to protect the read loop.
    }
  }

  /** Notify the manager that one provider protocol channel became terminal. */
  private emitTerminal(terminal: AcpTransportTerminal): void {
    try {
      this.onTerminal?.(terminal);
    } catch {
      // Terminal-notification hook is best-effort; swallow.
    }
  }

  /** Reject and clear all pending requests with the given terminal error. */
  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  /**
   * Tear down the transport without a provider exit signal (e.g. the process
   * manager is quarantining the process). Fails any pending requests.
   */
  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error =
      this.exitError ??
      new AcpProcessExitError(this.provider ?? ("unknown" as CliType), {
        debug: { reason: "disposed" },
      });
    this.failPending(error);
  }

  /** Number of in-flight requests awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Whether the transport has terminated. */
  get isClosed(): boolean {
    return this.closed;
  }
}
