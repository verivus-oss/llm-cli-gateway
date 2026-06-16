/**
 * ACP read-only smoke harness (plan step `add-read-only-smoke-harness`).
 *
 * Proves a provider Agent Client Protocol (ACP) process is protocol-healthy
 * without exposing any host capability or sending a prompt. The smoke does only:
 *
 *   1. spawn the provider ACP process (via {@link AcpProcessManager}),
 *   2. `initialize` (run by the process manager under its initialize timeout,
 *      with the read-only posture: no fs/terminal capabilities advertised),
 *   3. `session/new` in a gateway-owned safe temp cwd,
 *   4. capture `protocolVersion` and `agentInfo`,
 *   5. terminate the process.
 *
 * It NEVER sends a prompt, advertises no filesystem/terminal capabilities, and
 * passes an empty {@link HostServices} so any agent-initiated callback is denied
 * by construction (the deny-by-default posture — see client `requireHandler`).
 *
 * Redaction (`resources_redact_local_paths_and_auth_state`): the result that
 * doctor/capability reporting consumes contains ONLY the protocol version, the
 * agent name/version, whether a session was created, a duration, and — on
 * failure — the error kind plus the already-redacted user message. It never
 * carries the provider ACP session id, the cwd/temp path, credential state,
 * account ids, or any raw JSON-RPC body.
 */

import { tmpdir } from "node:os";

import type { HostServices } from "./client.js";
import { AcpError } from "./errors.js";
import { AcpProcessManager, type AcpSpawnFn, type ProcessEnv } from "./process-manager.js";
import { getAcpProviderEntry, providerHasNativeAcp } from "./provider-registry.js";
import type { AcpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { CliType } from "../session-manager.js";

/**
 * The redacted outcome of a single provider ACP smoke. Safe to surface through
 * doctor, capability resources, and logs: it carries no session id, no local
 * path, and no credential/account detail.
 */
export interface AcpSmokeResult {
  /** Provider that was smoked. */
  readonly provider: CliType;
  /** True only when initialize AND session/new both succeeded. */
  readonly ok: boolean;
  /** Negotiated ACP protocol version, or null if initialize never completed. */
  readonly protocolVersion: number | null;
  /** Agent display name from `agentInfo.name`, or null. */
  readonly agentName: string | null;
  /** Agent version from `agentInfo.version`, or null. */
  readonly agentVersion: string | null;
  /** Whether `session/new` returned a session id (the id itself is NOT recorded). */
  readonly sessionCreated: boolean;
  /** Wall-clock duration of the smoke in milliseconds. */
  readonly durationMs: number;
  /** Failure detail (redacted) when `ok` is false, else null. */
  readonly error: { readonly kind: string; readonly message: string } | null;
}

/** The deny-by-default host posture for the smoke: no callbacks are supported. */
const SMOKE_HOST_SERVICES: HostServices = Object.freeze({});

/** Options for {@link runAcpSmoke}. */
export interface AcpSmokeOptions {
  /** Resolved gateway ACP config (timeouts + per-provider entrypoints). */
  readonly config: AcpConfig;
  /** Gateway logger (stderr sink). Defaults to a no-op. */
  readonly logger?: Logger;
  /**
   * Injectable spawner. Defaults to the process manager's `shell:false`
   * `child_process.spawn`. Tests inject a fake to drive the lifecycle without a
   * real provider binary.
   */
  readonly spawn?: AcpSpawnFn;
  /** Base environment to inherit. Defaults to `process.env`. */
  readonly baseEnv?: ProcessEnv;
  /**
   * Working directory for the smoke `session/new`. MUST be a gateway-controlled
   * directory. Defaults to a per-provider subdir of the OS temp dir.
   */
  readonly cwd?: string;
  /** Injectable clock (ms) for deterministic durations in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Run a read-only ACP smoke against a single provider and return a redacted
 * {@link AcpSmokeResult}. Never throws: every failure (unsupported provider,
 * spawn failure, initialize/session-new failure, timeout, process crash) is
 * captured as `ok: false` with a redacted error.
 */
export async function runAcpSmoke(
  provider: CliType,
  options: AcpSmokeOptions
): Promise<AcpSmokeResult> {
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);

  // Fail closed for providers with no native ACP entrypoint — the smoke never
  // spawns an adapter or a non-ACP CLI.
  if (!providerHasNativeAcp(provider)) {
    return {
      provider,
      ok: false,
      protocolVersion: null,
      agentName: null,
      agentVersion: null,
      sessionCreated: false,
      durationMs: elapsed(),
      error: {
        kind: "provider_unavailable",
        message: `${getAcpProviderEntry(provider).displayName} has no native ACP entrypoint.`,
      },
    };
  }

  const manager = new AcpProcessManager({
    config: options.config,
    logger,
    spawn: options.spawn,
    baseEnv: options.baseEnv,
  });
  const cwd = options.cwd ?? `${tmpdir()}/llm-gateway-acp-smoke-${provider}`;

  try {
    // start() spawns and runs `initialize` with the read-only posture (no
    // capabilities advertised). The empty host services deny every callback.
    const proc = await manager.start({ provider, cwd, hostServices: SMOKE_HOST_SERVICES });
    try {
      const init = proc.client.agentInfo;
      const session = await proc.client.newSession({ cwd, mcpServers: [] });
      logger.info("acp.smoke.success", {
        provider,
        protocolVersion: init?.protocolVersion,
        durationMs: elapsed(),
      });
      return {
        provider,
        ok: true,
        protocolVersion: init?.protocolVersion ?? null,
        agentName: init?.agentInfo?.name ?? null,
        agentVersion: init?.agentInfo?.version ?? null,
        sessionCreated: session.sessionId.length > 0,
        durationMs: elapsed(),
        error: null,
      };
    } finally {
      // Always terminate the smoke process; never leave a provider process alive.
      proc.shutdown("SIGTERM");
    }
  } catch (err) {
    const kind = err instanceof AcpError ? err.kind : "unknown";
    const message =
      err instanceof AcpError ? err.userMessage : `ACP smoke for ${provider} failed unexpectedly.`;
    logger.error("acp.smoke.failure", { provider, kind, durationMs: elapsed() });
    return {
      provider,
      ok: false,
      protocolVersion: null,
      agentName: null,
      agentVersion: null,
      sessionCreated: false,
      durationMs: elapsed(),
      error: { kind, message },
    };
  } finally {
    // Defensive: tear down anything still tracked by this single-use manager.
    manager.shutdownAll("SIGKILL");
  }
}

/**
 * Run smokes for several providers sequentially (one provider process at a
 * time) and return their redacted results in input order. Never throws.
 */
export async function runAcpSmokes(
  providers: readonly CliType[],
  options: AcpSmokeOptions
): Promise<AcpSmokeResult[]> {
  const results: AcpSmokeResult[] = [];
  for (const provider of providers) {
    results.push(await runAcpSmoke(provider, options));
  }
  return results;
}

/**
 * The providers that are eligible for an automatic smoke: native-ACP providers
 * that are both globally enabled (`config.enabled`) and per-provider enabled
 * (`config.providers[p].enabled`). Pure; runs no process.
 */
export function eligibleSmokeProviders(config: AcpConfig): CliType[] {
  if (!config.enabled) {
    return [];
  }
  return (Object.keys(config.providers) as CliType[]).filter(
    provider => providerHasNativeAcp(provider) && config.providers[provider]?.enabled === true
  );
}
