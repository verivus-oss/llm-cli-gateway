/**
 * "Is a newer provider CLI published?" probing.
 *
 * The gateway could already report the installed version and could already run
 * an upgrade (`cli_upgrade` / `buildCliUpgradePlan`), but nothing ever checked
 * whether an upgrade EXISTED, so the upgrade path only ran when a human
 * happened to suspect it. This module supplies that missing middle step.
 *
 * Only four of the seven providers can be asked safely. That is a property of
 * the vendor CLIs, not an omission here, and the unavailable ones report
 * `unknown` rather than a guess:
 *
 *   provider  source                                       safe read-only?
 *   claude    npm @anthropic-ai/claude-code                yes
 *   codex     npm @openai/codex                            yes
 *   mistral   PyPI mistral-vibe                            yes
 *   grok      `grok update --check`                        yes
 *   devin     `devin update` CHECKS AND OPTIONALLY INSTALLS  no
 *   cursor    `cursor-agent update` only installs          no
 *   gemini    no documented read-only check                no
 *
 * Deliberately NOT using `fetch`: the release audit fails the build on a
 * literal "fetch" anywhere in shipped dist sources (a Socket networkAccess
 * heuristic), so registry reads go through node:https like src/api-http.ts.
 */
import { request as httpsRequest } from "node:https";
import { executeCli, providerCommandName } from "./executor.js";
import { CLI_TYPES, type CliType } from "./provider-types.js";
import { normalizeProviderVersion, versionsMatch } from "./provider-version-guard.js";

/** How a provider's latest published version can be discovered, if at all. */
export type UpgradeProbeSource = "npm" | "pypi" | "cli-check" | "none";

/** Outcome of an availability probe for one provider. */
export type UpgradeAvailabilityState =
  "current" | "upgrade-available" | "unknown" | "not-installed";

export interface UpgradeAvailability {
  cli: CliType;
  state: UpgradeAvailabilityState;
  source: UpgradeProbeSource;
  installed: string | null;
  /** Latest published version when discoverable, else null. */
  latest: string | null;
  detail: string;
}

interface ProbeDescriptor {
  source: UpgradeProbeSource;
  /** npm package name or PyPI project name, when applicable. */
  pkg?: string;
  /** Why this provider cannot be probed, when source is "none". */
  reason?: string;
}

/**
 * Per-provider probe strategy.
 *
 * Keyed on CLI_TYPES so a new provider cannot be added without deciding how
 * (or whether) its upgrades can be discovered.
 */
export const UPGRADE_PROBES: Record<CliType, ProbeDescriptor> = {
  claude: { source: "npm", pkg: "@anthropic-ai/claude-code" },
  codex: { source: "npm", pkg: "@openai/codex" },
  gemini: {
    source: "none",
    reason: "Antigravity publishes no read-only version check; `agy update` is install-only.",
  },
  grok: { source: "cli-check" },
  mistral: { source: "pypi", pkg: "mistral-vibe" },
  devin: {
    source: "none",
    reason: "`devin update` checks AND optionally installs, so it is not safe to run as a probe.",
  },
  cursor: {
    source: "none",
    reason: "`cursor-agent update` installs directly; there is no check-only mode.",
  },
};

/**
 * Read a JSON document over HTTPS with a hard timeout.
 *
 * @param url Absolute https URL.
 * @param timeoutMs Abort after this long.
 * @returns Parsed JSON, or null on any failure (never throws).
 */
