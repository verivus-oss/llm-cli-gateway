/**
 * Installed-versus-contracted provider version comparison.
 *
 * The gateway already knew both halves of this and never put them together:
 * `doctor` emits `installed_versions` and the full contract in one document
 * with `probed: false` and a string telling a human to go run the probe.
 * `PROVIDER_TARGET_VERSIONS` was imported only by the contract and capability
 * modules, never by the version reporter. So a provider CLI could move
 * underneath its contract and nothing noticed until `pre-release.sh` ran the
 * one gate that actually probes binaries. That is how grok 0.2.112 dropped
 * `--best-of-n` and `--check` while the gateway kept emitting them.
 *
 * This module supplies the missing comparison. It is deliberately pure and
 * offline: callers pass in the versions they already collected.
 */
import { CLI_TYPES, type CliType } from "./provider-types.js";
import { PROVIDER_TARGET_VERSIONS } from "./provider-definitions.js";

/**
 * A provider version, split into the parts that carry meaning.
 *
 * Raw strings are NOT comparable across sources. The same CLI is reported
 * differently depending on who asked:
 *
 *   provider           doctor / `--version`            PROVIDER_TARGET_VERSIONS
 *   gemini             "1.1.7"                         "agy 1.1.7"
 *   cursor             "2026.07.23-e383d2b"            "cursor-agent 2026.07.23-e383d2b"
 *   claude             "2.1.220 (Claude Code)"         "claude 2.1.220"
 *   grok               "grok 0.2.112 (9bbd559437)"     "grok 0.2.112 (9bbd559437)"
 *
 * A naive string equality check reports drift on gemini, cursor and claude
 * while all three are in fact correct, so the normalizer is load-bearing: it
 * is the difference between a useful signal and one everybody learns to ignore.
 */
export interface NormalizedVersion {
  /** Version core, e.g. "0.2.112" or "2026.07.23-e383d2b". */
  version: string;
  /** Build/commit id when the CLI advertises one, e.g. "9bbd559437". */
  build?: string;
  /** Whatever was passed in, retained for reporting. */
  raw: string;
}

/**
 * Product-name prefixes CLIs and contracts put in front of the version.
 *
 * Several entries are prefixes of others (`codex` of `codex-cli`, `cursor` of
 * `cursor-agent`, `claude` of `claude code`, `mistral` of `mistral-vibe`), so
 * matching must always try the LONGEST first or `"codex-cli 0.145.0"` reduces
 * to `"-cli 0.145.0"`. `stripProductPrefix` enforces that regardless of the
 * order here, so this list can be reordered safely.
 */
export const PRODUCT_PREFIXES = [
  "claude code",
  "claude",
  "codex-cli",
  "codex",
  "cursor-agent",
  "cursor",
  "devin",
  "grok",
  "vibe",
  "mistral-vibe",
  "mistral",
  "agy",
  "antigravity",
  "gemini",
];

/**
 * Remove a leading product name from a version string.
 *
 * Always tries the LONGEST candidate first, independent of the order of
 * `prefixes`, because several entries are prefixes of others. Taking them in
 * declaration order happens to work today and would break silently the moment
 * the list is sorted alphabetically, so the guarantee lives here rather than
 * in the list's ordering.
 *
 * @param text Version string, possibly prefixed with a product name.
 * @param prefixes Candidate product names; defaults to PRODUCT_PREFIXES.
 * @returns `text` with one leading product name removed, trimmed.
 */
export function stripProductPrefix(text: string, prefixes: string[] = PRODUCT_PREFIXES): string {
  const lower = text.toLowerCase();
  let best = "";
  for (const prefix of prefixes) {
    if (lower.startsWith(`${prefix.toLowerCase()} `) && prefix.length > best.length) best = prefix;
  }
  return best ? text.slice(best.length).trim() : text;
}

/**
 * Reduce a version string from any source to comparable parts.
 *
 * Strips a leading product name, a leading `v`, and a trailing parenthesised
 * suffix, keeping a parenthesised build id separately when there is one.
 * `"2.1.220 (Claude Code)"` and `"claude 2.1.220"` both reduce to `2.1.220`;
 * `"grok 0.2.112 (9bbd559437)"` reduces to `0.2.112` + build `9bbd559437`.
 *
 * @param raw Version string as reported by a CLI or declared in a contract.
 * @returns Normalized parts; `version` is "" when nothing version-like is found.
 */
