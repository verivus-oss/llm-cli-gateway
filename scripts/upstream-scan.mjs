#!/usr/bin/env node
// Upstream provider contract scanner.
//
// Two responsibilities, one binary:
//
//   node scripts/upstream-scan.mjs --contracts-check
//       The blocking, offline, network-free gate. Re-runs the bundled
//       conformance fixtures through the EXISTING validators, rebuilds the
//       contract report, and verifies docs/upstream/provider-sources.dag.toml
//       stays in sync with the CliContract metadata. Exits non-zero on drift.
//       This is what `npm run upstream:contracts` calls.
//
//   node scripts/upstream-scan.mjs [--live] [--write-snapshot] [--write-report]
//       The changelog scanner. Default mode is side-effect-free and
//       network-free: it prints each provider's tracked sources + contract
//       surface from the report. Network changelog fetches happen ONLY with
//       --live; snapshots are written ONLY with --write-snapshot; reports ONLY
//       with --write-report. This is what `npm run upstream:scan` calls.
//
// DESIGN INVARIANT (matches the rejected-then-corrected review outcome):
// this script NEVER reimplements flag/output/session/permission validation. It
// reuses src/upstream-contracts.ts (compiled to dist/) as the single
// mechanical source of truth. The TOML is scanner input only and never drives
// contract enforcement.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DIST_CONTRACTS = join(REPO_ROOT, "dist", "upstream-contracts.js");
const DIST_EXECUTOR = join(REPO_ROOT, "dist", "executor.js");
const DIST_PROVIDER_DEFINITIONS = join(REPO_ROOT, "dist", "provider-definitions.js");
const TOML_PATH = join(REPO_ROOT, "docs", "upstream", "provider-sources.dag.toml");
const SNAPSHOT_DIR = join(REPO_ROOT, "docs", "upstream", "snapshots");
const REPORT_DIR = join(REPO_ROOT, "docs", "upstream", "reports");
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER = 1024 * 1024;

function parseArgs(argv) {
  const flags = {
    contractsCheck: false,
    live: false,
    writeSnapshot: false,
    writeReport: false,
    failOnCritical: false,
    provider: null,
    probeInstalled: false,
    requireInstalled: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--contracts-check") flags.contractsCheck = true;
    else if (a === "--live") flags.live = true;
    else if (a === "--write-snapshot") flags.writeSnapshot = true;
    else if (a === "--write-report") flags.writeReport = true;
    else if (a === "--fail-on-critical") flags.failOnCritical = true;
    else if (a === "--provider") flags.provider = argv[++i] ?? null;
    else if (a === "--probe-installed") flags.probeInstalled = true;
    else if (a === "--require-installed") {
      flags.requireInstalled = true;
      flags.probeInstalled = true;
    } else if (a === "--help" || a === "-h") flags.help = true;
    else {
      console.error(`[upstream-scan] unknown argument: ${a}`);
      flags.help = true;
    }
  }
  return flags;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/upstream-scan.mjs [options]",
      "",
      "  --contracts-check     Offline gate: fixtures + report + TOML-sync. No network, no writes.",
      "  --live                Fetch tracked changelog/release URLs (network).",
      "  --write-snapshot      Persist fetched source hashes and local probe surfaces under docs/upstream/snapshots/",
      "                        (requires --live or --probe-installed).",
      "  --write-report        Write a markdown report under docs/upstream/reports/YYYY-MM-DD-<provider>.md.",
      "  --fail-on-critical    Exit non-zero when a critical finding is present (advisory otherwise).",
      "  --provider <cli>      Limit to one CliType (claude|codex|gemini|grok|mistral|devin|cursor).",
      "  --probe-installed     Also run local --help probes and report bidirectional drift vs the contract",
      "                        (and vs prior snapshots when --write-snapshot is also used). A provider whose",
      "                        binary is absent is SKIPPED, not failed, so this alone exits 0 on a machine",
      "                        with no provider CLIs: convenient locally, useless as a gate.",
      "  --require-installed   Implies --probe-installed, and reports a critical finding for any provider",
      "                        whose binary is absent. Use this in a gate: --probe-installed alone reports",
      "                        no drift on a machine with no provider CLIs, which passes while verifying",
      "                        nothing.",
      "  -h, --help            Show this help.",
      "",
      "Default (no flags): offline, network-free summary of tracked sources + contract surface.",
    ].join("\n")
  );
}

async function loadMachinery() {
  if (
    !existsSync(DIST_CONTRACTS) ||
    !existsSync(DIST_EXECUTOR) ||
    !existsSync(DIST_PROVIDER_DEFINITIONS)
  ) {
    console.error(
      "[upstream-scan] compiled contract machinery not found. Run `npm run build` first " +
        "(the release gate runs `npm run check` before this)."
    );
    process.exit(2);
  }
  const [contracts, executor, providerDefinitions] = await Promise.all([
    import(DIST_CONTRACTS),
    import(DIST_EXECUTOR),
    import(DIST_PROVIDER_DEFINITIONS),
  ]);
  return { ...contracts, ...executor, ...providerDefinitions };
}

function loadToml() {
  if (!existsSync(TOML_PATH)) {
    console.error(`[upstream-scan] missing ${TOML_PATH}`);
    process.exit(2);
  }
  return parseToml(readFileSync(TOML_PATH, "utf8"));
}

function selectProviders(contracts, provider) {
  const all = Object.keys(contracts);
  if (!provider) return all;
  if (!all.includes(provider)) {
    console.error(`[upstream-scan] unknown provider "${provider}". Known: ${all.join(", ")}`);
    process.exit(2);
  }
  return [provider];
}

/**
 * Offline, deterministic gate. Reuses the existing validators and report —
 * does not reimplement any validation. Returns the number of failures.
 */
