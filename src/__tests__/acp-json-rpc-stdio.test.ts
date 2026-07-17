import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpProcessExitError, AcpProtocolError, AcpTimeoutError } from "../acp/errors.js";
import {
  JsonRpcStdioTransport,
  type AcpTransportTerminal,
  type JsonRpcInboundRequest,
  type JsonRpcNotification,
  type ProviderStdioStreams,
} from "../acp/json-rpc-stdio.js";
import type { Logger } from "../logger.js";

// Step: build-json-rpc-stdio-transport.
// Validation: focused unit tests simulate fragmented messages, batched pending
// requests, notifications, JSON-RPC errors, invalid JSON, timeout, and process
// exit. Tests prove no gateway stdout writes occur.
//
// test_matrix.unit.json_rpc_transport:
//  - parses fragmented newline-delimited messages
//  - correlates responses by id
//  - dispatches notifications
//  - surfaces JSON-RPC errors
//  - times out pending requests
//  - rejects writes after process exit

interface Harness {
  transport: JsonRpcStdioTransport;
  /** Provider stdout: tests push agent frames here. */
  stdout: PassThrough;
  /** Provider stderr. */
  stderr: PassThrough;
  /** Provider stdin owned by the transport. */
  stdin: PassThrough;
  /** Everything the transport wrote to provider stdin, as decoded lines. */
  written: string[];
  logger: Logger;
  /** Number of onActivity callbacks the transport fired. */
  activity: () => number;
  /** Typed terminal callbacks fired by the transport. */
  terminals: () => readonly AcpTransportTerminal[];
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

function createHarness(
  options: {
    onNotification?: (n: JsonRpcNotification) => void;
    onRequest?: (r: JsonRpcInboundRequest) => void;
    onActivity?: () => void;
    onTerminal?: (terminal: AcpTransportTerminal) => void;
    defaultTimeoutMs?: number;
  } = {}
): Harness {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const written: string[] = [];
  let stdinBuffer = "";
  stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString("utf8");
    let nl = stdinBuffer.indexOf("\n");
    while (nl !== -1) {
      written.push(stdinBuffer.slice(0, nl));
      stdinBuffer = stdinBuffer.slice(nl + 1);
      nl = stdinBuffer.indexOf("\n");
    }
  });

  const streams: ProviderStdioStreams = { stdin, stdout, stderr };
  const logger = makeLogger();
  let activityCount = 0;
  const terminals: AcpTransportTerminal[] = [];
  const transport = new JsonRpcStdioTransport({
    streams,
    logger,
    provider: "mistral",
    defaultTimeoutMs: options.defaultTimeoutMs ?? 0,
    onNotification: options.onNotification,
    onRequest: options.onRequest,
    onActivity: () => {
      activityCount += 1;
      options.onActivity?.();
    },
    onTerminal: terminal => {
      terminals.push(terminal);
      options.onTerminal?.(terminal);
    },
  });

  return {
    transport,
    stdin,
    stdout,
    stderr,
    written,
    logger,
    activity: () => activityCount,
    terminals: () => terminals,
  };
}

/** Decode the JSON frame the transport wrote for the Nth outbound message. */
function decodeWritten(written: string[], index: number): Record<string, unknown> {
  return JSON.parse(written[index]) as Record<string, unknown>;
}