export function normalizeProviderVersion(raw: string | null | undefined): NormalizedVersion {
  const original = (raw ?? "").trim();
  if (!original) return { version: "", raw: original };

  let text = original;

  // Pull out a parenthesised group: either a build id or a product name.
  //
  // Deliberately NOT anchored to end-of-string. grok 1.0.4 reports
  // `grok 1.0.4 (d846eb93d9) [stable]`, putting a release-channel marker AFTER
  // the hash, and an end-anchored match found nothing and dropped the build id.
  // That mattered because `comparableVersion` in scripts/upstream-scan.mjs
  // reads the hash from anywhere in the banner, so the two disagreed about the
  // same string: `providers:rebaseline --apply` wrote a hash-less
  // `grok 1.0.4` target that the drift scan then reported as mismatched
  // forever. One banner must not have two readings.
  //
  // Scan every group. A build id looks like a hash or a version; a product name
  // has spaces or is plainly a word we know.
  //
  // Hash-shaped groups are preferred across ALL groups before the looser
  // digit-leading fallback is considered, rather than taking the first group
  // that satisfies either test. Taking the first either-way match reintroduces
  // the bug this function is being fixed for, one shape along: a banner like
  // `grok 1.0.4 (2026 xAI) (d846eb93d9)` has digit-leading prose BEFORE the
  // real hash, so a first-match loop keeps "2026 xAI", and versionsMatch then
  // compares that against a contracted `d846eb93d9` and reports drift on a
  // correct install. No shipped banner has that shape today; the end-anchored
  // version it replaced happened to be immune because it only ever looked last.
  // Bracketed markers are stripped from the version text alongside, being
  // neither a build id nor part of the version.
  const groups = Array.from(text.matchAll(/\(([^)]*)\)/g), match => match[1].trim());
  const build: string | undefined =
    groups.find(inner => /^[0-9a-f]{6,40}$/i.test(inner)) ??
    groups.find(inner => /^\d/.test(inner));
  text = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .trim();

  text = stripProductPrefix(text)
    .replace(/^v(?=\d)/i, "")
    .trim();

  // Take the first version-like token; ignore trailing prose.
  const token = text.match(/^[0-9][0-9A-Za-z._-]*/);
  return { version: token ? token[0] : "", build, raw: original };
}

/**
 * True when two version strings describe the same release.
 *
 * Build ids are compared only when BOTH sides carry one: the contract pins
 * `grok 0.2.112 (9bbd559437)` while a caller may only have `0.2.112`, and
 * refusing to match there would report drift on a correct install.
 *
 * @param a First version string.
 * @param b Second version string.
 * @returns Whether they refer to the same release.
 */
export function versionsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeProviderVersion(a);
  const right = normalizeProviderVersion(b);
  if (!left.version || !right.version) return false;
  if (left.version !== right.version) return false;
  if (left.build && right.build) return left.build === right.build;
  return true;
}

/** Verdict for one provider's installed version against its contract. */
export type VersionGuardState = "match" | "drift" | "not-installed" | "unknown";

export interface ProviderVersionVerdict {
  cli: CliType;
  state: VersionGuardState;
  /** Raw installed version as reported, null when the CLI is absent. */
  installed: string | null;
  /** Raw contracted target from PROVIDER_TARGET_VERSIONS. */
  target: string;
  installedNormalized: string;
  targetNormalized: string;
  /** Operator-facing one-liner. */
  detail: string;
}

/**
 * Compare each provider's installed version against its contracted target.
 *
 * @param installed Map of provider to reported version; a missing or null
 *   entry means the CLI was not found.
 * @returns One verdict per member of CLI_TYPES, in registry order.
 */
export function compareInstalledToTargets(
  installed: Partial<Record<CliType, string | null | undefined>>
): ProviderVersionVerdict[] {
  return CLI_TYPES.map(cli => {
    const target = PROVIDER_TARGET_VERSIONS[cli];
    const raw = installed[cli] ?? null;
    const installedNorm = normalizeProviderVersion(raw);
    const targetNorm = normalizeProviderVersion(target);

    if (raw === null || raw === undefined || raw === "") {
      return {
        cli,
        state: "not-installed" as const,
        installed: null,
        target,
        installedNormalized: "",
        targetNormalized: targetNorm.version,
        detail: `${cli}: not installed; contract expects ${target}`,
      };
    }

    if (!installedNorm.version) {
      return {
        cli,
        state: "unknown" as const,
        installed: raw,
        target,
        installedNormalized: "",
        targetNormalized: targetNorm.version,
        detail: `${cli}: could not parse a version from ${JSON.stringify(raw)}; contract expects ${target}`,
      };
    }

    const match = versionsMatch(raw, target);
    return {
      cli,
      state: match ? ("match" as const) : ("drift" as const),
      installed: raw,
      target,
      installedNormalized: installedNorm.version,
      targetNormalized: targetNorm.version,
      detail: match
        ? `${cli}: ${installedNorm.version} matches contract`
        : `${cli}: installed ${installedNorm.version} but contract expects ${targetNorm.version}; provider surfaces may have changed`,
    };
  });
}

/** Aggregate view over a set of verdicts. */
export interface VersionGuardSummary {
  ok: boolean;
  drifted: CliType[];
  notInstalled: CliType[];
  unknown: CliType[];
  verdicts: ProviderVersionVerdict[];
}

/**
 * Summarize verdicts for callers that only need a verdict and a headline.
 *
 * `ok` is false only for genuine drift. A provider that is simply not
 * installed is a deployment fact, not a contract violation, and must not make
 * a developer machine without all seven CLIs look broken.
 *
 * @param verdicts Per-provider verdicts.
 * @returns Aggregate summary.
 */
export function summarizeVersionGuard(verdicts: ProviderVersionVerdict[]): VersionGuardSummary {
  const drifted = verdicts.filter(v => v.state === "drift").map(v => v.cli);
  const notInstalled = verdicts.filter(v => v.state === "not-installed").map(v => v.cli);
  const unknown = verdicts.filter(v => v.state === "unknown").map(v => v.cli);
  return { ok: drifted.length === 0, drifted, notInstalled, unknown, verdicts };
}