function runContractsCheck(machinery, toml) {
  const {
    UPSTREAM_CLI_CONTRACTS,
    ACP_ENTRYPOINT_CONTRACTS,
    flattenCliSubcommands,
    validateUpstreamCliArgs,
    validateUpstreamCliEnv,
    validateUpstreamCliSubcommandArgs,
  } = machinery;
  let failures = 0;

  // 1. Bundled conformance fixtures, run through the real validators.
  for (const [cli, contract] of Object.entries(UPSTREAM_CLI_CONTRACTS)) {
    for (const fixture of contract.conformanceFixtures) {
      const args = validateUpstreamCliArgs(contract.cli, fixture.args);
      const env = validateUpstreamCliEnv(contract.cli, fixture.env);
      const ok = args.ok && env.ok;
      const expected = fixture.expect === "pass";
      if (ok !== expected) {
        failures++;
        console.error(
          `[upstream-scan] FIXTURE FAIL ${cli}/${fixture.id}: expected ${fixture.expect}, got ${ok ? "pass" : "fail"}`
        );
      }
    }
    for (const subcommand of flattenCliSubcommands(contract.subcommands)) {
      for (const fixture of subcommand.conformanceFixtures) {
        const args = validateUpstreamCliSubcommandArgs(
          contract.cli,
          subcommand.commandPath,
          fixture.args
        );
        const env = validateUpstreamCliEnv(contract.cli, fixture.env);
        const ok = args.ok && env.ok;
        const expected = fixture.expect === "pass";
        if (ok !== expected) {
          failures++;
          console.error(
            `[upstream-scan] SUBCOMMAND FIXTURE FAIL ${cli}/${subcommand.commandPath.join(" ")}/${fixture.id}: expected ${fixture.expect}, got ${ok ? "pass" : "fail"}`
          );
        }
      }
    }
  }

  // 2. Report builds with the stable schema version.
  const report = machinery.buildUpstreamContractReport();
  if (report.schemaVersion !== "upstream-cli-contracts.v1") {
    failures++;
    console.error(`[upstream-scan] REPORT FAIL: unexpected schemaVersion ${report.schemaVersion}`);
  }

  // 2b. ACP entrypoint contracts exist for every provider and are mirrored in
  //     the report under a key distinct from request-tool data. This is
  //     offline and network-free — no provider process is spawned.
  const acpContracts = ACP_ENTRYPOINT_CONTRACTS ?? {};
  for (const cli of Object.keys(UPSTREAM_CLI_CONTRACTS)) {
    const acp = acpContracts[cli];
    if (!acp) {
      failures++;
      console.error(`[upstream-scan] ACP FAIL ${cli}: missing ACP entrypoint contract`);
      continue;
    }
    const reportAcp = report.contracts?.[cli]?.acpEntrypoint;
    if (!reportAcp || reportAcp.status !== acp.status) {
      failures++;
      console.error(
        `[upstream-scan] ACP FAIL ${cli}: report acpEntrypoint missing or status drift (contract=${acp.status}, report=${reportAcp?.status ?? "—"})`
      );
    }
    // Native providers must declare a safe non-server probe; adapter/absent
    // providers must NOT (there is no safe native probe to run).
    const hasProbe = (acp.probeArgs ?? []).length > 0;
    if (acp.status === "native" && !hasProbe) {
      failures++;
      console.error(
        `[upstream-scan] ACP FAIL ${cli}: native entrypoint declares no read-only probe`
      );
    }
    if (acp.status !== "native" && hasProbe) {
      failures++;
      console.error(
        `[upstream-scan] ACP FAIL ${cli}: non-native entrypoint (${acp.status}) must not declare a live probe`
      );
    }
  }

  // 3. TOML scanner input stays in sync with the CliContract metadata.
  //    The TypeScript metadata is authoritative; the TOML mirrors it. Any
  //    drift here means someone edited one side without the other.
  const tomlProviders = toml.providers ?? {};
  for (const [cli, contract] of Object.entries(UPSTREAM_CLI_CONTRACTS)) {
    const meta = contract.upstreamMetadata;
    const block = tomlProviders[cli];
    if (!meta) {
      failures++;
      console.error(`[upstream-scan] SYNC FAIL ${cli}: CliContract has no upstreamMetadata`);
      continue;
    }
    if (!block) {
      failures++;
      console.error(`[upstream-scan] SYNC FAIL ${cli}: missing [providers.${cli}] in TOML`);
      continue;
    }
    if (!arraysEqual(block.source_urls, meta.sourceUrls)) {
      failures++;
      console.error(
        `[upstream-scan] SYNC FAIL ${cli}: source_urls drift\n  TOML: ${JSON.stringify(block.source_urls)}\n  TS:   ${JSON.stringify(meta.sourceUrls)}`
      );
    }
    if (!arraysEqual(block.watch_categories, meta.watchCategories)) {
      failures++;
      console.error(
        `[upstream-scan] SYNC FAIL ${cli}: watch_categories drift\n  TOML: ${JSON.stringify(block.watch_categories)}\n  TS:   ${JSON.stringify(meta.watchCategories)}`
      );
    }
  }

  if (failures === 0) {
    const n = Object.keys(UPSTREAM_CLI_CONTRACTS).length;
    console.log(
      `[upstream-scan] contracts-check OK: ${n} providers, fixtures + report + TOML-sync verified (offline).`
    );
  }
  return failures;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const CODEX_CHANGELOG_RSS_URL = "https://learn.chatgpt.com/docs/changelog/rss.xml";
const CODEX_RSS_APP_OR_MOBILE_GUID = /-(?:app|mobile)$/iu;
const CODEX_RSS_APP_OR_MOBILE_LINK =
  /(?:\/codex\/(?:app|mobile)(?:[/?#]|$)|#(?:[^#]*-)?(?:app|mobile)(?:[/?#]|$))/iu;
const CODEX_RSS_APP_OR_MOBILE_TITLE =
  /\b(?:codex\s+(?:app|mobile)|chatgpt\s+for\s+(?:ios|android))\b/iu;
const CODEX_RSS_WATCHED_CONCEPT =
  /\b(?:exec|resume|review|mcp|login|logout|sandbox|cloud|fork|apply|archive|unarchive|delete|update|doctor|features|plugin|app-server|mcp-server|approvals?|permissions?|sessions?|output\s+schema|web\s+search|config(?:\.toml)?)\b/iu;
const CODEX_RSS_CLI_NAME = /\bcodex\s+cli\b/iu;
const CODEX_RSS_LONG_FLAG = /--[a-z][a-z0-9-]*/iu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodeRssText(value) {
  const entities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/giu, (_, name) => entities[name.toLowerCase()]);
}

function normalizeRssText(value) {
  return decodeRssText(value)
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function rssTag(item, name) {
  const escapedName = escapeRegExp(name);
  const match = new RegExp(
    `<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`,
    "iu"
  ).exec(item);
  return normalizeRssText(match?.[1] ?? "");
}

function hasCodexCliCodeInvocation(value) {
  const fragments = [
    ...value.matchAll(/```[^\n]*\n?([\s\S]*?)```/gu),
    ...value.matchAll(/`([^`\n]+)`/gu),
  ];
  return fragments.some(fragment =>
    /\bcodex\s+(?:--[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)\b/iu.test(fragment[1])
  );
}

function isCodexRssAppOrMobileEntry(guid, title, link) {
  return (
    CODEX_RSS_APP_OR_MOBILE_GUID.test(guid) ||
    CODEX_RSS_APP_OR_MOBILE_GUID.test(link) ||
    CODEX_RSS_APP_OR_MOBILE_LINK.test(link) ||
    CODEX_RSS_APP_OR_MOBILE_TITLE.test(title)
  );
}

/**
 * The Codex RSS feed contains broad app and mobile product news, as well as
 * CLI release notes. Its channel metadata, item ordering, and app/mobile
 * entries change routinely. Preserve only CLI anchors and non-app/mobile
 * entries that mention watched contract concepts. App/mobile classification
 * uses stable GUIDs plus title/link cues, and selected entries are keyed by
 * their stable RSS GUID.
 */
export function codexChangelogRssSemanticSnapshot(url, body) {
  if (url !== CODEX_CHANGELOG_RSS_URL) return null;

  const entries = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)]
    .map(match => {
      const item = match[1];
      const rawContent =
        rssTag(item, "content:encoded") || rssTag(item, "description") || rssTag(item, "title");
      const title = rssTag(item, "title");
      const link = rssTag(item, "link");
      const guid = rssTag(item, "guid") || link || title;
      const text = `${title}\n${rawContent}`;
      const explicitCli =
        CODEX_RSS_CLI_NAME.test(text) ||
        CODEX_RSS_LONG_FLAG.test(text) ||
        hasCodexCliCodeInvocation(rawContent);
      const appOrMobile = isCodexRssAppOrMobileEntry(guid, title, link);
      const watched = CODEX_RSS_WATCHED_CONCEPT.test(text);
      if (!explicitCli && (appOrMobile || !watched)) return null;
      return {
        guid,
        title,
        contentSha256: sha256(rawContent),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.guid.localeCompare(b.guid) || a.title.localeCompare(b.title));

  const fields = { entries };
  return {
    kind: "codex-changelog-rss.v1",
    sha256: sha256(JSON.stringify(fields)),
    fields,
  };
}

/**
 * GitHub's release API includes mutable transport metadata such as `updated_at`
 * and asset download counts. Track release semantics instead of treating that
 * metadata churn as a new upstream CLI release.
 */
export function githubReleaseSemanticSnapshot(url, body) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (
    parsedUrl.hostname !== "api.github.com" ||
    !/^\/repos\/[^/]+\/[^/]+\/releases\/(?:latest|\d+)$/u.test(parsedUrl.pathname)
  ) {
    return null;
  }

  try {
    const release = JSON.parse(body);
    if (!release || typeof release !== "object" || Array.isArray(release)) return null;
    const fields = {
      tagName: release.tag_name ?? null,
      name: release.name ?? null,
      draft: release.draft === true,
      prerelease: release.prerelease === true,
      publishedAt: release.published_at ?? null,
      targetCommitish: release.target_commitish ?? null,
      bodySha256: sha256(typeof release.body === "string" ? release.body : ""),
    };
    return {
      kind: "github-release.v1",
      sha256: sha256(JSON.stringify(fields)),
      fields,
    };
  } catch {
    return null;
  }
}

/**
 * Prefer a source-specific semantic comparison whenever the current source
 * supports one. Existing raw-hash snapshots are migrated silently on their
 * next write, because no historical semantic fingerprint can be reconstructed
 * from a hash.
 */
export function compareSourceSnapshot(before, current) {
  if (!before) return { changed: false, comparison: "initial" };

  const beforeSemantic = before.semantic;
  const currentSemantic = current.semantic;
  if (currentSemantic) {
    if (beforeSemantic?.sha256) {
      return {
        changed: beforeSemantic.sha256 !== currentSemantic.sha256,
        comparison: "semantic",
        beforeHash: beforeSemantic.sha256,
        currentHash: currentSemantic.sha256,
      };
    }
    return { changed: false, comparison: "semantic-baseline-initialized" };
  }

  if (!before.sha256 || !current.sha256) return { changed: false, comparison: "unavailable" };
  return {
    changed: before.sha256 !== current.sha256,
    comparison: "raw",
    beforeHash: before.sha256,
    currentHash: current.sha256,
  };
}

async function fetchSource(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "llm-cli-gateway-upstream-scan" },
    });
    const body = await res.text();
    return {
      url,
      ok: res.ok,
      status: res.status,
      bytes: body.length,
      sha256: sha256(body),
      semantic:
        githubReleaseSemanticSnapshot(url, body) ?? codexChangelogRssSemanticSnapshot(url, body),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      bytes: 0,
      sha256: null,
      semantic: null,
      error: String(err?.message ?? err),
    };
  }
}

function normalizedDiscoveredFlags(surface) {
  if (!surface || typeof surface !== "object") return [];
  if (Array.isArray(surface.discoveredFlags)) return surface.discoveredFlags;
  if (Array.isArray(surface.flags)) return surface.flags;
  return [];
}

function normalizeHelpSurface(surface) {
  if (!surface || typeof surface !== "object") return surface;
  const rest = { ...surface };
  delete rest.flags;
  return {
    ...rest,
    discoveredFlags: normalizedDiscoveredFlags(surface),
  };
}

/**
 * Preserve compatibility with snapshots written before `discoveredFlags` was
 * made canonical. Readers always see one stable representation; writers emit
 * the canonical name below.
 */
export function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const subcommands = Object.fromEntries(
    Object.entries(snapshot.subcommands ?? {}).map(([path, surface]) => [
      path,
      normalizeHelpSurface(surface),
    ])
  );
  return {
    ...snapshot,
    helpSurface: normalizeHelpSurface(snapshot.helpSurface),
    subcommands,
  };
}

function readSnapshot(cli) {
  const path = join(SNAPSHOT_DIR, `${cli}.json`);
  if (!existsSync(path)) return null;
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeSnapshot(cli, payload) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const path = join(SNAPSHOT_DIR, `${cli}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o644 });
  return path;
}

/**
 * Compose a new snapshot without discarding evidence that this scan did not
 * refresh. This is deliberately pure so the migration behavior is testable.
 */
export function mergeSourceSnapshotBaselines(fetched, priorSources) {
  if (!fetched) return priorSources ?? [];
  const priorByUrl = new Map((priorSources ?? []).map(source => [source.url, source]));
  return fetched.map(source => {
    const prior = priorByUrl.get(source.url);
    // Keep the last known-good source evidence when a transient network error
    // occurs. The scan still emits source-unreachable for the failed attempt.
    const priorIsGood = prior?.ok !== false && Boolean(prior?.sha256);
    return source.ok || !priorIsGood ? source : prior;
  });
}

export function buildSnapshotPayload(cli, fetched, priorSnapshot, helpProbe) {
  const prior = normalizeSnapshot(priorSnapshot);
  const snapshotPayload = {
    schemaVersion: "upstream-scan-snapshot.v2",
    cli,
    fetchedAt: new Date().toISOString(),
    // A help-only refresh must never erase the last live source baseline.
    // Conversely, a source-only refresh preserves the last help evidence.
    sources: mergeSourceSnapshotBaselines(fetched, prior?.sources),
  };

  if (helpProbe?.available) {
    snapshotPayload.helpSurface = {
      probedAt: helpProbe.probedAt,
      available: true,
      version: helpProbe.versionProbe?.installedVersion ?? null,
      targetVersion: helpProbe.versionProbe?.targetVersion ?? null,
      versionMatchesTarget: helpProbe.versionProbe?.matches ?? null,
      discoveredFlags: helpProbe.discoveredFlags || [],
      helpHash: helpProbe.helpHash || null,
      extraVsContract: helpProbe.extraFlags || [],
      missingFromBinary: helpProbe.missingFlags || [],
      arityMismatches: helpProbe.arityMismatches || [],
      enumMismatches: helpProbe.enumMismatches || [],
    };
    snapshotPayload.rootCommands = helpProbe.rootCommands || [];
    snapshotPayload.subcommands = Object.fromEntries(
      Object.entries(helpProbe.subcommands || {}).map(([path, sub]) => [
        path,
        {
          commandPath: sub.commandPath,
          probedAt: sub.probedAt,
          available: sub.available,
          existence: sub.existence,
          discoveredFlags: sub.discoveredFlags || [],
          helpHash: sub.helpHash || null,
          extraVsContract: sub.extraFlags || [],
          missingFromBinary: sub.missingFlags || [],
          arityMismatches: sub.arityMismatches || [],
          enumMismatches: sub.enumMismatches || [],
          risk: sub.risk,
          exposure: sub.exposure,
          tier: sub.tier,
          summary: sub.summary,
        },
      ])
    );
  } else {
    if (prior?.helpSurface) snapshotPayload.helpSurface = prior.helpSurface;
    if (Array.isArray(prior?.rootCommands)) snapshotPayload.rootCommands = prior.rootCommands;
    if (prior?.subcommands) snapshotPayload.subcommands = prior.subcommands;
  }

  return snapshotPayload;
}

/** Extract command names and pipe-delimited aliases from a CLI help command section. */
export function extractRootCommands(helpText) {
  const commands = new Set();
  let inCommandSection = false;
  let commandIndent = null;

  for (const line of helpText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^(?:available\s+)?(?:commands|subcommands):$/iu.test(trimmed)) {
      inCommandSection = true;
      commandIndent = null;
      continue;
    }
    if (!inCommandSection) continue;
    if (/^[A-Za-z][A-Za-z0-9 /_-]*:$/u.test(line)) break;
    if (trimmed.length === 0) continue;

    const match =
      /^(\s+)([A-Za-z0-9][A-Za-z0-9_-]*(?:\|[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s|\[|$)/u.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    commandIndent ??= indent;
    if (indent !== commandIndent) continue;
    for (const command of match[2].split("|")) commands.add(command);
  }

  return [...commands].sort();
}

function normalizeLongFlag(flag) {
  return `--${flag.slice(2).toLowerCase().replace(/_/g, "-")}`;
}

function inferFlagArity(header) {
  if (/<[^>]*\.\.\.[^>]*>/u.test(header) || /\[[^\]]*\.\.\.[^\]]*\]/u.test(header)) {
    return "variadic";
  }
  if (/\[[^\]]*(?:<[^>]+>|[A-Za-z][A-Za-z0-9_-]*)[^\]]*\]/u.test(header)) {
    return "optional";
  }
  if (
    /<[^>]+>/u.test(header) ||
    /\{[^{}]+\}/u.test(header) ||
    /\s[A-Z][A-Z0-9_-]*(?:\.\.\.)?$/u.test(header)
  ) {
    return "one";
  }
  // A bare flag may be a boolean, but some CLIs omit an otherwise required
  // placeholder. Do not guess and create an arity finding from that ambiguity.
  return null;
}

