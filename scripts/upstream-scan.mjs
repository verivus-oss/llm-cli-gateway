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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DIST_CONTRACTS = join(REPO_ROOT, "dist", "upstream-contracts.js");
const TOML_PATH = join(REPO_ROOT, "docs", "upstream", "provider-sources.dag.toml");
const SNAPSHOT_DIR = join(REPO_ROOT, "docs", "upstream", "snapshots");
const REPORT_DIR = join(REPO_ROOT, "docs", "upstream", "reports");

function parseArgs(argv) {
  const flags = {
    contractsCheck: false,
    live: false,
    writeSnapshot: false,
    writeReport: false,
    failOnCritical: false,
    provider: null,
    probeInstalled: false,
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
    else if (a === "--help" || a === "-h") flags.help = true;
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
      "  --write-snapshot      Persist fetched source hashes under docs/upstream/snapshots/ (requires --live).",
      "  --write-report        Write a markdown report under docs/upstream/reports/YYYY-MM-DD-<provider>.md.",
      "  --fail-on-critical    Exit non-zero when a critical finding is present (advisory otherwise).",
      "  --provider <cli>      Limit to one CliType (claude|codex|gemini|grok|mistral).",
      "  --probe-installed     Also run local --help probes and report bidirectional drift vs the contract",
      "                        (and vs prior snapshots when --write-snapshot is also used). Safe no-op if",
      "                        the binary is not present on this machine.",
      "  -h, --help            Show this help.",
      "",
      "Default (no flags): offline, network-free summary of tracked sources + contract surface.",
    ].join("\n")
  );
}

async function loadMachinery() {
  if (!existsSync(DIST_CONTRACTS)) {
    console.error(
      "[upstream-scan] dist/upstream-contracts.js not found. Run `npm run build` first " +
        "(the release gate runs `npm run check` before this)."
    );
    process.exit(2);
  }
  return import(DIST_CONTRACTS);
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
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      bytes: 0,
      sha256: null,
      error: String(err?.message ?? err),
    };
  }
}

function readSnapshot(cli) {
  const path = join(SNAPSHOT_DIR, `${cli}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
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

function todayStamp() {
  // Local script context (NOT a Workflow script) — Date is available here.
  return new Date().toISOString().slice(0, 10);
}

function renderReport(cli, contract, meta, fetched, findings, helpProbe = null) {
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
    lines.push("| Source | Status | Bytes | SHA-256 (12) |");
    lines.push("| ------ | ------ | ----- | ------------ |");
    for (const f of fetched) {
      const sha = f.sha256 ? f.sha256.slice(0, 12) : "—";
      const status = f.ok
        ? `${f.status} OK`
        : `${f.status || "ERR"}${f.error ? ` (${f.error})` : ""}`;
      lines.push(`| ${f.url} | ${status} | ${f.bytes} | ${sha} |`);
    }
  } else {
    for (const url of meta.sourceUrls) {
      lines.push(`- ${url} _(not fetched — run with \`--live\`)_`);
    }
  }
  lines.push("");
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
  const { UPSTREAM_CLI_CONTRACTS, probeInstalledCliContract } = machinery;
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
    let fetched = null;
    let helpProbe = null;

    if (flags.live) {
      fetched = [];
      const prior = readSnapshot(cli);
      const priorByUrl = new Map((prior?.sources ?? []).map(s => [s.url, s]));
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
          if (before && before.sha256 && before.sha256 !== result.sha256) {
            findings.push({
              severity: "critical",
              category: "watched-category-changed",
              message: `Content hash changed for ${url} since last snapshot — review against watched categories: ${meta.watchCategories.join(", ")}.`,
            });
            criticalCount++;
            console.log(
              `  [live] CHANGED ${url} (sha ${before.sha256.slice(0, 12)} → ${result.sha256.slice(0, 12)})`
            );
          } else {
            console.log(`  [live] ok ${url} (${result.status}, ${result.bytes} bytes)`);
          }
        }
      }
    }

    // Bidirectional installed-CLI help surface probe (when requested).
    // Keep this outside the `--live` branch so offline `--probe-installed`
    // catches local CLI drift without requiring network access.
    if (flags.probeInstalled && typeof probeInstalledCliContract === "function") {
      try {
        helpProbe = probeInstalledCliContract(cli);
      } catch (e) {
        console.warn(`  [probe] failed for ${cli}: ${e?.message ?? e}`);
      }

      if (helpProbe) {
        const prior = readSnapshot(cli);
        const priorHelp = prior?.helpSurface;

        if (helpProbe.available) {
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

          const subcommands = Object.values(helpProbe.subcommands || {});
          const subcommandDrift = subcommands.filter(
            sub => (sub.extraFlags || []).length > 0 || (sub.missingFlags || []).length > 0
          );
          if (subcommands.length > 0) {
            console.log(
              `  [probe] subcommands: ${subcommands.length} declared path(s), ${subcommandDrift.length} with drift`
            );
          }
          for (const sub of subcommandDrift) {
            const path = sub.commandPath.join(" ");
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
          if (priorHelp && priorHelp.discoveredFlags && Array.isArray(priorHelp.discoveredFlags)) {
            const prevSet = new Set(priorHelp.discoveredFlags);
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
        } else {
          console.log(
            `  [probe] ${cli} binary not available on this machine (skipped surface diff)`
          );
        }
      }
    }

    if (flags.writeSnapshot && (flags.live || (helpProbe && helpProbe.available))) {
      const snapshotPayload = {
        cli,
        fetchedAt: new Date().toISOString(),
        sources: fetched ?? [],
      };
      if (helpProbe && helpProbe.available) {
        snapshotPayload.helpSurface = {
          probedAt: helpProbe.probedAt,
          available: true,
          version: helpProbe.versionHint || null,
          flags: helpProbe.discoveredFlags || [],
          helpHash: helpProbe.helpHash || null,
          extraVsContract: helpProbe.extraFlags || [],
          missingFromBinary: helpProbe.missingFlags || [],
        };
        snapshotPayload.subcommands = Object.fromEntries(
          Object.entries(helpProbe.subcommands || {}).map(([path, sub]) => [
            path,
            {
              commandPath: sub.commandPath,
              probedAt: sub.probedAt,
              available: sub.available,
              flags: sub.discoveredFlags || [],
              helpHash: sub.helpHash || null,
              extraVsContract: sub.extraFlags || [],
              missingFromBinary: sub.missingFlags || [],
              risk: sub.risk,
              exposure: sub.exposure,
              tier: sub.tier,
              summary: sub.summary,
            },
          ])
        );
      }
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

main().catch(err => {
  console.error("[upstream-scan] fatal:", err);
  process.exit(2);
});