describe("JsonRpcStdioTransport", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrites: string[];

  beforeEach(() => {
    // Guard the security invariant: the transport must NEVER write to the
    // gateway's own process.stdout. Capture every write for assertion.
    stdoutWrites = [];
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stdoutWrites.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    vi.useRealTimers();
  });

  it("correlates responses by id and resolves the matching request", async () => {
    const h = createHarness();
    const p = h.transport.request("initialize", { protocolVersion: 1 });

    // The outbound frame carries an id.
    const sent = decodeWritten(h.written, 0);
    expect(sent.method).toBe("initialize");
    expect(sent.jsonrpc).toBe("2.0");
    const id = sent.id as number;
    expect(typeof id).toBe("number");

    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { agent: "vibe" } })}\n`);

    await expect(p).resolves.toEqual({ agent: "vibe" });
  });

  it("terminalizes pending requests on an asynchronous child stdin error", async () => {
    const h = createHarness();
    const pending = h.transport.request("session/prompt", { prompt: "x".repeat(70_000) });
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    h.stdin.emit("error", error);

    await expect(pending).rejects.toBeInstanceOf(AcpProcessExitError);
    expect(h.transport.isClosed).toBe(true);
    expect(h.transport.pendingCount).toBe(0);
    expect(h.terminals()).toMatchObject([{ channel: "stdin", reason: "stdin_write_failed" }]);
    expect(h.logger.error).toHaveBeenCalledWith(
      "acp.transport.stdin.error",
      expect.objectContaining({ errorCode: "EPIPE" })
    );
  });

  it("parses fragmented newline-delimited messages split across chunks", async () => {
    const h = createHarness();
    const p = h.transport.request("session/new");
    const id = decodeWritten(h.written, 0).id as number;

    const full = `${JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "acp-123" } })}\n`;
    // Split the frame at three arbitrary boundaries.
    h.stdout.write(full.slice(0, 5));
    h.stdout.write(full.slice(5, 12));
    h.stdout.write(full.slice(12));

    await expect(p).resolves.toEqual({ sessionId: "acp-123" });
  });

  it("handles multiple newline-delimited frames arriving in one chunk", async () => {
    const h = createHarness();
    const p1 = h.transport.request("a");
    const p2 = h.transport.request("b");
    const id1 = decodeWritten(h.written, 0).id as number;
    const id2 = decodeWritten(h.written, 1).id as number;
    expect(id1).not.toBe(id2);

    const batched =
      `${JSON.stringify({ jsonrpc: "2.0", id: id1, result: 1 })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: id2, result: 2 })}\n`;
    h.stdout.write(batched);

    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
  });

  it("resolves batched pending requests out of order", async () => {
    const h = createHarness();
    const p1 = h.transport.request("first");
    const p2 = h.transport.request("second");
    const id1 = decodeWritten(h.written, 0).id as number;
    const id2 = decodeWritten(h.written, 1).id as number;

    // Agent answers the second request first.
    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id2, result: "B" })}\n`);
    await expect(p2).resolves.toBe("B");
    expect(h.transport.pendingCount).toBe(1);

    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id1, result: "A" })}\n`);
    await expect(p1).resolves.toBe("A");
    expect(h.transport.pendingCount).toBe(0);
  });

  it("dispatches notifications to the notification handler", async () => {
    const seen: JsonRpcNotification[] = [];
    const h = createHarness({ onNotification: n => seen.push(n) });

    h.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { kind: "agent_message_chunk" } })}\n`
    );
    // Allow the data event to flush.
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("session/update");
    expect(seen[0].params).toEqual({ kind: "agent_message_chunk" });
  });

  it("routes agent-initiated requests (id + method) to the request handler", async () => {
    const seen: JsonRpcInboundRequest[] = [];
    const h = createHarness({ onRequest: r => seen.push(r) });

    h.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { tool: "write" } })}\n`
    );
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("perm-1");
    expect(seen[0].method).toBe("session/request_permission");

    // Host answers it; the response frame goes to provider stdin, never stdout.
    h.transport.respond("perm-1", { outcome: "denied" });
    const last = decodeWritten(h.written, h.written.length - 1);
    expect(last.id).toBe("perm-1");
    expect(last.result).toEqual({ outcome: "denied" });
  });

  it("surfaces JSON-RPC errors as AcpProtocolError with the code", async () => {
    const h = createHarness();
    const p = h.transport.request("session/prompt");
    const id = decodeWritten(h.written, 0).id as number;

    h.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })}\n`
    );

    await expect(p).rejects.toBeInstanceOf(AcpProtocolError);
    await p.catch((err: AcpProtocolError) => {
      expect(err.code).toBe(-32601);
      // The user-facing message must not embed raw payload bodies.
      expect(err.userMessage).toContain("session/prompt");
    });
  });

  it("keeps the provider's JSON-RPC error message out of the client-facing message", async () => {
    // Round-3 codex finding 2: an agent-supplied `error.message` is untrusted
    // free-form text (it can echo prompt fragments the pattern redactor cannot
    // scrub). It must not be interpolated into the client-facing userMessage.
    const h = createHarness();
    const p = h.transport.request("session/prompt");
    const id = decodeWritten(h.written, 0).id as number;

    const leak = "user asked me to summarize CONFIDENTIAL_TEXT verbatim";
    h.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: leak } })}\n`
    );

    await expect(p).rejects.toBeInstanceOf(AcpProtocolError);
    await p.catch((err: AcpProtocolError) => {
      expect(err.code).toBe(-32000);
      // The method + code are safe; the provider prose is not present.
      expect(err.userMessage).toContain("session/prompt");
      expect(err.userMessage).toContain("-32000");
      expect(err.userMessage).not.toContain("CONFIDENTIAL_TEXT");
      expect(err.userMessage).not.toContain(leak);
    });
  });

  it("ignores invalid JSON without crashing and logs an error class only", async () => {
    const h = createHarness();
    const p = h.transport.request("initialize");
    const id = decodeWritten(h.written, 0).id as number;

    // A garbage line interleaved with a valid response.
    h.stdout.write("this is not json\n");
    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: "ok" })}\n`);

    await expect(p).resolves.toBe("ok");
    expect(h.logger.error).toHaveBeenCalledWith(
      "acp.transport.invalid_json",
      expect.objectContaining({ errorClass: "SyntaxError" })
    );
    // The raw invalid line must NOT be passed to the logger.
    const loggedRawLine = (h.logger.error as ReturnType<typeof vi.fn>).mock.calls.some(call =>
      JSON.stringify(call).includes("this is not json")
    );
    expect(loggedRawLine).toBe(false);
  });

  it("times out a pending request and rejects with AcpTimeoutError", async () => {
    vi.useFakeTimers();
    const h = createHarness({ defaultTimeoutMs: 1000 });
    const p = h.transport.request("session/new");
    const expectation = expect(p).rejects.toBeInstanceOf(AcpTimeoutError);

    vi.advanceTimersByTime(1001);
    await expectation;
    await p.catch((err: AcpTimeoutError) => {
      expect(err.method).toBe("session/new");
      expect(err.timeoutMs).toBe(1000);
    });
    expect(h.transport.pendingCount).toBe(0);
  });

  it("honours a per-request timeout override", async () => {
    vi.useFakeTimers();
    const h = createHarness({ defaultTimeoutMs: 60000 });
    const p = h.transport.request("session/prompt", undefined, 50);
    const expectation = expect(p).rejects.toBeInstanceOf(AcpTimeoutError);
    vi.advanceTimersByTime(51);
    await expectation;
  });

  it("does not time out when a response arrives before the deadline", async () => {
    vi.useFakeTimers();
    const h = createHarness({ defaultTimeoutMs: 1000 });
    const p = h.transport.request("initialize");
    const id = decodeWritten(h.written, 0).id as number;

    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: "done" })}\n`);
    await expect(p).resolves.toBe("done");

    // Advancing past the deadline must not produce an unhandled rejection.
    vi.advanceTimersByTime(2000);
    expect(h.transport.pendingCount).toBe(0);
  });

  it("propagates process exit to all pending requests", async () => {
    const h = createHarness();
    const p1 = h.transport.request("a");
    const p2 = h.transport.request("b");

    h.transport.handleProcessExit(1, null);

    await expect(p1).rejects.toBeInstanceOf(AcpProcessExitError);
    await expect(p2).rejects.toBeInstanceOf(AcpProcessExitError);
    await p1.catch((err: AcpProcessExitError) => {
      expect(err.exitCode).toBe(1);
    });
    expect(h.transport.pendingCount).toBe(0);
    expect(h.transport.isClosed).toBe(true);
  });

  it("rejects new requests after process exit", async () => {
    const h = createHarness();
    h.transport.handleProcessExit(0, null);

    await expect(h.transport.request("late")).rejects.toBeInstanceOf(AcpProcessExitError);
  });

  it("fails pending requests when stdout closes without an explicit exit", async () => {
    const h = createHarness();
    const p = h.transport.request("a");

    h.stdout.end();

    await expect(p).rejects.toBeInstanceOf(AcpProcessExitError);
    expect(h.transport.isClosed).toBe(true);
  });

  it("fails pending requests and closes the transport on a stdout stream error", async () => {
    // Round-2 codex finding 3: a stdout `error` previously only logged and left
    // pending requests hanging until timeout, still accepting new requests.
    const h = createHarness();
    const p = h.transport.request("a");

    h.stdout.emit("error", new Error("EPIPE"));

    // Pending request rejects terminally instead of hanging to timeout.
    await expect(p).rejects.toBeInstanceOf(AcpProcessExitError);
    expect(h.transport.isClosed).toBe(true);
    // The error class was logged (no raw payload), and the channel is terminal.
    expect(h.logger.error).toHaveBeenCalledWith(
      "acp.transport.stdout.error",
      expect.objectContaining({ errorClass: "Error" })
    );
    // No new requests are accepted after the error path closes the transport.
    await expect(h.transport.request("late")).rejects.toBeInstanceOf(AcpProcessExitError);
  });

  it("fires one typed stdout terminal event when the channel ends without an exit", async () => {
    // Round-2 codex finding 1: the manager must learn the protocol channel is
    // gone (so it stops reporting healthy) even with no child `exit`.
    const h = createHarness();

    h.stdout.end();
    // A subsequent close event must not re-fire the terminal notification.
    h.stdout.emit("close");

    expect(h.terminals()).toMatchObject([{ channel: "stdout", reason: "stdout_channel_closed" }]);
  });

  it("does not fire onTerminal when the manager drives handleProcessExit/dispose", () => {
    // Terminal channel events represent independent stream loss; manager-driven
    // teardown paths must not double-signal the callback.
    const exitH = createHarness();
    exitH.transport.handleProcessExit(0, null);
    expect(exitH.terminals()).toHaveLength(0);

    const disposeH = createHarness();
    disposeH.transport.dispose();
    expect(disposeH.terminals()).toHaveLength(0);
  });

  it("emits onActivity for an outbound request and for inbound traffic", async () => {
    // Round-2 codex finding 2: the manager resets its idle timer on any protocol
    // activity, not just provider-initiated traffic. The transport must surface
    // outbound requests AND inbound notifications/requests/responses as activity.
    const h = createHarness();

    h.transport.request("session/prompt"); // outbound request -> +1
    const id = decodeWritten(h.written, 0).id as number;
    expect(h.activity()).toBe(1);

    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update" })}\n`); // notif -> +1
    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: "ok" })}\n`); // response -> +1
    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, method: "fs/read_text_file" })}\n`); // inbound request -> +1
    await Promise.resolve();

    expect(h.activity()).toBe(4);
  });

  it("summarizes benign provider stderr through the gateway logger, never stdout", async () => {
    const h = createHarness();
    h.stderr.write("provider warning line\n");
    await Promise.resolve();

    expect(h.logger.debug).toHaveBeenCalledWith(
      "acp.provider.stderr",
      expect.objectContaining({ bytes: 21, redacted: false })
    );
    const [, payload] = (h.logger.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).not.toHaveProperty("line");
  });

  it("suppresses provider stderr prose even when it contains secrets, paths, and payloads", async () => {
    const h = createHarness();
    // Provider stderr is untrusted: an agent can echo a credential path, a token,
    // or a raw JSON-RPC body onto its own stderr. None of the line text may reach
    // the log sink (no_prompt_payloads_in_default_logs / [observability].redaction).
    h.stderr.write(
      'loaded creds from /home/werner/.config/grok/credentials.json token sk-ABCDEF0123456789 body {"prompt":"top secret"}\n'
    );
    await Promise.resolve();

    expect(h.logger.debug).toHaveBeenCalledTimes(1);
    const [, payload] = (h.logger.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    const logged = JSON.stringify(payload);

    expect(logged).not.toContain("/home/werner/.config/grok/credentials.json");
    expect(logged).not.toContain("sk-ABCDEF0123456789");
    expect(logged).not.toContain("top secret");
    expect(logged).not.toContain('{"prompt"');
    expect(payload).toMatchObject({ redacted: true });
    expect(payload).not.toHaveProperty("line");
  });

  it("never writes to the gateway process stdout across a full request lifecycle", async () => {
    const h = createHarness({
      onNotification: () => {},
      onRequest: () => {},
    });

    const p = h.transport.request("initialize", { protocolVersion: 1 });
    const id = decodeWritten(h.written, 0).id as number;
    h.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } })}\n`
    );
    h.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: "ok" })}\n`);
    h.stderr.write("a stderr diagnostic\n");
    await expect(p).resolves.toBe("ok");

    h.transport.notify("session/cancel", { sessionId: "acp-1" });
    h.transport.handleProcessExit(0, null);

    // The transport wrote frames only to the provider stdin PassThrough.
    expect(h.written.length).toBeGreaterThan(0);
    // And NOTHING to the real gateway stdout.
    expect(stdoutWrites).toEqual([]);
  });
});