function enumValues(valueText) {
  const quoted = [...valueText.matchAll(/["']([^"']+)["']/gu)]
    .map(match => match[1].trim())
    .filter(Boolean);
  if (quoted.length > 0) return [...new Set(quoted)].sort();

  const bare = valueText
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(",")
    .map(value => value.trim().replace(/[.)]+$/u, ""))
    .filter(value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value));
  return bare.length > 0 ? [...new Set(bare)].sort() : null;
}

function inferEnumValues(header, context) {
  const braceValues = /\{([^{}]+)\}/u.exec(header)?.[1];
  if (braceValues) return enumValues(braceValues);

  const marker = /\b(?:possible values|choices|modes)\s*:\s*([\s\S]*)/iu.exec(context)?.[1];
  if (!marker) return null;
  const bounded = marker.includes("]") ? marker.slice(0, marker.indexOf("]")) : marker;
  return enumValues(bounded);
}

/**
 * Extract only option declarations, not prose mentions of flags. The returned
 * shapes are advisory scanner evidence and never participate in argv validation.
 */
export function extractHelpOptionSpecs(helpText) {
  const lines = helpText.split(/\r?\n/u);
  const declarations = [];
  let declarationIndent = null;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trimStart();
    if (!trimmed.startsWith("-")) continue;
    const indent = lines[index].length - trimmed.length;
    declarationIndent ??= indent;
    if (indent !== declarationIndent) continue;
    const header = trimmed.split(/\s{2,}/u, 1)[0] ?? "";
    const flags = [...header.matchAll(/--([a-z0-9][a-z0-9_-]*)(?=[\s,[<{]|$)/giu)].map(match =>
      normalizeLongFlag(`--${match[1]}`)
    );
    if (flags.length === 0) continue;
    declarations.push({ index, header, flags: [...new Set(flags)] });
  }

  const specs = {};
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index];
    const nextIndex = declarations[index + 1]?.index ?? lines.length;
    const context = lines.slice(declaration.index, nextIndex).join("\n");
    const shape = {
      arity: inferFlagArity(declaration.header),
      values: inferEnumValues(declaration.header, context),
    };
    for (const flag of declaration.flags) specs[flag] = shape;
  }
  return specs;
}

