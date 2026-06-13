import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostServices } from "../acp/client.js";
import { AcpError, AcpProcessExitError } from "../acp/errors.js";
import {
  AcpProcessManager,
  buildProviderEnv,
  defaultSpawn,
  resolveProviderSpawn,
  type AcpChildProcess,
  type AcpSpawnFn,
  type ResolvedAcpSpawn,
} from "../acp/process-manager.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";
import {
  DEFAULT_ACP_INITIALIZE_TIMEOUT_MS,
  DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS,
} from "../config.js";
import type { Logger } from "../logger.js";

// Step: add-acp-process-manager.
// Validation: tests assert argv is passed without shell parsing, cwd is
// controlled, provider-specific env isolation can be applied, idle timeout kills
// the process, and crashed process state is reported to callers.
//
// test_matrix.integration.gateway_tools row exercised here:
//  - async jobs record ACP terminal failures correctly (terminal process error
//    surfaced to callers via onProcessExit + terminalError).

function makeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
}

function makeProviderConfig(overrides: Partial<AcpProviderConfig> = {}): AcpProviderConfig {
  return {
    enabled: true,
    command: "vibe-acp",
    args: [],
    runtimeEnabled: false,
    isolatedLeaderSocket: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AcpConfig> = {}): AcpConfig {
  return {
    enabled: true,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS,
    initializeTimeoutMs: DEFAULT_ACP_INITIALIZE_TIMEOUT_MS,
    sessionNewTimeoutMs: 10000,
    promptTimeoutMs: 600000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    fallbackToCliWhenUnhealthy: true,
    providers: {},
    sources: { configFile: null },
    ...overrides,
  };
}

interface JsonRpcFrame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A fake child process: stdin/stdout/stderr are real streams the transport
 * drives, and exit/error are emitted on demand. `kill` is a spy. It also reads
 * client-written frames and (optionally) auto-replies to `initialize` so the
 * manager's `start` resolves without a real binary.
 */
class FakeChild extends EventEmitter implements AcpChildProcess {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: Array<string | number | undefined> = [];

  private buffer = "";
  private readonly handlers = new Map<string, (f: JsonRpcFrame) => void>();

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) {
          const frame = JSON.parse(line) as JsonRpcFrame;
          if (frame.method) this.handlers.get(frame.method)?.(frame);
        }
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  /** Register a handler for a client-initiated method. */
  on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener);
  }

  /** Register a JSON-RPC method handler (separate channel from EventEmitter). */
  onMethod(method: string, handler: (f: JsonRpcFrame) => void): this {
    this.handlers.set(method, handler);
    return this;
  }

  reply(id: number | string | undefined, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Auto-reply to initialize with a minimal valid response. */
  autoInitialize(agentName = "vibe-acp"): this {
    return this.onMethod("initialize", f =>
      this.reply(f.id, {
        protocolVersion: 1,
        agentInfo: { name: agentName, version: "2.14.1" },
      })
    );
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
  }

  emitError(err: Error): void {
    this.emit("error", err);
  }

  kill(signal?: string | number): boolean {
    this.killed.push(signal);
    return true;
  }
}

/** Build a spawn fn that returns the given child and records resolved params. */
function recordingSpawn(child: AcpChildProcess): {
  spawn: AcpSpawnFn;
  resolved: ResolvedAcpSpawn[];
} {
  const resolved: ResolvedAcpSpawn[] = [];
  const spawn: AcpSpawnFn = r => {
    resolved.push(r);
    return child;
  };
  return { spawn, resolved };
}

