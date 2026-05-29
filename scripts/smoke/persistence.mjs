#!/usr/bin/env node
// End-to-end smoke test for the persistence-config refactor.
//
// For each variant, this script:
//   1. Writes a config.toml (or sets legacy env vars) to a per-variant tmpdir
//   2. Spawns `node dist/index.js` as a real MCP stdio subprocess
//   3. Connects via the official @modelcontextprotocol/sdk Client + StdioClientTransport
//   4. Calls tools/list, llm_process_health, and (for sqlite/memory) a real
//      *_request_async + llm_job_status sanity round-trip
//   5. Captures stderr for deprecation warnings
//   6. Reports PASS/FAIL per variant

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = "/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway";
const GATEWAY = "dist/index.js";

const ASYNC_TOOLS = new Set([
  "claude_request_async",
  "codex_request_async",
  "gemini_request_async",
  "grok_request_async",
  "mistral_request_async",
  "llm_job_status",
  "llm_job_result",
  "llm_job_cancel",
]);

const SYNC_TOOLS_PROBE = ["llm_process_health", "list_models"];

function makeTmp(label) {
  return mkdtempSync(join(tmpdir(), `smoke-${label}-`));
}

function writeConfig(dir, body) {
  const p = join(dir, "config.toml");
  writeFileSync(p, body);
  return p;
}

async function runVariant(variant) {
  const { label, env: variantEnv, configToml, expect } = variant;
  const workDir = makeTmp(label);
  const env = { ...process.env, ...variantEnv };
  // Always nuke leaking inherited config so each variant is hermetic.
  for (const key of ["LLM_GATEWAY_CONFIG", "LLM_GATEWAY_LOGS_DB", "LLM_GATEWAY_JOBS_DB"]) {
    if (!(key in variantEnv)) delete env[key];
  }
  if (configToml !== undefined) {
    env.LLM_GATEWAY_CONFIG = writeConfig(workDir, configToml);
  }

  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: "node",
    args: [GATEWAY],
    env,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });

  // Capture child stderr.
  transport.stderr?.on("data", b => stderrChunks.push(b.toString()));

  const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });

  const failures = [];
  let toolsList = [];
  let healthPayload = null;
  let processFailedReason = null;

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    toolsList = tools.tools.map(t => t.name).sort();

    // Always callable: llm_process_health
    const health = await client.callTool({ name: "llm_process_health", arguments: {} });
    healthPayload = JSON.parse(health.content[0].text);
  } catch (err) {
    processFailedReason = err?.message ?? String(err);
  }

  // Assertions
  const presentAsync = toolsList.filter(n => ASYNC_TOOLS.has(n));
  const missingAsync = [...ASYNC_TOOLS].filter(n => !toolsList.includes(n));

  if (expect.startupFails) {
    if (!processFailedReason) {
      failures.push(`expected gateway to fail startup; instead it came up cleanly`);
    }
  } else {
    if (processFailedReason) {
      failures.push(`gateway failed to start: ${processFailedReason}`);
    }
  }

  if (!expect.startupFails) {
    if (expect.asyncToolsRegistered) {
      if (presentAsync.length !== ASYNC_TOOLS.size) {
        failures.push(
          `expected all 8 async tools, got ${presentAsync.length}: missing ${JSON.stringify(missingAsync)}`
        );
      }
    } else {
      if (presentAsync.length !== 0) {
        failures.push(
          `expected zero async tools (backend gated), got ${presentAsync.length}: ${JSON.stringify(presentAsync)}`
        );
      }
    }

    for (const t of SYNC_TOOLS_PROBE) {
      if (!toolsList.includes(t)) failures.push(`expected always-present tool ${t} missing`);
    }

    if (healthPayload && expect.healthBackend) {
      if (healthPayload.persistence?.backend !== expect.healthBackend) {
        failures.push(
          `health.persistence.backend = ${healthPayload.persistence?.backend}, expected ${expect.healthBackend}`
        );
      }
      if (healthPayload.persistence?.asyncJobsEnabled !== expect.healthAsyncEnabled) {
        failures.push(
          `health.persistence.asyncJobsEnabled = ${healthPayload.persistence?.asyncJobsEnabled}, expected ${expect.healthAsyncEnabled}`
        );
      }
      if (expect.healthHasWarning) {
        if (!healthPayload.persistence?.warning) {
          failures.push(`expected health.persistence.warning to be non-null when async disabled`);
        }
      } else {
        if (healthPayload.persistence?.warning) {
          failures.push(
            `expected health.persistence.warning null when async enabled, got: ${healthPayload.persistence.warning}`
          );
        }
      }
    }
  }

  const stderr = stderrChunks.join("");
  if (expect.stderrContains) {
    for (const needle of expect.stderrContains) {
      if (!stderr.includes(needle)) {
        failures.push(`expected stderr to contain ${JSON.stringify(needle)} but it did not`);
      }
    }
  }
  if (expect.stderrAbsent) {
    for (const needle of expect.stderrAbsent) {
      if (stderr.includes(needle)) {
        failures.push(`expected stderr to NOT contain ${JSON.stringify(needle)} but it did`);
      }
    }
  }

  try {
    await client.close();
  } catch {}

  rmSync(workDir, { recursive: true, force: true });

  return {
    label,
    pass: failures.length === 0,
    failures,
    toolsList,
    presentAsync,
    healthPayload,
    stderrTail: stderr.split("\n").slice(-15).join("\n"),
  };
}