/**
 * Compare only clear syntax and explicitly enumerated values from help output.
 * An unknown or unadvertised shape is ignored rather than guessed.
 */
export function compareHelpFlagShapes(contract, helpText) {
  const observed = extractHelpOptionSpecs(helpText);
  const arityMismatches = [];
  const enumMismatches = [];

  for (const [flag, declared] of Object.entries(contract.flags)) {
    if (!flag.startsWith("--") || declared.hiddenFromHelp) continue;
    const actual = observed[flag];
    if (!actual) continue;
    if (actual.arity !== null && !isContractAritySupported(declared.arity, actual.arity)) {
      arityMismatches.push({
        flag,
        contractArity: declared.arity,
        installedArity: actual.arity,
      });
    }
    if (!Array.isArray(declared.values) || declared.values.length === 0 || !actual.values?.length) {
      continue;
    }
    const expectedSet = new Set(declared.values);
    const actualSet = new Set(actual.values);
    const missingValues = [...expectedSet].filter(value => !actualSet.has(value)).sort();
    const extraValues = [...actualSet].filter(value => !expectedSet.has(value)).sort();
    if (missingValues.length > 0 || extraValues.length > 0) {
      enumMismatches.push({ flag, missingValues, extraValues, installedValues: actual.values });
    }
  }

  return { observed, arityMismatches, enumMismatches };
}

function isContractAritySupported(contractArity, installedArity) {
  if (contractArity === "none") return installedArity === "none" || installedArity === "optional";
  if (contractArity === "one") {
    return (
      installedArity === "one" || installedArity === "optional" || installedArity === "variadic"
    );
  }
  if (contractArity === "optional") return installedArity === "optional";
  return installedArity === "variadic";
}

function comparableVersion(value) {
  if (typeof value !== "string") return null;
  const version = /v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/u.exec(value)?.[0];
  if (!version) return null;
  const normalizedVersion = version.replace(/^v/iu, "").toLowerCase();
  const hash = /\(([0-9a-f]{7,})\)/iu.exec(value)?.[1]?.toLowerCase();
  return hash && !normalizedVersion.endsWith(`-${hash}`)
    ? `${normalizedVersion} (${hash})`
    : normalizedVersion;
}

/** Compare a full target version, including a build suffix when one is present. */
export function compareTargetVersion(targetVersion, installedVersion) {
  const targetComparable = comparableVersion(targetVersion);
  const installedComparable = comparableVersion(installedVersion);
  return {
    targetVersion,
    installedVersion,
    targetComparable,
    installedComparable,
    matches:
      targetComparable !== null && installedComparable !== null
        ? targetComparable === installedComparable
        : null,
  };
}

/**
 * Decide whether an indeterminate installed-version comparison must count as a
 * critical unverified state. `compareTargetVersion` returns `matches: null` when
 * either side is unparseable or unavailable; under --require-installed a
 * declared target we could not confirm is a fail-open (the run would otherwise
 * only log and exit 0), so it is critical. A clean match or mismatch is decided
 * elsewhere, and a probe with no declared target is left alone so a provider
 * that intentionally pins no version is not forced to fail.
 */
export function requireInstalledVersionIndeterminateIsCritical(requireInstalled, versionProbe) {
  if (!requireInstalled) return false;
  if (versionProbe?.matches === true || versionProbe?.matches === false) return false;
  return Boolean(versionProbe?.targetVersion);
}

/**
 * Decide whether a help probe that spawned but exited nonzero must count as a
 * critical unverified state. Such help text cannot be trusted for drift
 * comparison (it may be an error message that happens to match), so under
 * --require-installed it is a fail-open exactly like a nonzero `--version` exit,
 * and is escalated to a critical rather than a mere warning.
 */
export function requireInstalledHelpProbeErrorIsCritical(requireInstalled, helpProbe) {
  if (!requireInstalled) return false;
  if (!helpProbe?.available) return false;
  return Boolean(helpProbe?.helpExitedNonzero);
}

function runReadOnlyCliCommand(machinery, executable, args, timeoutMs = PROBE_TIMEOUT_MS) {
  const extendedPath =
    typeof machinery.getExtendedPath === "function"
      ? machinery.getExtendedPath()
      : process.env.PATH;
  const env =
    typeof machinery.envWithExtendedPath === "function"
      ? machinery.envWithExtendedPath(process.env, extendedPath)
      : process.env;
  const resolved =
    typeof machinery.resolveCommandForSpawn === "function"
      ? machinery.resolveCommandForSpawn(executable, [...args], { envPath: extendedPath })
      : { command: executable, args: [...args] };
  const result = spawnSync(resolved.command, resolved.args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: PROBE_MAX_BUFFER,
    env,
    windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    available: !result.error,
    command: resolved.command,
    args: resolved.args,
    status: result.status,
    output: `${stdout}\n${stderr}`,
    error: result.error?.message,
  };
}

function firstVersionLine(output) {
  return (
    output
      .split(/\r?\n/u)
      .map(line => line.trim())
      .find(line => comparableVersion(line) !== null)
      ?.slice(0, 240) ?? null
  );
}

/**
 * Parse the installed version from a `--version` probe result, but ONLY when the
 * command both spawned and exited 0. A nonzero exit (or a signal kill, where
 * `status` is null) means `--version` itself failed, so its stdout may be stale
 * or error text that happens to parse; trusting it was a fail-open. Returning
 * null here forces the version comparison to `matches: null`, which under
 * --require-installed is escalated to a critical rather than passing as verified.
 */
export function parseTrustedInstalledVersion(versionResult) {
  const trusted = Boolean(versionResult?.available) && versionResult?.status === 0;
  return trusted ? firstVersionLine(versionResult.output ?? "") : null;
}

export function rootCatalogDrift(subcommands, rootCommands) {
  if (!Array.isArray(rootCommands) || rootCommands.length === 0) {
    return { added: [], removed: [] };
  }
  const declaredWithAliases = new Set();
  const aliasGroups = [];
  for (const subcommand of subcommands) {
    if (subcommand.commandPath.length !== 1) continue;
    const names = new Set([subcommand.commandPath[0], ...(subcommand.aliases ?? [])]);
    for (const name of names) declaredWithAliases.add(name);

    const overlappingGroups = aliasGroups.filter(group => [...names].some(name => group.has(name)));
    const merged = new Set(names);
    for (const group of overlappingGroups) {
      for (const name of group) merged.add(name);
      aliasGroups.splice(aliasGroups.indexOf(group), 1);
    }
    aliasGroups.push(merged);
  }
  const discovered = new Set(rootCommands.filter(command => command !== "help"));
  return {
    added: [...discovered].filter(command => !declaredWithAliases.has(command)).sort(),
    // Help output commonly lists aliases only in prose (e.g. `[aliases: ls]`).
    // Treat each connected alias group as one command surface, including
    // contracts that intentionally catalog both spellings as separate paths.
    removed: aliasGroups
      .filter(group => ![...group].some(command => discovered.has(command)))
      .map(group => [...group].sort()[0])
      .sort(),
  };
}

/**
 * Confirm every segment of a declared path is advertised by its parent's help
 * before the scanner invokes that path's own `--help`. This prevents CLIs that
 * fall back to root help for unknown commands from creating fake flag drift.
 */
export function verifyDeclaredCommandPath(
  commandPath,
  readParentSurface,
  aliasesByPath = new Map()
) {
  for (let index = 0; index < commandPath.length; index++) {
    const parentPath = commandPath.slice(0, index);
    const parent = readParentSurface(parentPath);
    if (!parent.available) {
      return {
        state: "unknown",
        reason: `could not inspect parent command ${parentPath.join(" ") || "root"}`,
      };
    }
    if (parent.commands.length === 0) {
      return {
        state: "unknown",
        reason: `parent command ${parentPath.join(" ") || "root"} did not advertise a command list`,
      };
    }
    const pathKey = commandPath.slice(0, index + 1).join(" ");
    const aliases = aliasesByPath.get(pathKey) ?? [];
    const advertised = [commandPath[index], ...aliases].some(command =>
      parent.commands.includes(command)
    );
    if (!advertised) {
      return {
        state: "missing",
        reason: `${commandPath[index]} is absent from ${parentPath.join(" ") || "root"} command help`,
      };
    }
  }
  return { state: "present", reason: null };
}

