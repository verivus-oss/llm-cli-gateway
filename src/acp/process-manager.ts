/**
 * ACP provider process manager.
 *
 * Owns the spawn/kill/idle/health lifecycle for provider Agent Client Protocol
 * (ACP) processes. It is the ONLY ACP module that starts a provider process, so
 * the spawn-safety security invariants live here:
 *
 *  - `no_shell_eval_for_entrypoints`: entrypoints are always an executable plus
 *    an argv array, never a shell string. The process is spawned with
 *    `shell:false` (Node's default) and the argv array is passed verbatim; no
 *    string is ever interpolated into a shell command line. The config loader
 *    (`loadAcpConfig`) additionally rejects shell-metacharacter commands before
 *    they reach here, but this module also re-validates the executable as a
 *    defence-in-depth guard.
 *  - `no_arbitrary_subcommand_execution`: the executable and args are resolved
 *    only from the per-provider config entry and the static provider registry.
 *    This module never derives a command from provider output, prompt text, or
 *    any agent-controlled value.
 *  - `stdout_reserved_for_mcp` / `provider_stdout_is_protocol_only`: the
 *    provider's stdout is piped to the JSON-RPC transport only; it is NEVER
 *    forwarded to the gateway's own stdout. Lifecycle logging goes through the
 *    injected gateway logger (stderr) and is restricted to provider, pid,
 *    durations, exit codes/signals, and error classes — never prompt text, file
 *    contents, credential paths, or raw JSON-RPC bodies
 *    (`no_prompt_payloads_in_default_logs`).
 *
 * The manager hands the already-opened stdio streams to a
 * {@link JsonRpcStdioTransport} (which it constructs) and wires the transport
 * handlers into an {@link AcpClient}. It then enforces the initialize timeout,
 * an idle timeout that kills a process with no in-flight requests, graceful
 * shutdown on demand, and quarantine of crashed processes until they are
 * explicitly recreated.
 *
 * Spawning is injectable ({@link AcpProcessManagerOptions.spawn}) so the
 * lifecycle can be exercised deterministically in tests without real provider
 * binaries; the default spawner is Node's `child_process.spawn` with
 * `shell:false`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";

import { AcpClient, type AcpClientCallbacks, type HostServices } from "./client.js";
import { AcpError, AcpProcessExitError, ProviderUnavailableError } from "./errors.js";
import {
  JsonRpcStdioTransport,
  type JsonRpcInboundRequest,
  type JsonRpcNotification,
} from "./json-rpc-stdio.js";
import { getAcpProviderEntry } from "./provider-registry.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";
import { envWithExtendedPath, getExtendedPath } from "../executor.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { CliType } from "../session-manager.js";

/**
 * Process environment map. Structurally equal to `NodeJS.ProcessEnv`; declared
 * locally so this module avoids the `NodeJS` namespace global (the gateway lint
 * config does not declare it).
 */
export type ProcessEnv = Record<string, string | undefined>;

/**
 * POSIX/Windows termination signal name. A subset is enough for the manager
 * (SIGTERM for graceful shutdown, SIGKILL for force). Declared locally for the
 * same reason as {@link ProcessEnv}.
 */
export type TerminationSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

/**
 * Minimal child-process surface the manager depends on. A real
 * `ChildProcess` satisfies this; tests provide a fake with the same shape so
 * the full lifecycle is exercised without a real binary.
 */
export interface AcpChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** Register exit/error listeners. */
  on(
    event: "exit",
    listener: (code: number | null, signal: TerminationSignal | null) => void
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  /** Send a termination signal. Returns whether the signal was delivered. */
  kill(signal?: TerminationSignal | number): boolean;
}

/** Fully-resolved spawn parameters. Always executable + argv; never a shell string. */
export interface ResolvedAcpSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: ProcessEnv;
}