describe("AcpProcessManager", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrites: string[];

  beforeEach(() => {
    // Security invariant: the manager must never write to gateway stdout.
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

  describe("resolveProviderSpawn", () => {
    it("passes argv as an array with no shell parsing (grok agent stdio)", () => {
      const config = makeConfig({
        providers: {
          grok: makeProviderConfig({ command: "grok", args: ["agent", "stdio"] }),
        },
      });
      const resolved = resolveProviderSpawn("grok", config, {});
      expect(resolved.command).toBe("grok");
      expect(resolved.args).toEqual(["agent", "stdio"]);
      // No single concatenated shell string is ever produced.
      expect(resolved.args).not.toContain("grok agent stdio");
    });

    it("falls back to the registry entrypoint when no provider config command", () => {
      const resolved = resolveProviderSpawn("mistral", makeConfig(), {});
      expect(resolved.command).toBe("vibe-acp");
      expect(resolved.args).toEqual([]);
    });

    it("rejects a shell-style command with metacharacters", () => {
      const config = makeConfig({
        providers: { mistral: makeProviderConfig({ command: "vibe-acp; rm -rf /" }) },
      });
      expect(() => resolveProviderSpawn("mistral", config, {})).toThrowError(AcpError);
    });

    it("throws when the provider has no entrypoint at all (codex)", () => {
      // codex has no native entrypoint in the registry and no config override.
      expect(() => resolveProviderSpawn("codex", makeConfig(), {})).toThrowError(AcpError);
    });

    it("uses the provided cwd verbatim and a temp cwd otherwise", () => {
      const withCwd = resolveProviderSpawn("mistral", makeConfig(), {}, "/work/space");
      expect(withCwd.cwd).toBe("/work/space");

      const withoutCwd = resolveProviderSpawn("mistral", makeConfig(), {});
      expect(withoutCwd.cwd.startsWith(tmpdir())).toBe(true);
    });
  });

  describe("buildProviderEnv", () => {
    it("applies Grok leader-socket isolation when enabled", () => {
      const env = buildProviderEnv(
        "grok",
        makeProviderConfig({ command: "grok", isolatedLeaderSocket: true }),
        {}
      );
      expect(typeof env.GROK_LEADER_SOCKET).toBe("string");
      expect(env.GROK_LEADER_SOCKET).toContain(tmpdir());
    });

    it("does not set leader socket isolation when disabled", () => {
      const env = buildProviderEnv(
        "grok",
        makeProviderConfig({ command: "grok", isolatedLeaderSocket: false }),
        {}
      );
      expect(env.GROK_LEADER_SOCKET).toBeUndefined();
    });

    it("inherits the base env (credential lookup managed by the CLI) and extends PATH", () => {
      const env = buildProviderEnv("mistral", makeProviderConfig(), {
        SOME_CREDENTIAL_REF: "managed-by-cli",
      });
      expect(env.SOME_CREDENTIAL_REF).toBe("managed-by-cli");
      expect(typeof env.PATH).toBe("string");
    });
  });

  describe("start", () => {
    it("spawns with the controlled cwd and argv and initializes", async () => {
      const child = new FakeChild().autoInitialize();
      const { spawn, resolved } = recordingSpawn(child);
      const manager = new AcpProcessManager({
        config: makeConfig({
          providers: { mistral: makeProviderConfig({ command: "vibe-acp" }) },
        }),
        spawn,
        logger: makeLogger(),
        baseEnv: {},
      });

      const proc = await manager.start({
        provider: "mistral",
        cwd: "/disposable/workspace",
        hostServices: {},
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].command).toBe("vibe-acp");
      expect(resolved[0].args).toEqual([]);
      expect(resolved[0].cwd).toBe("/disposable/workspace");
      expect(proc.isHealthy()).toBe(true);
      expect(proc.state).toBe("running");
      expect(proc.client.isInitialized).toBe(true);
      expect(proc.client.agentInfo?.protocolVersion).toBe(1);
      expect(manager.liveCount).toBe(1);

      // No gateway stdout writes occurred during spawn/initialize.
      expect(stdoutWrites).toHaveLength(0);

      proc.shutdown();
    });

    it("fails closed with a typed error when spawn produces no stdio", async () => {
      const noStdio: AcpChildProcess = {
        pid: 1,
        stdin: null,
        stdout: null,
        stderr: null,
        on: () => undefined,
        kill: () => true,
      };
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => noStdio,
        baseEnv: {},
      });
      await expect(manager.start({ provider: "mistral", hostServices: {} })).rejects.toBeInstanceOf(
        AcpError
      );
      expect(manager.liveCount).toBe(0);
    });

    it("propagates a typed initialize timeout and quarantines the process", async () => {
      // Child never replies to initialize -> the configured initialize timeout
      // must fire and the process must be quarantined (not left live).
      const child = new FakeChild(); // no autoInitialize
      const manager = new AcpProcessManager({
        config: makeConfig({
          initializeTimeoutMs: 20,
          providers: { mistral: makeProviderConfig() },
        }),
        spawn: () => child,
        baseEnv: {},
      });
      await expect(manager.start({ provider: "mistral", hostServices: {} })).rejects.toBeInstanceOf(
        AcpError
      );
      expect(manager.liveCount).toBe(0);
      // The process was killed during quarantine.
      expect(child.killed.length).toBeGreaterThan(0);
    });
  });

  describe("defaultSpawn (real process)", () => {
    // The default no-cwd path resolves the working directory to a gateway-owned
    // `${tmpdir()}/llm-gateway-acp-<provider>` directory that may not exist on a
    // clean host. defaultSpawn must create it before spawning, otherwise a real
    // child_process.spawn rejects the missing cwd with ENOENT. These tests drive
    // the real spawner (not an injected fake) so the directory-creation path and
    // a successful real spawn are exercised.
    const createdDirs: string[] = [];
    afterEach(() => {
      for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("creates a missing default working directory and spawns successfully", () => {
      // Mimic resolveProviderSpawn's default no-cwd result with a unique,
      // guaranteed-missing temp subdirectory.
      const missingCwd = join(tmpdir(), `llm-gateway-acp-test-${process.pid}-${Date.now()}`);
      createdDirs.push(missingCwd);
      expect(existsSync(missingCwd)).toBe(false);

      const child = defaultSpawn({
        // A real, always-present executable that exits immediately; we only need
        // the spawn to succeed against the freshly created cwd.
        command: process.execPath,
        args: ["-e", "0"],
        cwd: missingCwd,
        env: { PATH: process.env.PATH ?? "" },
      });

      // Directory now exists and the spawn produced a live child with a pid and
      // the wired stdio pipes — i.e. no ENOENT from a missing cwd.
      expect(existsSync(missingCwd)).toBe(true);
      expect(typeof child.pid).toBe("number");
      expect(child.stdin).not.toBeNull();
      expect(child.stdout).not.toBeNull();

      child.kill("SIGKILL");
    });

    it("tolerates an already-existing working directory (idempotent mkdir)", () => {
      // tmpdir() always exists; the recursive mkdir must be a no-op, not throw.
      const child = defaultSpawn({
        command: process.execPath,
        args: ["-e", "0"],
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(typeof child.pid).toBe("number");
      child.kill("SIGKILL");
    });
  });

  describe("idle timeout", () => {
    it("kills the process after the idle window with no in-flight requests", async () => {
      vi.useFakeTimers();
      const child = new FakeChild().autoInitialize();
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        logger: makeLogger(),
        baseEnv: {},
      });

      const startPromise = manager.start({
        provider: "mistral",
        hostServices: {},
        idleTimeoutMs: 1000,
      });
      // Let the initialize round-trip settle on the microtask queue while timers
      // are faked.
      await vi.advanceTimersByTimeAsync(0);
      const proc = await startPromise;
      expect(proc.isHealthy()).toBe(true);
      expect(child.killed).toHaveLength(0);

      // No activity for the idle window -> process killed and quarantined.
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.killed.length).toBeGreaterThan(0);
      expect(proc.isHealthy()).toBe(false);
      expect(proc.state).toBe("quarantined");
    });

    it("resets the idle timer on client-driven request/response activity", async () => {
      // Round-2 codex finding 2: previously the idle timer was only reset by
      // provider-initiated traffic, so a client request answered just before the
      // window elapsed could be followed immediately by a kill. A client
      // request + its response is protocol activity and must re-arm the timer.
      vi.useFakeTimers();
      const child = new FakeChild().autoInitialize();
      // Echo every session/prompt back as a result so the round-trip completes.
      child.onMethod("session/prompt", f => child.reply(f.id, { stopReason: "end_turn" }));
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        logger: makeLogger(),
        baseEnv: {},
      });

      const startPromise = manager.start({
        provider: "mistral",
        hostServices: {},
        idleTimeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      const proc = await startPromise;

      // Just before the idle window elapses, drive a client request/response.
      await vi.advanceTimersByTimeAsync(900);
      expect(proc.isHealthy()).toBe(true);
      const promptDone = proc.client.prompt({
        sessionId: "s1",
        prompt: [{ type: "text", text: "hi" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await promptDone;

      // The exchange reset the idle timer, so 900ms later (1800ms total from
      // start, but only 900ms since the activity) the process is still healthy.
      await vi.advanceTimersByTimeAsync(900);
      expect(proc.isHealthy()).toBe(true);
      expect(child.killed).toHaveLength(0);

      // Only after a full quiet window from the last activity is it killed.
      await vi.advanceTimersByTimeAsync(100);
      expect(proc.isHealthy()).toBe(false);
      expect(proc.state).toBe("quarantined");
    });
  });

  describe("stdout protocol channel loss without a child exit", () => {
    it("stops reporting healthy and quarantines when stdout ends without exit", async () => {
      // Round-2 codex finding 1: if the ACP stdout channel closes but the child
      // emits no `exit`, the manager previously kept state === "running" and
      // isHealthy() === true. The transport's onClose must drive it terminal.
      const child = new FakeChild().autoInitialize();
      const exits: AcpError[] = [];
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        logger: makeLogger(),
        baseEnv: {},
      });

      const proc = await manager.start({
        provider: "mistral",
        hostServices: {},
        callbacks: { onProcessExit: e => exits.push(e) },
      });
      expect(proc.isHealthy()).toBe(true);
      expect(manager.liveCount).toBe(1);

      // The agent closes its stdout; no child `exit` event is emitted. Wait for
      // the stream's `end`/`close` to propagate to the transport's onClose.
      await new Promise<void>(resolve => {
        child.stdout.once("end", () => resolve());
        child.stdout.once("close", () => resolve());
        child.stdout.end();
      });
      await Promise.resolve();

      expect(proc.isHealthy()).toBe(false);
      expect(proc.state).toBe("quarantined");
      expect(proc.terminalError).toBeInstanceOf(AcpProcessExitError);
      expect(exits).toHaveLength(1);
      // The process was killed defensively (no half-dead OS process left).
      expect(child.killed.length).toBeGreaterThan(0);
      // It is no longer tracked as live.
      expect(manager.liveCount).toBe(0);
    });

    it("fails an in-flight client request when the stdout channel is lost", async () => {
      const child = new FakeChild().autoInitialize();
      // Never reply to the prompt; the channel loss must reject it terminally.
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        logger: makeLogger(),
        baseEnv: {},
      });

      const proc = await manager.start({ provider: "mistral", hostServices: {} });
      const inflight = proc.client.prompt({
        sessionId: "s1",
        prompt: [{ type: "text", text: "hi" }],
      });
      await Promise.resolve();

      child.stdout.end();

      await expect(inflight).rejects.toBeInstanceOf(AcpProcessExitError);
      expect(proc.isHealthy()).toBe(false);
    });
  });

  describe("crash reporting", () => {
    it("reports crashed process state to callers via terminalError and onProcessExit", async () => {
      const child = new FakeChild().autoInitialize();
      const exits: AcpError[] = [];
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        logger: makeLogger(),
        baseEnv: {},
      });

      const proc = await manager.start({
        provider: "mistral",
        hostServices: {},
        callbacks: { onProcessExit: e => exits.push(e) },
      });
      expect(proc.isHealthy()).toBe(true);

      // Simulate a mid-session crash.
      child.emitExit(139, "SIGSEGV" as NodeJS.Signals);

      expect(proc.state).toBe("exited");
      expect(proc.isHealthy()).toBe(false);
      expect(proc.exitCode).toBe(139);
      expect(proc.signal).toBe("SIGSEGV");
      expect(proc.terminalError).toBeInstanceOf(AcpProcessExitError);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toBeInstanceOf(AcpProcessExitError);
      expect(manager.liveCount).toBe(0);
    });

    it("rejects a pending request after the process exits", async () => {
      const child = new FakeChild().autoInitialize();
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        baseEnv: {},
      });
      const proc = await manager.start({ provider: "mistral", hostServices: {} });

      // Issue a request the child will never answer, then crash the process.
      const pending = proc.transport.request("session/new", { cwd: "/tmp" }, 0);
      child.emitExit(1, null);
      await expect(pending).rejects.toBeInstanceOf(AcpProcessExitError);
    });

    it("surfaces a spawn 'error' event as a quarantined terminal error", async () => {
      const child = new FakeChild().autoInitialize();
      const exits: AcpError[] = [];
      const manager = new AcpProcessManager({
        config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
        spawn: () => child,
        baseEnv: {},
      });
      const proc = await manager.start({
        provider: "mistral",
        hostServices: {},
        callbacks: { onProcessExit: e => exits.push(e) },
      });

      child.emitError(new Error("ENOENT"));
      expect(proc.state).toBe("quarantined");
      expect(proc.terminalError).toBeInstanceOf(AcpProcessExitError);
      expect(exits).toHaveLength(1);
    });
  });

  describe("shutdownAll", () => {
    it("kills every live process on gateway shutdown", async () => {
      const childA = new FakeChild().autoInitialize();
      const childB = new FakeChild().autoInitialize();
      const children = [childA, childB];
      let next = 0;
      const manager = new AcpProcessManager({
        config: makeConfig({
          providers: {
            mistral: makeProviderConfig({ command: "vibe-acp" }),
            grok: makeProviderConfig({ command: "grok", args: ["agent", "stdio"] }),
          },
        }),
        spawn: () => children[next++],
        baseEnv: {},
      });

      const a = await manager.start({ provider: "mistral", hostServices: {} });
      const b = await manager.start({ provider: "grok", hostServices: {} });
      expect(manager.liveCount).toBe(2);

      manager.shutdownAll("SIGTERM");

      expect(childA.killed).toContain("SIGTERM");
      expect(childB.killed).toContain("SIGTERM");
      expect(a.state).toBe("quarantined");
      expect(b.state).toBe("quarantined");
      expect(manager.liveCount).toBe(0);
    });
  });

  it("never writes a hostServices method during start (read-only smoke posture)", async () => {
    const readSpy = vi.fn();
    const writeSpy = vi.fn();
    const hostServices: HostServices = {
      readTextFile: readSpy,
      writeTextFile: writeSpy,
    };
    const child = new FakeChild().autoInitialize();
    const manager = new AcpProcessManager({
      config: makeConfig({ providers: { mistral: makeProviderConfig() } }),
      spawn: () => child,
      baseEnv: {},
    });
    const proc = await manager.start({ provider: "mistral", hostServices });
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    proc.shutdown();
  });
});