function probeInstalledCliSubcommands(machinery, contract, rootHelp, timeoutMs) {
  const subcommands = machinery.flattenCliSubcommands(contract.subcommands);
  const aliasesByPath = new Map(
    subcommands.map(subcommand => [subcommand.commandPath.join(" "), subcommand.aliases ?? []])
  );
  const probes = {};
  const commandHelpCache = new Map([
    [
      "",
      { available: rootHelp.available, commands: rootHelp.commands, helpHash: rootHelp.helpHash },
    ],
  ]);

  function commandHelp(commandPath) {
    const key = commandPath.join(" ");
    const cached = commandHelpCache.get(key);
    if (cached) return cached;
    const result = runReadOnlyCliCommand(
      machinery,
      contract.executable,
      [...commandPath, "--help"],
      timeoutMs
    );
    const surface = {
      available: result.available,
      commands: result.available ? extractRootCommands(result.output) : [],
      helpHash: result.available ? sha256(result.output) : null,
      status: result.status,
      error: result.error,
    };
    commandHelpCache.set(key, surface);
    return surface;
  }

  for (const subcommand of subcommands) {
    const commandPath = [...subcommand.commandPath];
    const pathState = verifyDeclaredCommandPath(commandPath, commandHelp, aliasesByPath);
    const key = commandPath.join(" ");
    const checkedHelpCommands = subcommand.helpArgs.map(helpArgs => [...commandPath, ...helpArgs]);
    const warnings = [];

    if (pathState.state === "missing") {
      probes[key] = {
        commandPath,
        checkedHelpCommands,
        available: false,
        existence: "missing",
        missingFlags: [],
        extraFlags: [],
        acknowledgedExtraFlags: [],
        discoveredFlags: [],
        arityMismatches: [],
        enumMismatches: [],
        helpHash: null,
        probedAt: new Date().toISOString(),
        warnings: [pathState.reason],
        risk: subcommand.risk,
        exposure: subcommand.exposure,
        tier: subcommand.tier,
        summary: subcommand.summary,
      };
      continue;
    }

    const outputs = [];
    let available = true;
    for (const helpArgs of subcommand.helpArgs) {
      const result = runReadOnlyCliCommand(
        machinery,
        contract.executable,
        [...commandPath, ...helpArgs],
        timeoutMs
      );
      if (!result.available) {
        available = false;
        warnings.push(
          result.error ??
            `could not run ${contract.executable} ${[...commandPath, ...helpArgs].join(" ")}`
        );
        break;
      }
      outputs.push(result.output);
      if (result.status !== 0 && !subcommand.helpProbeExitTolerant) {
        warnings.push(
          `${contract.executable} ${[...commandPath, ...helpArgs].join(" ")} exited with status ${result.status}`
        );
      }
    }

    const helpText = outputs.join("\n");
    const helpHash = available ? sha256(helpText) : null;
    const fellBackToRoot =
      available && rootHelp.helpHash && helpHash === rootHelp.helpHash && commandPath.length > 0;
    if (fellBackToRoot) {
      available = false;
      warnings.push(
        "subcommand help matched root help output, so the command was treated as unavailable"
      );
    }
    if (pathState.state === "unknown") warnings.push(pathState.reason);

    const discoveredFlags = available ? machinery.extractDiscoveredFlags(helpText) : [];
    const drift = available
      ? machinery.computeSubcommandFlagDrift(
          subcommand,
          contract.executable,
          helpText,
          discoveredFlags
        )
      : { missingFlags: [], extraFlags: [], acknowledgedExtraFlags: [], warnings: [] };
    // Subcommand catalogs are tracking and safety metadata, not a request argv
    // allowlist. Several deliberately use optional arity as a conservative
    // catalog shape, so only the fully validated root request surface receives
    // arity and enum comparisons.
    warnings.push(...drift.warnings);

    probes[key] = {
      commandPath,
      checkedHelpCommands,
      available,
      existence: fellBackToRoot ? "missing" : pathState.state,
      missingFlags: drift.missingFlags,
      extraFlags: drift.extraFlags,
      acknowledgedExtraFlags: drift.acknowledgedExtraFlags,
      discoveredFlags,
      arityMismatches: [],
      enumMismatches: [],
      helpHash,
      probedAt: new Date().toISOString(),
      warnings,
      risk: subcommand.risk,
      exposure: subcommand.exposure,
      tier: subcommand.tier,
      summary: subcommand.summary,
    };
  }
  return probes;
}

function probeInstalledCliSurface(machinery, cli, timeoutMs = PROBE_TIMEOUT_MS) {
  const contract = machinery.UPSTREAM_CLI_CONTRACTS[cli];
  const warnings = [];
  const outputs = [];
  // A help command that exits nonzero (or by signal) produced help text we cannot
  // trust for drift comparison. Track it so --require-installed can escalate it to
  // a critical instead of a mere warning (the same fail-open the --version fix
  // closes; a matching-looking help output with a failed exit must not pass).
  let helpExitedNonzero = false;
  let resolvedCommand;
  let resolvedArgs;

  for (const helpArgs of contract.helpArgs) {
    const result = runReadOnlyCliCommand(machinery, contract.executable, helpArgs, timeoutMs);
    resolvedCommand ??= result.command;
    resolvedArgs ??= result.args;
    if (!result.available) {
      return {
        cli,
        executable: contract.executable,
        resolvedCommand,
        resolvedArgs,
        available: false,
        checkedHelpCommands: contract.helpArgs,
        missingFlags: [],
        extraFlags: [],
        acknowledgedExtraFlags: [],
        discoveredFlags: [],
        arityMismatches: [],
        enumMismatches: [],
        helpHash: null,
        versionProbe: null,
        rootCommands: [],
        rootCatalogDrift: { added: [], removed: [] },
        subcommands: {},
        probedAt: new Date().toISOString(),
        warnings: [result.error ?? `could not run ${contract.executable} ${helpArgs.join(" ")}`],
      };
    }
    outputs.push(result.output);
    if (result.status !== 0) {
      helpExitedNonzero = true;
      warnings.push(
        `${contract.executable} ${helpArgs.join(" ")} exited with status ${result.status}`
      );
    }
  }

  const helpText = outputs.join("\n");
  const discoveredFlags = machinery.extractDiscoveredFlags(helpText);
  const drift = machinery.computeFlagDrift(contract, helpText, discoveredFlags);
  const shapes = compareHelpFlagShapes(contract, helpText);
  warnings.push(...drift.warnings);

  const rootResult = runReadOnlyCliCommand(machinery, contract.executable, ["--help"], timeoutMs);
  const rootHelp = {
    available: rootResult.available,
    commands: rootResult.available ? extractRootCommands(rootResult.output) : [],
    helpHash: rootResult.available ? sha256(rootResult.output) : null,
  };
  if (!rootResult.available) {
    warnings.push(
      rootResult.error ?? `${contract.executable} --help was unavailable for root command discovery`
    );
  } else if (rootResult.status !== 0) {
    helpExitedNonzero = true;
    warnings.push(`${contract.executable} --help exited with status ${rootResult.status}`);
  }

  const versionResult = runReadOnlyCliCommand(
    machinery,
    contract.executable,
    ["--version"],
    timeoutMs
  );
  // Trust the parsed version ONLY when the command both spawned AND exited 0
  // (see parseTrustedInstalledVersion). A nonzero exit yields null here, making
  // `matches` indeterminate, which under --require-installed is escalated to a
  // critical (installed-version-indeterminate) rather than passing as verified.
  const installedVersion = parseTrustedInstalledVersion(versionResult);
  const targetVersion = machinery.getProviderDefinition(cli).upstreamContract.targetVersion;
  const versionProbe = {
    available: versionResult.available,
    status: versionResult.status,
    installedVersion,
    ...compareTargetVersion(targetVersion, installedVersion),
  };
  if (!versionResult.available) {
    warnings.push(versionResult.error ?? `${contract.executable} --version was unavailable`);
  } else if (versionResult.status !== 0) {
    warnings.push(`${contract.executable} --version exited with status ${versionResult.status}`);
  } else if (!installedVersion) {
    warnings.push(`${contract.executable} --version returned no parseable version`);
  }

  const flattened = machinery.flattenCliSubcommands(contract.subcommands);
  return {
    cli,
    executable: contract.executable,
    resolvedCommand,
    resolvedArgs,
    available: true,
    checkedHelpCommands: contract.helpArgs,
    missingFlags: drift.missingFlags,
    extraFlags: drift.extraFlags,
    acknowledgedExtraFlags: drift.acknowledgedExtraFlags,
    discoveredFlags,
    arityMismatches: shapes.arityMismatches,
    enumMismatches: shapes.enumMismatches,
    helpHash: sha256(helpText),
    helpExitedNonzero,
    versionProbe,
    rootCommands: rootHelp.commands,
    rootCatalogDrift: rootCatalogDrift(flattened, rootHelp.commands),
    subcommands: probeInstalledCliSubcommands(machinery, contract, rootHelp, timeoutMs),
    probedAt: new Date().toISOString(),
    warnings,
  };
}

