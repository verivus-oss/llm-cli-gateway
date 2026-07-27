/**
 * Non-blocking provider version drift check, run once per gateway start.
 *
 * Drift between an installed provider CLI and its declared contract used to be
 * invisible until `pre-release.sh` ran, because that is the only gate that
 * probes real binaries. This surfaces it at the earliest moment a gateway
 * process could plausibly notice.
 *
 * Three properties matter, in this order:
 *
 *  1. It NEVER delays readiness. The caller fires it after the transport is
 *     connected and does not await it. Collecting versions spawns one
 *     `--version` per provider, which is cheap individually but is not
 *     something to put in front of a client's first request.
 *  2. It is SILENT when everything matches. A startup line that is almost
 *     always "all fine" trains people to skip it, and this competes for
 *     attention with real errors on stderr.
 *  3. It never performs network work. Upgrade availability costs registry
 *     round trips and belongs behind an explicit request
 *     (`provider_version_guard` with `checkUpgrades`), not on every boot.
 */
import type { Logger } from "./logger.js";
import { CLI_TYPES, type CliType } from "./provider-types.js";
import { executeCli, providerCommandName } from "./executor.js";
import { compareInstalledToTargets, summarizeVersionGuard } from "./provider-version-guard.js";

/** Map of provider to reported version, or null when the CLI is absent. */
export type InstalledVersionMap = Partial<Record<CliType, string | null>>;

/**
 * Collect installed provider versions WITHOUT blocking the event loop.
 *
 * Deliberately does not use `getCliVersions`. That path reaches `spawnSync`
 * (via getProviderRuntimeStatus) before its first await, so marking the caller
 * `void` buys nothing: control does not return until every probe has finished.
 * Measured on this host, `void runStartupVersionCheck()` blocked for 5277 ms,
 * which is 5 seconds during which a gateway that has just announced itself
 * ready cannot serve anything.
 *
 * `executeCli` spawns asynchronously, so the probes interleave with real work
 * instead of stalling it.
 *
 * @param timeoutMs Per-provider timeout.
 * @returns Reported version per provider; null where the CLI is missing.
 */
export async function collectInstalledVersionsAsync(
  timeoutMs = 5_000
): Promise<InstalledVersionMap> {
  const entries = await Promise.all(
    CLI_TYPES.map(async cli => {
      try {
        const result = await executeCli(providerCommandName(cli), ["--version"], {
          timeout: timeoutMs,
        });
        const text = `${result.stdout ?? ""}`.trim() || `${result.stderr ?? ""}`.trim();
        return [cli, text ? text.split("\n")[0].trim() : null] as const;
      } catch {
        // Absent CLI, non-zero exit, or timeout: reported as not installed,
        // which the comparison treats as a deployment fact rather than drift.
        return [cli, null] as const;
      }
    })
  );
  return Object.fromEntries(entries) as InstalledVersionMap;
}

/** Env var that disables the check entirely. */
export const STARTUP_VERSION_CHECK_DISABLE_ENV = "LLM_GATEWAY_DISABLE_STARTUP_VERSION_CHECK";

/**
 * Whether the startup check should run.
 *
 * Enabled by default: the whole point is that drift was going unnoticed, so
 * an opt-in check would mostly stay off. The kill switch exists for
 * environments where seven extra spawns per start are unwelcome.
 *
 * @param env Process environment.
 * @returns Whether to run the check.
 */
export function startupVersionCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[STARTUP_VERSION_CHECK_DISABLE_ENV] ?? "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

/**
 * Compare installed provider versions to their contracts and log any drift.
 *
 * Swallows every error: a diagnostic must never be able to take down a
 * gateway that is otherwise serving fine.
 *
 * @param logger Gateway logger (stderr).
 * @param deps.getVersions Injectable version collector, for tests.
 * @param deps.env Injectable environment, for tests.
 * @returns The drifted providers, empty when clean or skipped.
 */
export async function runStartupVersionCheck(
  logger: Logger,
  deps: {
    collectVersions?: () => Promise<InstalledVersionMap>;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CliType[]> {
  const env = deps.env ?? process.env;
  if (!startupVersionCheckEnabled(env)) return [];

  // Yield once before doing anything, so even the setup cost lands after the
  // caller has returned. `void`-ing an async function does not on its own get
  // you off the hot path; only an actual suspension point does.
  await new Promise(resolve => setImmediate(resolve));

  try {
    const installed = await (deps.collectVersions ?? collectInstalledVersionsAsync)();
    const summary = summarizeVersionGuard(compareInstalledToTargets(installed));
    if (summary.ok) return [];

    // One line naming the providers, then one line each with the specifics, so
    // the headline is greppable and the detail is actionable.
    logger.error(
      `Provider CLI version drift detected (${summary.drifted.join(", ")}): the declared flags and subcommands for these providers may no longer match what the installed binary advertises.`
    );
    for (const verdict of summary.verdicts) {
      if (verdict.state === "drift") logger.error(`  ${verdict.detail}`);
    }
    logger.error(
      "  Run the provider_version_guard tool, or `llm-cli-gateway contracts --json --probe-installed`, to confirm which surfaces changed."
    );
    return summary.drifted;
  } catch (err) {
    logger.debug?.(
      `Startup provider version check failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