/** Injectable spawner. Defaults to `child_process.spawn` with `shell:false`. */
export type AcpSpawnFn = (resolved: ResolvedAcpSpawn) => AcpChildProcess;

/** Lifecycle state of a managed provider process. */
export type AcpProcessState = "starting" | "running" | "exited" | "quarantined";

/** Options for {@link AcpProcessManager}. */
export interface AcpProcessManagerOptions {
  /** Resolved gateway ACP config (provides timeouts and per-provider entries). */
  readonly config: AcpConfig;
  /** Gateway logger (stderr sink). Defaults to a no-op. */
  readonly logger?: Logger;
  /**
   * Spawner. Defaults to a `shell:false` `child_process.spawn`. Injected in
   * tests to drive the lifecycle without a real provider binary.
   */
  readonly spawn?: AcpSpawnFn;
  /**
   * Base environment to inherit from. Defaults to `process.env`. Only a minimal,
   * PATH-extended copy is passed to the child; see {@link buildProviderEnv}.
   */
  readonly baseEnv?: ProcessEnv;
}

/** Options for a single {@link AcpProcessManager.start} call. */
export interface StartProviderOptions {
  /** Provider to start. */
  readonly provider: CliType;
  /**
   * Working directory for the provider process. MUST be a real, controlled
   * directory (resolved workspace or a safe temp dir). When omitted, a
   * per-provider subdirectory of the OS temp dir is used.
   */
  readonly cwd?: string;
  /** Gateway-owned host services for agent callbacks. */
  readonly hostServices: HostServices;
  /** Streaming + lifecycle callbacks forwarded to the client. */
  readonly callbacks?: AcpClientCallbacks;
  /**
   * Idle timeout override (ms). When the process has zero in-flight requests
   * for this long it is killed. Defaults to `config.processIdleTimeoutMs`.
   * A non-positive value disables the idle timer.
   */
  readonly idleTimeoutMs?: number;
}

/** A live (or terminal) managed provider process plus its protocol surfaces. */
export interface ManagedAcpProcess {
  readonly provider: CliType;
  readonly pid: number | undefined;
  readonly transport: JsonRpcStdioTransport;
  readonly client: AcpClient;
  /** Current lifecycle state. */
  readonly state: AcpProcessState;
  /** Exit code if the process has exited, else null. */
  readonly exitCode: number | null;
  /** Terminating signal if known, else null. */
  readonly signal: string | null;
  /** Terminal error once the process exited or was quarantined, else null. */
  readonly terminalError: AcpError | null;
  /** Resolved spawn parameters (for assertions/diagnostics; redact before logging). */
  readonly resolved: ResolvedAcpSpawn;
  /** Kill the process and quarantine it. Idempotent. */
  shutdown(signal?: TerminationSignal): void;
  /** Whether the process is currently usable for requests. */
  isHealthy(): boolean;
}

/**
 * Characters that imply a string would require shell interpretation. Mirrors
 * the config loader's guard so this module fails closed even if an entry is
 * constructed programmatically rather than through {@link loadAcpConfig}.
 */