function todayStamp() {
  // Local script context (NOT a Workflow script) — Date is available here.
  return new Date().toISOString().slice(0, 10);
}

export function renderReport(cli, contract, meta, fetched, findings, helpProbe = null) {
  const stamp = todayStamp();
  const lines = [];
  lines.push(`# Upstream scan report — ${cli} (${contract.upstream})`);
  lines.push("");
  lines.push(`- Date: ${stamp}`);
  lines.push(`- Executable: \`${contract.executable}\``);
  lines.push(`- Package: ${meta.packageName ? `\`${meta.packageName}\`` : "—"}`);
  lines.push(`- Release channel: ${meta.releaseChannel ?? "—"}`);
  lines.push(`- Repo: ${meta.repo ?? "—"}`);
  lines.push(`- Install docs: ${meta.installDocsUrl ?? "—"}`);
  lines.push("");
  lines.push("## Mechanical source of truth");
  lines.push("");
  lines.push(
    "Flags, output modes, session/resume rules, permission modes, and env contracts " +
      "are defined and enforced ONLY by `src/upstream-contracts.ts` " +
      `(\`UPSTREAM_CLI_CONTRACTS.${cli}\`). This report is advisory; it never changes ` +
      "validation behaviour."
  );
  lines.push("");
  lines.push(`- Contract flags tracked: **${Object.keys(contract.flags).length}**`);
  lines.push(
    `- Subcommands tracked: **${Object.keys(contract.subcommands ?? {}).length}** top-level`
  );
  lines.push(`- Conformance fixtures: **${contract.conformanceFixtures.length}**`);
  lines.push(`- Watched categories: ${meta.watchCategories.map(c => `\`${c}\``).join(", ")}`);
  lines.push("");
  lines.push("## Tracked sources");
  lines.push("");
  if (fetched && fetched.length) {
    lines.push("| Source | Status | Bytes | SHA-256 (12) | Semantic SHA-256 (12) |");
    lines.push("| ------ | ------ | ----- | ------------ | --------------------- |");
    for (const f of fetched) {
      const sha = f.sha256 ? f.sha256.slice(0, 12) : "—";
      const semanticSha = f.semantic?.sha256 ? f.semantic.sha256.slice(0, 12) : "n/a";
      const status = f.ok
        ? `${f.status} OK`
        : `${f.status || "ERR"}${f.error ? ` (${f.error})` : ""}`;
      lines.push(`| ${f.url} | ${status} | ${f.bytes} | ${sha} | ${semanticSha} |`);
    }
  } else {
    for (const url of meta.sourceUrls) {
      lines.push(`- ${url} _(not fetched — run with \`--live\`)_`);
    }
  }
  lines.push("");
  if (helpProbe) {
    lines.push("## Installed CLI probe");
    lines.push("");
    if (!helpProbe.available) {
      lines.push("- Installed executable was unavailable for a request-surface probe.");
    } else {
      const version = helpProbe.versionProbe;
      const versionState =
        version?.matches === true
          ? "matches"
          : version?.matches === false
            ? "mismatch"
            : "unavailable";
      lines.push(`- Contract target version: \`${version?.targetVersion ?? "unavailable"}\``);
      lines.push(`- Installed version: \`${version?.installedVersion ?? "unavailable"}\``);
      lines.push(`- Version comparison: **${versionState}**`);
      lines.push(`- Root commands discovered: **${(helpProbe.rootCommands ?? []).length}**`);
      const rootDrift = helpProbe.rootCatalogDrift ?? { added: [], removed: [] };
      if (rootDrift.added.length > 0 || rootDrift.removed.length > 0) {
        lines.push(
          `- Root catalog drift: added=${rootDrift.added.join(", ") || "none"}; removed=${rootDrift.removed.join(", ") || "none"}`
        );
      } else {
        lines.push("- Root catalog drift: none");
      }
      lines.push(
        `- Root request flag-shape drift: ${(helpProbe.arityMismatches ?? []).length} arity, ${(helpProbe.enumMismatches ?? []).length} enum finding(s)`
      );
    }
    lines.push("");
  }
  if (helpProbe?.subcommands) {
    const rows = Object.values(helpProbe.subcommands);
    const driftRows = rows.filter(
      row => (row.extraFlags?.length ?? 0) > 0 || (row.missingFlags?.length ?? 0) > 0
    );
    lines.push("## Declared subcommand help surfaces");
    lines.push("");
    lines.push(`- Probed declared command paths: **${rows.length}**`);
    lines.push(`- Drifted command paths: **${driftRows.length}**`);
    const counts = new Map();
    for (const row of rows) counts.set(row.risk, (counts.get(row.risk) ?? 0) + 1);
    if (counts.size > 0) {
      lines.push(
        `- Risk counts: ${[...counts.entries()].map(([risk, count]) => `${risk}=${count}`).join(", ")}`
      );
    }
    if (driftRows.length > 0) {
      lines.push("");
      lines.push("| Command path | Extra flags | Missing flags |");
      lines.push("| ------------ | ----------- | ------------- |");
      for (const row of driftRows) {
        lines.push(
          `| ${row.commandPath.join(" ")} | ${(row.extraFlags ?? []).join(", ") || "—"} | ${(row.missingFlags ?? []).join(", ") || "—"} |`
        );
      }
    }
    lines.push("");
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (findings.length === 0) {
    lines.push("- No findings. (Default offline scan is advisory-only.)");
  } else {
    for (const f of findings) {
      lines.push(`- **${f.severity}** — ${f.message}`);
    }
  }
  lines.push("");
  lines.push("## Next actions");
  lines.push("");
  lines.push(
    "1. If a watched category changed upstream, update the relevant flag/enum in " +
      "`src/upstream-contracts.ts` and add/adjust a conformance fixture."
  );
  lines.push(
    "2. Mirror any `sourceUrls` / `watchCategories` change into `provider-sources.dag.toml`."
  );
  lines.push("3. Re-run `npm run upstream:contracts` to confirm fixtures + TOML-sync pass.");
  lines.push("");
  return lines.join("\n");
}

function writeReport(cli, content) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, `${todayStamp()}-${cli}.md`);
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}