async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = httpsRequest(
        url,
        { method: "GET", headers: { accept: "application/json" }, timeout: timeoutMs },
        res => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            done(null);
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", chunk => {
            // Registry documents are small; cap anyway so a hostile or broken
            // endpoint cannot grow this unbounded.
            if (body.length < 2_000_000) body += chunk;
          });
          res.on("end", () => {
            try {
              done(JSON.parse(body));
            } catch {
              done(null);
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        done(null);
      });
      req.on("error", () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

/**
 * Latest version published to the npm registry.
 *
 * Uses the per-version endpoint, which returns a small document, rather than
 * the full packument.
 *
 * @param pkg Package name.
 * @param timeoutMs Request timeout.
 * @returns Version string or null.
 */
export async function latestFromNpm(pkg: string, timeoutMs: number): Promise<string | null> {
  const doc = await getJson(
    `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
    timeoutMs
  );
  const version = (doc as { version?: unknown } | null)?.version;
  return typeof version === "string" ? version : null;
}

/**
 * Latest version published to PyPI.
 *
 * @param project PyPI project name.
 * @param timeoutMs Request timeout.
 * @returns Version string or null.
 */
export async function latestFromPyPi(project: string, timeoutMs: number): Promise<string | null> {
  const doc = await getJson(`https://pypi.org/pypi/${encodeURIComponent(project)}/json`, timeoutMs);
  const version = (doc as { info?: { version?: unknown } } | null)?.info?.version;
  return typeof version === "string" ? version : null;
}

/**
 * Pull a version out of a CLI's own update-check output.
 *
 * Vendor wording varies and is not a stable contract, so this only reports a
 * version it can actually see; ambiguous output yields null and the caller
 * reports `unknown` rather than inventing a verdict.
 *
 * @param text Combined stdout/stderr of the check command.
 * @returns Version string or null.
 */
export function parseCliCheckVersion(text: string): string | null {
  // `grok update --check` on 0.2.112 prints:
  //   Grok Build - v0.2.112 (latest: 0.2.112) [stable]
  // so a bare "latest:" label with no following word "version" must parse.
  const labelledColon = text.match(/\blatest\s*:\s*v?(\d+\.\d+\.\d+[0-9A-Za-z._-]*)/i);
  if (labelledColon) return labelledColon[1];

  const labelled = text.match(
    /(?:latest|available|new)\s+version[^0-9]{0,20}v?(\d+\.\d+\.\d+[0-9A-Za-z._-]*)/i
  );
  if (labelled) return labelled[1];

  const upgradeTo = text.match(/(?:->|→|to)\s+v?(\d+\.\d+\.\d+[0-9A-Za-z._-]*)/);
  if (upgradeTo) return upgradeTo[1];
  return null;
}

/**
 * Read the latest version out of a CLI's structured update-check output.
 *
 * Preferred over `parseCliCheckVersion`, which scrapes a human-readable
 * banner and is therefore hostage to vendor copy changes.
 *
 * @param stdout Raw stdout from `<cli> update --check --json`.
 * @returns Latest version string, or null when absent or unparseable.
 */
export function parseCliCheckJson(stdout: string): string | null {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const doc = JSON.parse(trimmed) as { latestVersion?: unknown };
    return typeof doc.latestVersion === "string" && doc.latestVersion ? doc.latestVersion : null;
  } catch {
    return null;
  }
}

/** Phrases that mean "you are already on the newest release". */
const UP_TO_DATE = /\b(up[\s-]?to[\s-]?date|already (?:the )?latest|no updates? available)\b/i;

/**
 * Check whether a newer version of each provider CLI is published.
 *
 * Network and subprocess work is opt-in via `enabled`; with it false every
 * provider reports `unknown` and nothing is spawned or fetched. Failures are
 * always `unknown`, never a false "current", because reporting "you are up to
 * date" off the back of a failed probe is the one answer that could hide a
 * needed upgrade.
 *
 * @param params.installed Reported installed version per provider.
 * @param params.enabled Whether to perform network/subprocess probes.
 * @param params.timeoutMs Per-probe timeout.
 * @param params.only Restrict to a single provider.
 * @returns One availability record per provider, in registry order.
 */
export async function checkUpgradeAvailability(params: {
  installed: Partial<Record<CliType, string | null | undefined>>;
  enabled: boolean;
  timeoutMs?: number;
  only?: CliType;
}): Promise<UpgradeAvailability[]> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const targets = params.only ? [params.only] : [...CLI_TYPES];

  return Promise.all(
    targets.map(async cli => {
      const probe = UPGRADE_PROBES[cli];
      const installed = params.installed[cli] ?? null;

      if (!installed) {
        return {
          cli,
          state: "not-installed" as const,
          source: probe.source,
          installed: null,
          latest: null,
          detail: `${cli}: not installed`,
        };
      }

      if (!params.enabled) {
        return {
          cli,
          state: "unknown" as const,
          source: probe.source,
          installed,
          latest: null,
          detail: `${cli}: upgrade check not run (probing disabled)`,
        };
      }

      if (probe.source === "none") {
        return {
          cli,
          state: "unknown" as const,
          source: probe.source,
          installed,
          latest: null,
          detail: `${cli}: no safe read-only upgrade check. ${probe.reason ?? ""}`.trim(),
        };
      }

      let latest: string | null = null;
      let sawUpToDate = false;

      if (probe.source === "npm" && probe.pkg) {
        latest = await latestFromNpm(probe.pkg, timeoutMs);
      } else if (probe.source === "pypi" && probe.pkg) {
        latest = await latestFromPyPi(probe.pkg, timeoutMs);
      } else if (probe.source === "cli-check") {
        try {
          // Prefer the structured form. grok 0.2.112 answers
          // `update --check --json` with
          //   {"currentVersion":"…","latestVersion":"…","updateAvailable":false,…}
          // which is a contract rather than prose, so it cannot be broken by a
          // reworded banner the way the text parser can.
          const jsonResult = await executeCli(
            providerCommandName(cli),
            ["update", "--check", "--json"],
            { timeout: timeoutMs }
          );
          latest = parseCliCheckJson(`${jsonResult.stdout ?? ""}`);

          if (!latest) {
            // Fall back to the human-readable banner for CLIs or versions that
            // do not support --json.
            const result = await executeCli(providerCommandName(cli), ["update", "--check"], {
              timeout: timeoutMs,
            });
            const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
            sawUpToDate = UP_TO_DATE.test(text);
            latest = parseCliCheckVersion(text);
          }
        } catch {
          latest = null;
        }
      }

      if (!latest) {
        if (sawUpToDate) {
          return {
            cli,
            state: "current" as const,
            source: probe.source,
            installed,
            latest: null,
            detail: `${cli}: reports it is up to date`,
          };
        }
        return {
          cli,
          state: "unknown" as const,
          source: probe.source,
          installed,
          latest: null,
          detail: `${cli}: upgrade check produced no usable version`,
        };
      }

      const same = versionsMatch(installed, latest);
      return {
        cli,
        state: same ? ("current" as const) : ("upgrade-available" as const),
        source: probe.source,
        installed,
        latest,
        detail: same
          ? `${cli}: ${normalizeProviderVersion(installed).version} is the latest published version`
          : `${cli}: ${normalizeProviderVersion(installed).version} installed, ${normalizeProviderVersion(latest).version} published`,
      };
    })
  );
}

/** Providers with a newer published version, for a headline. */
export function upgradableProviders(results: UpgradeAvailability[]): CliType[] {
  return results.filter(r => r.state === "upgrade-available").map(r => r.cli);
}