const SHELL_METACHARACTERS = /[\s|&;<>(){}$`"'\\*?[\]~#! ]/;

function assertSafeExecutable(command: string, provider: CliType): void {
  if (command.length === 0 || SHELL_METACHARACTERS.test(command)) {
    throw new ProviderUnavailableError(
      provider,
      "configured ACP command is not a bare executable (shell metacharacters are not allowed)",
      { provider }
    );
  }
}

/**
 * Build the minimal environment passed to a provider ACP process.
 *
 * Inherits the base environment (so credential lookups managed by the installed
 * CLI continue to work — required for Grok per the provider matrix) but extends
 * PATH so the provider executable resolves the same way the CLI executor
 * resolves request commands. Provider-specific isolation is layered on top.
 */
export function buildProviderEnv(
  provider: CliType,
  providerConfig: AcpProviderConfig,
  baseEnv: ProcessEnv
): ProcessEnv {
  const env = envWithExtendedPath(baseEnv, getExtendedPath());

  // Provider-specific isolation. Grok supports an isolated "leader socket" so a
  // gateway-spawned agent process does not collide with an interactive user
  // session. The isolation is expressed as a per-process socket path under the
  // OS temp dir; it is data-only and never a shell string.
  if (provider === "grok" && providerConfig.isolatedLeaderSocket) {
    const socketDir = tmpdir();
    const socketName = `grok-acp-leader-${process.pid}-${Date.now()}.sock`;
    env.GROK_LEADER_SOCKET = `${socketDir}/${socketName}`;
  }

  return env;
}

/**
 * Resolve a provider's spawn parameters from the per-provider config entry and
 * the static provider registry. Performs no I/O and runs no subcommand.
 *
 * The provider config's command/args take precedence (operator override); the
 * registry entrypoint is the fallback. Either way the result is executable +
 * argv only.
 */
export function resolveProviderSpawn(
  provider: CliType,
  config: AcpConfig,
  baseEnv: ProcessEnv,
  cwd?: string
): ResolvedAcpSpawn {
  const providerConfig = config.providers[provider];
  const registryEntry = getAcpProviderEntry(provider);

  let command: string;
  let args: readonly string[];
  if (providerConfig && providerConfig.command.length > 0) {
    command = providerConfig.command;
    args = providerConfig.args;
  } else if (registryEntry.entrypoint) {
    command = registryEntry.entrypoint.command;
    args = registryEntry.entrypoint.args;
  } else {
    throw new ProviderUnavailableError(
      provider,
      "no ACP entrypoint configured and provider has no native ACP entrypoint",
      { provider }
    );
  }

  assertSafeExecutable(command, provider);
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new ProviderUnavailableError(provider, "ACP args must be strings", { provider });
    }
  }

  const effectiveConfig: AcpProviderConfig = providerConfig ?? {
    enabled: false,
    command,
    args: [...args],
    runtimeEnabled: false,
    isolatedLeaderSocket: false,
  };

  return {
    command,
    args: [...args],
    cwd: cwd ?? `${tmpdir()}/llm-gateway-acp-${provider}`,
    env: buildProviderEnv(provider, effectiveConfig, baseEnv),
  };
}

/**
 * Default spawner: Node `child_process.spawn` with shell disabled. Exported so
 * the spawn path (including working-directory creation) is testable without a
 * real provider binary.
 */
export const defaultSpawn: AcpSpawnFn = (resolved): AcpChildProcess => {
  // Ensure the working directory exists before spawning. The default no-cwd path
  // resolves to a gateway-owned `${tmpdir()}/llm-gateway-acp-<provider>` directory
  // that may not exist on a clean host; passing a missing cwd to spawn yields
  // ENOENT. `recursive: true` makes this idempotent and a no-op when the caller
  // supplied an already-existing directory. Failures here are surfaced through the
  // manager's spawn try/catch as a typed ProviderUnavailableError.
  //
  // resolved.cwd is gateway-controlled: it is either a caller-supplied workspace
  // path or the gateway-owned `${tmpdir()}/llm-gateway-acp-<provider>` default
  // from resolveProviderSpawn. It is never derived from provider output, prompt
  // text, or any agent-controlled value, so the non-literal-fs heuristic does not
  // apply here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(resolved.cwd, { recursive: true });
  const child = nodeSpawn(resolved.command, [...resolved.args], {
    cwd: resolved.cwd,
    env: resolved.env,
    // SECURITY: shell is explicitly disabled. argv is passed verbatim; no shell
    // metacharacter in any value is ever interpreted. stdin/stdout are pipes for
    // the JSON-RPC transport; stderr is a pipe forwarded through the gateway
    // logger. stdout is NEVER inherited (would leak onto gateway stdout).
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return child as unknown as AcpChildProcess;
};

/**
 * Manages provider ACP process lifecycles. One manager can supervise multiple
 * providers; each {@link start} returns an independent {@link ManagedAcpProcess}.
 */
export class AcpProcessManager {
  private readonly config: AcpConfig;
  private readonly logger: Logger;
  private readonly spawnFn: AcpSpawnFn;
  private readonly baseEnv: ProcessEnv;
  private readonly live = new Set<ManagedProcessImpl>();

  constructor(options: AcpProcessManagerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? noopLogger;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  /**
   * Spawn a provider ACP process, wire its stdio into a JSON-RPC transport and
   * an {@link AcpClient}, then run {@link AcpClient.initialize} under the
   * configured initialize timeout.
   *
   * On any spawn or initialize failure the process is quarantined and a typed
   * {@link AcpError} is thrown. The returned process is healthy and initialized.
   */
  async start(options: StartProviderOptions): Promise<ManagedAcpProcess> {
    const resolved = resolveProviderSpawn(options.provider, this.config, this.baseEnv, options.cwd);

    let child: AcpChildProcess;
    try {
      child = this.spawnFn(resolved);
    } catch (err) {
      this.logger.error("acp.process.spawn.failed", {
        provider: options.provider,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
      throw new ProviderUnavailableError(options.provider, "failed to spawn ACP process", {
        provider: options.provider,
      });
    }

    if (!child.stdin || !child.stdout) {
      // Spawn produced no usable stdio. Kill defensively and fail closed.
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
      throw new ProviderUnavailableError(
        options.provider,
        "ACP process did not expose stdin/stdout pipes",
        { provider: options.provider }
      );
    }

    this.logger.info("acp.process.spawn", {
      provider: options.provider,
      pid: child.pid,
    });

    const managed = new ManagedProcessImpl({
      provider: options.provider,
      child,
      resolved,
      logger: this.logger,
      hostServices: options.hostServices,
      callbacks: options.callbacks,
      idleTimeoutMs: options.idleTimeoutMs ?? this.config.processIdleTimeoutMs,
      initializeTimeoutMs: this.config.initializeTimeoutMs,
      onTerminal: m => this.live.delete(m),
    });
    this.live.add(managed);

    try {
      await managed.initialize();
    } catch (err) {
      managed.shutdown("SIGKILL");
      this.live.delete(managed);
      throw err instanceof AcpError
        ? err
        : new ProviderUnavailableError(options.provider, "ACP initialize failed", {
            provider: options.provider,
          });
    }

    return managed;
  }

  /**
   * Kill every live provider process. Called on gateway shutdown so no provider
   * ACP process outlives the gateway. Idempotent.
   */
  shutdownAll(signal: TerminationSignal = "SIGTERM"): void {
    for (const managed of [...this.live]) {
      managed.shutdown(signal);
    }
    this.live.clear();
  }

  /** Number of currently live (non-terminal) managed processes. */
  get liveCount(): number {
    return this.live.size;
  }
}

interface ManagedProcessImplOptions {
  readonly provider: CliType;
  readonly child: AcpChildProcess;
  readonly resolved: ResolvedAcpSpawn;
  readonly logger: Logger;
  readonly hostServices: HostServices;
  readonly callbacks?: AcpClientCallbacks;
  readonly idleTimeoutMs: number;
  readonly initializeTimeoutMs: number;
  readonly onTerminal: (self: ManagedProcessImpl) => void;
}

/**
 * Concrete managed process. Wires the transport handlers into the client,
 * tracks lifecycle state, enforces the idle timeout, and quarantines on exit.
 */
class ManagedProcessImpl implements ManagedAcpProcess {
  readonly provider: CliType;
  readonly pid: number | undefined;
  readonly transport: JsonRpcStdioTransport;
  readonly client: AcpClient;
  readonly resolved: ResolvedAcpSpawn;

  private readonly child: AcpChildProcess;
  private readonly logger: Logger;
  private readonly callbacks?: AcpClientCallbacks;
  private readonly idleTimeoutMs: number;
  private readonly onTerminal: (self: ManagedProcessImpl) => void;

  private _state: AcpProcessState = "starting";
  private _exitCode: number | null = null;
  private _signal: string | null = null;
  private _terminalError: AcpError | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ManagedProcessImplOptions) {
    this.provider = options.provider;
    this.child = options.child;
    this.pid = options.child.pid;
    this.resolved = options.resolved;
    this.logger = options.logger;
    this.callbacks = options.callbacks;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onTerminal = options.onTerminal;

    // The transport consumes provider stdout as protocol frames only and
    // forwards provider stderr through the gateway logger. Provider stdout is
    // NEVER piped to gateway stdout.
    this.transport = new JsonRpcStdioTransport({
      streams: {
        stdin: options.child.stdin as Writable,
        stdout: options.child.stdout as Readable,
        stderr: options.child.stderr ?? null,
      },
      logger: this.logger,
      provider: this.provider,
      onNotification: (n: JsonRpcNotification) => {
        this.client.handleNotification(n.method, n.params);
      },
      onRequest: (r: JsonRpcInboundRequest) => {
        this.client.handleRequest(r.id, r.method, r.params);
      },
      // Any protocol traffic (client request issued, or inbound
      // notification/request/response) resets the idle timer, so a process is
      // killed only after genuine quiescence — not immediately after a
      // client-driven request/response exchange.
      onActivity: () => this.touchIdle(),
      // The stdout protocol channel ended without a child `exit` (e.g. the
      // agent closed its stdout, or stdout errored). Drive the managed process
      // terminal so it stops reporting healthy/live.
      onClose: () => this.handleChannelClosed(),
    });

    this.client = new AcpClient({
      transport: this.transport,
      provider: this.provider,
      hostServices: options.hostServices,
      callbacks: options.callbacks,
      logger: this.logger,
      // The manager owns the configured initialize timeout; it is the only
      // bounded ACP call the manager drives directly. Per-session/prompt
      // timeouts are applied by higher layers when they call the client.
      timeouts: { initializeMs: options.initializeTimeoutMs },
    });

    // Wire process exit -> transport teardown + quarantine. Both `exit` and
    // `error` are terminal.
    options.child.on("exit", (code, signal) => this.handleExit(code, signal));
    options.child.on("error", err => this.handleSpawnError(err));
  }

  get state(): AcpProcessState {
    return this._state;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signal(): string | null {
    return this._signal;
  }

  get terminalError(): AcpError | null {
    return this._terminalError;
  }

  /**
   * Run the ACP `initialize` handshake under the configured initialize timeout
   * (applied by the client) and transition to "running". The smoke posture is
   * used here: no host capabilities are advertised, so the agent cannot request
   * filesystem or terminal services during start.
   */
  async initialize(): Promise<void> {
    this.logger.info("acp.initialize.start", { provider: this.provider });
    const response = await this.client.initialize();
    this._state = "running";
    this.armIdleTimer();
    this.logger.info("acp.initialize.success", {
      provider: this.provider,
      protocolVersion: response.protocolVersion,
    });
  }

  /** Reset the idle timer whenever there is protocol activity. */
  private touchIdle(): void {
    if (this._state !== "running") {
      return;
    }
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleTimeoutMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      // Only kill when nothing is in flight; otherwise re-arm.
      if (this.transport.pendingCount > 0) {
        this.armIdleTimer();
        return;
      }
      this.logger.info("acp.process.idle_timeout", {
        provider: this.provider,
        pid: this.pid,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.shutdown("SIGTERM");
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private handleExit(code: number | null, signal: TerminationSignal | null): void {
    if (this._state === "exited" || this._state === "quarantined") {
      // Already terminal (e.g. shutdown initiated). Record exit detail and stop.
      this._exitCode = code;
      this._signal = signal;
      return;
    }
    this._exitCode = code;
    this._signal = signal;
    this._state = "exited";
    this.clearIdleTimer();
    // Propagate the exit to the transport so every pending request rejects with
    // a terminal AcpProcessExitError, then record an equivalent terminal error
    // for callers querying this managed process.
    this.transport.handleProcessExit(code, signal);
    const error = new AcpProcessExitError(this.provider, {
      exitCode: code,
      signal,
      debug: { code, signal },
    });
    this._terminalError = error;
    this.logger.error("acp.process.exit", {
      provider: this.provider,
      pid: this.pid,
      exitCode: code,
      signal,
    });
    this.client.notifyProcessExit(error);
    this.onTerminal(this);
  }

  private handleSpawnError(err: Error): void {
    if (this._state === "exited" || this._state === "quarantined") {
      return;
    }
    this._state = "quarantined";
    this.clearIdleTimer();
    const error = new AcpProcessExitError(this.provider, {
      debug: { reason: "spawn_error", errorClass: err.name },
    });
    this._terminalError = error;
    this.transport.dispose();
    this.logger.error("acp.process.error", {
      provider: this.provider,
      pid: this.pid,
      errorClass: err.name,
    });
    this.client.notifyProcessExit(error);
    this.onTerminal(this);
  }

  /**
   * The provider's stdout protocol channel ended without a child `exit` signal
   * (the transport's {@link JsonRpcStdioTransportOptions.onClose}). The process
   * may still be alive at the OS level, but it can no longer speak ACP, so it
   * must not be reported healthy. Quarantine it: a fresh process is required.
   *
   * Idempotent and a no-op once any terminal path has run (`exit` may still
   * arrive afterwards and is handled separately by {@link handleExit}).
   */
  private handleChannelClosed(): void {
    if (this._state === "exited" || this._state === "quarantined") {
      return;
    }
    this._state = "quarantined";
    this.clearIdleTimer();
    const error =
      this._terminalError ??
      new AcpProcessExitError(this.provider, {
        debug: { reason: "stdout_channel_closed" },
      });
    this._terminalError = error;
    this.logger.error("acp.process.channel_closed", {
      provider: this.provider,
      pid: this.pid,
    });
    // The transport has already failed its own pending requests; notify the
    // client so any awaiting caller surfaces a terminal error, then signal the
    // pool. Best-effort kill so we do not leak a half-dead OS process.
    this.client.notifyProcessExit(error);
    try {
      this.child.kill("SIGTERM");
    } catch (err) {
      this.logger.error("acp.process.kill_failed", {
        provider: this.provider,
        pid: this.pid,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    }
    this.onTerminal(this);
  }

  /**
   * Kill the process and quarantine it. A quarantined process cannot be reused;
   * the caller must {@link AcpProcessManager.start} a fresh one. Idempotent.
   */
  shutdown(signal: TerminationSignal = "SIGTERM"): void {
    if (this._state === "exited" || this._state === "quarantined") {
      return;
    }
    this.clearIdleTimer();
    const wasRunning = this._state === "running" || this._state === "starting";
    this._state = "quarantined";
    if (!this._terminalError) {
      this._terminalError = new AcpProcessExitError(this.provider, {
        debug: { reason: "shutdown", signal },
      });
    }
    // Dispose the transport first so pending requests reject deterministically,
    // then signal the process.
    this.transport.dispose();
    if (wasRunning) {
      try {
        this.child.kill(signal);
      } catch (err) {
        this.logger.error("acp.process.kill_failed", {
          provider: this.provider,
          pid: this.pid,
          errorClass: err instanceof Error ? err.name : "unknown",
        });
      }
    }
    this.logger.info("acp.process.shutdown", {
      provider: this.provider,
      pid: this.pid,
      signal,
    });
    this.onTerminal(this);
  }

  isHealthy(): boolean {
    return this._state === "running";
  }
}