async function runScan(machinery, toml, flags) {
  const { UPSTREAM_CLI_CONTRACTS, probeInstalledAcpEntrypoint } = machinery;
  const report = machinery.buildUpstreamContractReport();
  const providers = selectProviders(UPSTREAM_CLI_CONTRACTS, flags.provider);

  if (flags.writeSnapshot && !flags.live && !flags.probeInstalled) {
    console.warn(
      "[upstream-scan] --write-snapshot has no effect without --live (nothing fetched); skipping snapshot writes."
    );
  }

  let criticalCount = 0;

  for (const cli of providers) {
    const contract = UPSTREAM_CLI_CONTRACTS[cli];
    const meta = contract.upstreamMetadata;
    if (!meta) {
      console.warn(`[upstream-scan] ${cli}: no upstreamMetadata; skipping.`);
      continue;
    }

    console.log(`\n=== ${cli} — ${contract.upstream} ===`);
    console.log(`  executable      : ${contract.executable}`);
    console.log(`  package         : ${meta.packageName ?? "—"} (${meta.releaseChannel ?? "—"})`);
    console.log(`  contract flags  : ${Object.keys(contract.flags).length}`);
    console.log(`  fixtures        : ${contract.conformanceFixtures.length}`);
    console.log(`  watch categories: ${meta.watchCategories.join(", ")}`);
    console.log(`  sources         :`);
    for (const url of meta.sourceUrls) console.log(`    - ${url}`);

    const findings = [];
    const priorSnapshot = readSnapshot(cli);
    let fetched = null;
    let helpProbe = null;

    if (flags.live) {
      fetched = [];
      const priorByUrl = new Map((priorSnapshot?.sources ?? []).map(s => [s.url, s]));
      for (const url of meta.sourceUrls) {
        const result = await fetchSource(url);
        fetched.push(result);
        if (!result.ok) {
          findings.push({
            severity: "critical",
            category: "source-unreachable",
            message: `Could not fetch ${url} (status ${result.status}${result.error ? `, ${result.error}` : ""}).`,
          });
          criticalCount++;
          console.warn(
            `  [live] UNREACHABLE ${url} — advisory failure (does not break default CI).`
          );
        } else {
          const before = priorByUrl.get(url);
          const comparison = compareSourceSnapshot(before, result);
          if (comparison.changed) {
            findings.push({
              severity: "critical",
              category: "watched-category-changed",
              message: `${comparison.comparison === "semantic" ? "Source semantics" : "Content hash"} changed for ${url} since last snapshot. Review against watched categories: ${meta.watchCategories.join(", ")}.`,
            });
            criticalCount++;
            console.log(
              `  [live] CHANGED ${url} (${comparison.comparison} ${comparison.beforeHash.slice(0, 12)} -> ${comparison.currentHash.slice(0, 12)})`
            );
          } else if (comparison.comparison === "semantic-baseline-initialized") {
            console.log(`  [live] semantic baseline initialized for ${url}`);
          } else {
            console.log(`  [live] ok ${url} (${result.status}, ${result.bytes} bytes)`);
          }
        }
      }
    }

    // Bidirectional installed-CLI help surface probe (when requested).
    // Keep this outside the `--live` branch so offline `--probe-installed`
    // catches local CLI drift without requiring network access.
    if (flags.probeInstalled) {
      try {
        helpProbe = probeInstalledCliSurface(machinery, cli);
      } catch (e) {
        console.warn(`  [probe] failed for ${cli}: ${e?.message ?? e}`);
        // A thrown probe must not be silently treated as drift-free. Under
        // --require-installed the entire contract of the flag is that drift was
        // actually checked against the installed binary, so a probe that could
        // not run is a critical unverified state, exactly like the absent-binary
        // path below. Without this, a machinery bug in the probe path lets
        // --fail-on-critical exit 0 while checking nothing.
        if (flags.requireInstalled) {
          findings.push({
            severity: "critical",
            category: "installed-probe-error",
            message: `--require-installed was set but probing the ${cli} binary (${contract.executable}) threw (${e?.message ?? e}), so its contract is unverified. Fix the probe or drop --require-installed; do not treat this run as drift-free.`,
          });
          criticalCount++;
          console.log(
            `  [probe] PROBE ERROR: ${contract.executable} probe threw; contract unverified`
          );
        }
      }

      if (helpProbe) {
        const prior = priorSnapshot;
        const priorHelp = priorSnapshot?.helpSurface;

        // `--probe-installed` alone is a no-op for an absent binary, which is
        // right for a developer machine that has only some providers, and a
        // trap for a gate: a runner with no provider CLIs installed reports
        // zero drift and passes while checking nothing. `--require-installed`
        // makes that vacuous pass impossible by demanding the binary actually
        // be there. The provider set comes from the registry, so this never
        // needs a hand-maintained list of executables.
        if (flags.requireInstalled && !helpProbe.available) {
          findings.push({
            severity: "critical",
            category: "installed-binary-absent",
            message: `--require-installed was set but the ${cli} binary (${contract.executable}) could not be probed on this machine, so its contract is unverified. Install the provider CLI or drop --require-installed; do not treat this run as drift-free.`,
          });
          criticalCount++;
          console.log(
            `  [probe] BINARY ABSENT: ${contract.executable} not probeable; contract unverified`
          );
        }

        if (requireInstalledHelpProbeErrorIsCritical(flags.requireInstalled, helpProbe)) {
          // A help command spawned but exited nonzero, so the help text used for
          // drift comparison is untrustworthy (it may be an error message that
          // happens to match, or partial output). Under --require-installed that
          // is an unverified contract, the same fail-open the --version exit fix
          // closes, so escalate it to a critical rather than a warning.
          findings.push({
            severity: "critical",
            category: "installed-help-probe-error",
            message: `--require-installed was set but a ${cli} help probe (${contract.executable}) exited nonzero, so its help output cannot be trusted for drift comparison and its contract is unverified. Re-probe the CLI; do not treat this run as drift-free.`,
          });
          criticalCount++;
          console.log(
            `  [probe] HELP PROBE ERROR (require-installed): ${contract.executable} help exited nonzero; contract unverified`
          );
        }

        if (helpProbe.available) {
          const versionProbe = helpProbe.versionProbe;
          if (versionProbe?.matches === false) {
            findings.push({
              severity: "critical",
              category: "installed-version-mismatch",
              message: `Installed ${cli} version ${versionProbe.installedVersion ?? "unparseable"} does not match the contract baseline ${versionProbe.targetVersion}. Re-probe the CLI, then update PROVIDER_TARGET_VERSIONS and the contract evidence together.`,
            });
            criticalCount++;
            console.log(
              `  [probe] VERSION MISMATCH: installed=${versionProbe.installedVersion ?? "unparseable"}; target=${versionProbe.targetVersion}`
            );
          } else if (versionProbe?.matches === true) {
            console.log(`  [probe] version matches target: ${versionProbe.targetVersion}`);
          } else {
            // Indeterminate: the installed version could not be parsed or read,
            // or no version probe ran at all. A declared target we cannot
            // confirm is an unverified contract, so under --require-installed it
            // is critical rather than a log line, closing the same fail-open as
            // the absent-binary and probe-error paths. targetVersion is present
            // for every provider today; guarding on it avoids inventing a
            // failure for a provider that intentionally pins no version.
            const installed = versionProbe?.installedVersion ?? "unparseable";
            const target = versionProbe?.targetVersion ?? null;
            if (
              requireInstalledVersionIndeterminateIsCritical(flags.requireInstalled, versionProbe)
            ) {
              findings.push({
                severity: "critical",
                category: "installed-version-indeterminate",
                message: `--require-installed was set but the installed ${cli} version could not be compared against the contract baseline ${target} (installed=${installed}), so its version is unverified. Re-probe the CLI; do not treat this run as drift-free.`,
              });
              criticalCount++;
              console.log(
                `  [probe] VERSION INDETERMINATE (require-installed): installed=${installed}; target=${target}`
              );
            } else {
              console.log(
                `  [probe] version could not be compared: installed=${installed}; target=${target ?? "unknown"}`
              );
            }
          }

          const contractFlags = new Set(Object.keys(contract.flags));
          const extras = (helpProbe.extraFlags || []).filter(f => !contractFlags.has(f));
          const missing = helpProbe.missingFlags || [];

          if (extras.length > 0) {
            findings.push({
              severity: "critical",
              category: "installed-help-surface-drift",
              message: `Installed ${cli} binary advertises ${extras.length} flag(s) not in contract: ${extras.slice(0, 8).join(", ")}${extras.length > 8 ? "..." : ""}. Review against watched categories (${meta.watchCategories.join(", ")}) and update src/upstream-contracts.ts + fixtures.`,
            });
            criticalCount++;
            console.log(
              `  [probe] EXTRA FLAGS in installed binary: ${extras.slice(0, 6).join(", ")}${extras.length > 6 ? ` (+${extras.length - 6} more)` : ""}`
            );
          }
          if (missing.length > 0) {
            findings.push({
              severity: "warning",
              category: "binary-missing-declared-flags",
              message: `Installed ${cli} binary no longer advertises declared contract flag(s): ${missing.join(", ")}.`,
            });
            console.log(`  [probe] MISSING from binary (vs contract): ${missing.join(", ")}`);
          }

          for (const mismatch of helpProbe.arityMismatches || []) {
            findings.push({
              severity: "critical",
              category: "installed-flag-arity-drift",
              message: `Installed ${cli} ${mismatch.flag} has ${mismatch.installedArity} arity, but the contract declares ${mismatch.contractArity}.`,
            });
            criticalCount++;
            console.log(
              `  [probe] FLAG ARITY DRIFT ${mismatch.flag}: installed=${mismatch.installedArity}; contract=${mismatch.contractArity}`
            );
          }
          for (const mismatch of helpProbe.enumMismatches || []) {
            findings.push({
              severity: "critical",
              category: "installed-flag-enum-drift",
              message: `Installed ${cli} ${mismatch.flag} values differ from the contract (new: ${mismatch.extraValues.join(", ") || "none"}; missing: ${mismatch.missingValues.join(", ") || "none"}).`,
            });
            criticalCount++;
            console.log(
              `  [probe] FLAG ENUM DRIFT ${mismatch.flag}: new=${mismatch.extraValues.join(", ") || "none"}; missing=${mismatch.missingValues.join(", ") || "none"}`
            );
          }

          const rootDrift = helpProbe.rootCatalogDrift ?? { added: [], removed: [] };
          if (rootDrift.added.length > 0) {
            findings.push({
              severity: "critical",
              category: "installed-root-command-added",
              message: `Installed ${cli} root help advertises uncatalogued command(s): ${rootDrift.added.join(", ")}. Add safety-classified catalog entries before exposure.`,
            });
            criticalCount++;
            console.log(`  [probe] NEW ROOT COMMANDS: ${rootDrift.added.join(", ")}`);
          }
          if (rootDrift.removed.length > 0) {
            findings.push({
              severity: "critical",
              category: "declared-root-command-missing",
              message: `Declared ${cli} root command(s) are absent from installed help: ${rootDrift.removed.join(", ")}. Remove or correct stale catalog entries.`,
            });
            criticalCount++;
            console.log(`  [probe] MISSING ROOT COMMANDS: ${rootDrift.removed.join(", ")}`);
          }

          const subcommands = Object.values(helpProbe.subcommands || {});
          const subcommandDrift = subcommands.filter(
            sub =>
              sub.existence === "missing" ||
              (sub.extraFlags || []).length > 0 ||
              (sub.missingFlags || []).length > 0
          );
          if (subcommands.length > 0) {
            console.log(
              `  [probe] subcommands: ${subcommands.length} declared path(s), ${subcommandDrift.length} with drift`
            );
          }
          for (const sub of subcommandDrift) {
            const path = sub.commandPath.join(" ");
            if (sub.existence === "missing") {
              findings.push({
                severity: "critical",
                category: "declared-subcommand-missing",
                message: `Declared ${cli} subcommand ${path} is absent from its parent command help. The scanner skipped its help probe to avoid root-help fallback false positives.`,
              });
              criticalCount++;
              console.log(`  [probe] MISSING SUBCOMMAND: ${path}`);
              continue;
            }
            if ((sub.extraFlags || []).length > 0) {
              findings.push({
                severity: "critical",
                category: "installed-subcommand-help-surface-drift",
                message: `Installed ${cli} ${path} help advertises ${(sub.extraFlags || []).length} unclassified flag(s): ${sub.extraFlags.slice(0, 8).join(", ")}${sub.extraFlags.length > 8 ? "..." : ""}. Review the subcommand contract before any execution exposure.`,
              });
              criticalCount++;
              console.log(
                `  [probe] EXTRA SUBCOMMAND FLAGS ${path}: ${sub.extraFlags.slice(0, 6).join(", ")}${sub.extraFlags.length > 6 ? ` (+${sub.extraFlags.length - 6} more)` : ""}`
              );
            }
            if ((sub.missingFlags || []).length > 0) {
              findings.push({
                severity: "warning",
                category: "binary-missing-declared-subcommand-flags",
                message: `Installed ${cli} ${path} help no longer advertises declared subcommand flag(s): ${sub.missingFlags.join(", ")}.`,
              });
              console.log(
                `  [probe] MISSING SUBCOMMAND FLAGS ${path}: ${sub.missingFlags.join(", ")}`
              );
            }
          }

          // Diff vs prior help snapshot (if we have one).
          const previousFlags = normalizedDiscoveredFlags(priorHelp);
          if (priorHelp && Array.isArray(previousFlags)) {
            const prevSet = new Set(previousFlags);
            const currSet = new Set(helpProbe.discoveredFlags || []);
            const newSince = [...currSet].filter(f => !prevSet.has(f));
            const gone = [...prevSet].filter(f => !currSet.has(f));
            if (newSince.length > 0 || gone.length > 0) {
              findings.push({
                severity: "critical",
                category: "installed-help-surface-drift",
                message: `Help surface for ${cli} changed since last snapshot (new: ${newSince.slice(0, 5).join(", ") || "—"}; removed: ${gone.slice(0, 5).join(", ") || "—"}).`,
              });
              criticalCount++;
              console.log(`  [probe] HELP SURFACE CHANGED vs prior snapshot`);
            } else if (
              priorHelp.helpHash &&
              helpProbe.helpHash &&
              priorHelp.helpHash !== helpProbe.helpHash
            ) {
              findings.push({
                severity: "warning",
                category: "installed-help-surface-drift",
                message: `Help text hash for ${cli} changed since last snapshot (subtle drift even if flag set looks stable).`,
              });
              console.log(`  [probe] help text hash drift vs prior (no net flag add/remove)`);
            }
          }

          if (Array.isArray(prior?.rootCommands)) {
            const priorRoot = new Set(prior.rootCommands);
            const currentRoot = new Set(helpProbe.rootCommands || []);
            const added = [...currentRoot].filter(command => !priorRoot.has(command));
            const removed = [...priorRoot].filter(command => !currentRoot.has(command));
            if (added.length > 0 || removed.length > 0) {
              findings.push({
                severity: "critical",
                category: "installed-root-command-snapshot-drift",
                message: `Root command surface for ${cli} changed since the prior snapshot (new: ${added.slice(0, 8).join(", ") || "none"}; removed: ${removed.slice(0, 8).join(", ") || "none"}).`,
              });
              criticalCount++;
              console.log(`  [probe] ROOT COMMAND SURFACE CHANGED vs prior snapshot`);
            }
          }
        } else {
          console.log(
            `  [probe] ${cli} binary not available on this machine (skipped surface diff)`
          );
        }
      }
    }

    // ACP entrypoint drift — reported SEPARATELY from request-tool command
    // drift above. Read-only `--version` / `--help` probes only; the live ACP
    // process is never started.
    if (flags.probeInstalled && typeof probeInstalledAcpEntrypoint === "function") {
      let acpProbe = null;
      try {
        acpProbe = probeInstalledAcpEntrypoint(cli);
      } catch (e) {
        console.warn(`  [acp-probe] failed for ${cli}: ${e?.message ?? e}`);
      }
      if (acpProbe) {
        const entry = [acpProbe.executable, ...acpProbe.entrypointArgs].join(" ").trim();
        if (acpProbe.status !== "native") {
          console.log(
            `  [acp-probe] ${cli}: ${acpProbe.status} (${acpProbe.targetVersion}) — no native entrypoint to probe`
          );
        } else if (acpProbe.available === true) {
          console.log(
            `  [acp-probe] ${cli}: native ACP entrypoint \`${entry}\` present (probed ${acpProbe.checkedProbeCommands.length} read-only command(s))`
          );
        } else {
          findings.push({
            severity: "warning",
            category: "acp-entrypoint-drift",
            message: `Declared native ACP entrypoint \`${entry}\` did not respond to read-only probes on this machine (${acpProbe.warnings.join("; ") || "no probe succeeded"}). This is ACP entrypoint drift, distinct from request-tool command drift.`,
          });
          console.log(`  [acp-probe] ENTRYPOINT DRIFT ${cli}: native entrypoint not reachable`);
        }
      }
    }

    if (flags.writeSnapshot && (flags.live || (helpProbe && helpProbe.available))) {
      const snapshotPayload = buildSnapshotPayload(cli, fetched, priorSnapshot, helpProbe);
      const path = writeSnapshot(cli, snapshotPayload);
      console.log(`  [snapshot] wrote ${path}`);
    }

    if (flags.writeReport) {
      const content = renderReport(cli, contract, meta, fetched, findings, helpProbe);
      const path = writeReport(cli, content);
      console.log(`  [report] wrote ${path}`);
    }
  }

  console.log(
    `\n[upstream-scan] scan complete: ${providers.length} provider(s), mode=${flags.live ? "live" : "offline"}${flags.probeInstalled ? " +probe-installed" : ""}.`
  );
  if (report.schemaVersion !== "upstream-cli-contracts.v1") {
    console.error("[upstream-scan] WARNING: contract report schemaVersion unexpected.");
  }

  if (criticalCount > 0) {
    console.log(`[upstream-scan] ${criticalCount} critical finding(s) (advisory).`);
    if (flags.failOnCritical) {
      console.error("[upstream-scan] --fail-on-critical set: exiting non-zero.");
      return 1;
    }
  }
  return 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  const machinery = await loadMachinery();
  const toml = loadToml();

  if (flags.contractsCheck) {
    const failures = runContractsCheck(machinery, toml);
    process.exit(failures === 0 ? 0 : 1);
  }

  const code = await runScan(machinery, toml, flags);
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error("[upstream-scan] fatal:", err);
    process.exit(2);
  });
}
