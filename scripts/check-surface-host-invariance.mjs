#!/usr/bin/env node
// The published tool surface must not depend on the machine that built it.
//
// d2 of docs/plans/provider-surface-distribution.dag.toml. generate-site-discovery
// pins every config knob to a literal and says so in a comment:
//
//   "It must never inherit enabled API providers, routing, ACP, Kit, workspace,
//    or approval settings from the workstation that happened to build the site."
//
// That was a comment, not a control, and nothing failed if a later change let
// host state back in. It matters more from d4 onward, when the tool schemas stop
// being compiled constants and start being loaded from a seed, a pack, live
// discovery or a local overlay. Three of those four are host state.
//
// This runs the existing --check under deliberately hostile host state and
// requires byte-identical output. Varying the HOST rather than asserting a
// specific mechanism means it also catches a dependency nobody anticipated,
// which a "seed-only mode" flag would not: a flag can be forgotten at a new
// call site, an environment cannot.
//
// The seed itself is NOT varied. It is a committed artefact, so the surface is
// supposed to follow it; that is the point of d1.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TARGET = ["scripts/generate-site-discovery.mjs", "--check"];

/** A config with every optional subsystem switched on, which changes tool registration. */
const HOSTILE_CONFIG = `[persistence]
backend = "none"

[least_cost]
enabled = true

[acp]
enabled = true

[workspaces]
enabled = true

[admin]
allow_mutating_cli_admin_ops = true
`;

export function buildScenarios(sandbox, nodeBinDir) {
  const configPath = join(sandbox, "hostile.toml");
  return [
    { name: "baseline, host as it is", env: {} },
    {
      name: "every subsystem enabled by config",
      env: { LLM_GATEWAY_CONFIG: configPath },
    },
    {
      name: "no provider binaries on PATH",
      env: { PATH: `${nodeBinDir}:/usr/bin:/bin` },
    },
    {
      name: "foreign HOME, so no ~/.llm-cli-gateway",
      env: { HOME: join(sandbox, "home") },
    },
    {
      name: "deprecated env overrides set",
      env: {
        LLM_GATEWAY_JOBS_DB: join(sandbox, "jobs.db"),
        LLM_GATEWAY_LOGS_DB: join(sandbox, "logs.db"),
        LLM_GATEWAY_DEDUP_WINDOW_MS: "1",
        LLM_GATEWAY_JOB_RETENTION_DAYS: "1",
      },
    },
    {
      name: "all of the above at once",
      env: {
        LLM_GATEWAY_CONFIG: configPath,
        PATH: `${nodeBinDir}:/usr/bin:/bin`,
        HOME: join(sandbox, "home"),
        LLM_GATEWAY_JOBS_DB: join(sandbox, "jobs.db"),
        LLM_GATEWAY_LOGS_DB: join(sandbox, "logs.db"),
      },
    },
  ];
}

export function runScenario(scenario, command = TARGET) {
  const result = spawnSync(process.execPath, command, {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...scenario.env },
  });
  return {
    name: scenario.name,
    ok: result.status === 0,
    detail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-3).join(" "),
  };
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "llm-cli-gateway-invariance-"));
  writeFileSync(join(sandbox, "hostile.toml"), HOSTILE_CONFIG);
  const scenarios = buildScenarios(sandbox, dirname(process.execPath));
  const failures = [];
  for (const scenario of scenarios) {
    const result = runScenario(scenario);
    console.log(`  ${result.ok ? "ok  " : "FAIL"}  ${result.name}`);
    if (!result.ok) failures.push(result);
  }
  if (failures.length > 0) {
    console.error(
      `\nthe published tool surface changed with host state, which makes npm run check ` +
        `mean something different on every machine:`
    );
    for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
  console.log(`surface is host-invariant across ${scenarios.length} scenarios`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
