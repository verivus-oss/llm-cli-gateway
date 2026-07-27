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
import type { CliType } from "./provider-types.js";
import { getCliVersions } from "./cli-updater.js";
import { compareInstalledToTargets, summarizeVersionGuard } from "./provider-version-guard.js";

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
    getVersions?: typeof getCliVersions;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CliType[]> {
  const env = deps.env ?? process.env;
  if (!startupVersionCheckEnabled(env)) return [];

  try {
    const versions = await (deps.getVersions ?? getCliVersions)();
    const installed: Partial<Record<CliType, string | null>> = {};
    for (const info of versions) {
      installed[info.cli] = info.installed ? (info.version ?? null) : null;
    }

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