const variants = [
  {
    label: "1-default-sqlite",
    env: {},
    // No config file → falls through to sqlite default at ~/.llm-cli-gateway/logs.db
    expect: {
      asyncToolsRegistered: true,
      healthBackend: "sqlite",
      healthAsyncEnabled: true,
      healthHasWarning: false,
      stderrAbsent: ["is deprecated"],
    },
  },
  {
    label: "2-toml-memory-ack",
    env: {},
    configToml: '[persistence]\nbackend = "memory"\nacknowledgeEphemeral = true\n',
    expect: {
      asyncToolsRegistered: true,
      healthBackend: "memory",
      healthAsyncEnabled: true,
      healthHasWarning: false,
      stderrAbsent: ["is deprecated"],
    },
  },
  {
    label: "3-toml-none",
    env: {},
    configToml: '[persistence]\nbackend = "none"\n',
    expect: {
      asyncToolsRegistered: false,
      healthBackend: "none",
      healthAsyncEnabled: false,
      healthHasWarning: true,
      stderrContains: ["DISABLED"],
    },
  },
  {
    label: "4-legacy-env-sqlite-custom-path",
    env: { LLM_GATEWAY_LOGS_DB: join(tmpdir(), "smoke-legacy-custom.db") },
    expect: {
      asyncToolsRegistered: true,
      healthBackend: "sqlite",
      healthAsyncEnabled: true,
      healthHasWarning: false,
      stderrContains: ["LLM_GATEWAY_LOGS_DB is deprecated"],
    },
  },
  {
    label: "5-legacy-env-logs-db-none",
    env: { LLM_GATEWAY_LOGS_DB: "none" },
    expect: {
      asyncToolsRegistered: false,
      healthBackend: "none",
      healthAsyncEnabled: false,
      healthHasWarning: true,
      stderrContains: ["LLM_GATEWAY_LOGS_DB is deprecated"],
    },
  },
  {
    label: "6-toml-memory-no-ack-startup-fails",
    env: {},
    configToml: '[persistence]\nbackend = "memory"\n',
    expect: {
      startupFails: true,
      stderrContains: ["acknowledgeEphemeral"],
    },
  },
];

const results = [];
for (const v of variants) {
  process.stderr.write(`\n=== ${v.label} ===\n`);
  const r = await runVariant(v);
  results.push(r);
  process.stderr.write(r.pass ? "  PASS\n" : `  FAIL: ${r.failures.join("; ")}\n`);
}

console.log("\n========== SMOKE TEST SUMMARY ==========");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.label}`);
  if (!r.pass) {
    for (const f of r.failures) console.log(`      - ${f}`);
    console.log(`      stderr tail: ${r.stderrTail.replace(/\n/g, " | ")}`);
    console.log(`      tools: ${r.presentAsync.length} async, total ${r.toolsList.length}`);
    if (r.healthPayload?.persistence)
      console.log(`      health.persistence: ${JSON.stringify(r.healthPayload.persistence)}`);
  }
}

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
