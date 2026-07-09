#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(repoRoot, "site");
const fixturePath = join(repoRoot, "site", "tools.fixture.json");
const toolsPath = join(repoRoot, "site", "tools.md");

const checkOnly = process.argv.includes("--check");
const skipToolsCapture = process.argv.includes("--skip-tools-capture");
const writeFixtureOnly = process.argv.includes("--write-fixture-only");

function readJson(relPath) {
  return JSON.parse(readFileSync(join(siteDir, relPath), "utf8"));
}

function readText(relPath) {
  return readFileSync(join(siteDir, relPath), "utf8");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeGenerated(relPath, content) {
  const path = join(siteDir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  if (checkOnly) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      throw new Error(`${relPath} is missing; run node scripts/generate-site-discovery.mjs`);
    }
    if (current !== content) {
      throw new Error(`${relPath} is out of date; run node scripts/generate-site-discovery.mjs`);
    }
    return;
  }
  writeFileSync(path, content);
}

function buildCatalog() {
  const entries = [
    {
      href: "https://llm-cli-gateway.dev/install.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/docs",
      rel: "service-doc",
      type: "text/html",
    },
    {
      href: "https://llm-cli-gateway.dev/api",
      rel: "service-doc",
      type: "text/html",
    },
    {
      href: "https://llm-cli-gateway.dev/developers",
      rel: "service-doc",
      type: "text/html",
    },
    {
      href: "https://llm-cli-gateway.dev/openapi.json",
      rel: "service-desc",
      type: "application/vnd.oai.openapi+json",
    },
    {
      href: "https://llm-cli-gateway.dev/agents.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/tools.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/guides/coding-agent-gateway-technical-guide.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/workflows/cross-model-review.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/llms.txt",
      rel: "service-doc",
      type: "text/plain",
    },
    {
      href: "https://llm-cli-gateway.dev/DISCOVERY.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/sitemap.md",
      rel: "service-doc",
      type: "text/markdown",
    },
    {
      href: "https://llm-cli-gateway.dev/.well-known/agent.json",
      rel: "describedby",
      type: "application/json",
    },
    {
      href: "https://llm-cli-gateway.dev/.well-known/integrations.json",
      rel: "describedby",
      type: "application/json",
    },
    {
      href: "https://llm-cli-gateway.dev/.well-known/mcp/server-card.json",
      rel: "service-desc",
      type: "application/json",
    },
    {
      href: "https://github.com/verivus-oss/llm-cli-gateway",
      rel: "service-doc",
      type: "text/html",
    },
    {
      href: "http://127.0.0.1:3333/mcp",
      rel: "item",
      type: "application/json",
    },
    {
      href: "https://llm-cli-gateway.dev/openapi.json",
      rel: "item",
      type: "application/vnd.oai.openapi+json",
    },
  ];

  return {
    linkset: [
      {
        anchor: "https://llm-cli-gateway.dev",
        "service-doc": entries
          .filter(entry => entry.rel === "service-doc")
          .map(({ href, type }) => ({ href, type })),
        describedby: entries
          .filter(entry => entry.rel === "describedby")
          .map(({ href, type }) => ({ href, type })),
        "service-desc": entries
          .filter(entry => entry.rel === "service-desc")
          .map(({ href, type }) => ({ href, type })),
        item: entries.filter(entry => entry.rel === "item").map(({ href, type }) => ({ href, type })),
      },
    ],
  };
}

async function captureTools() {
  const [{ createGatewayServer }, { AsyncJobManager }, { MemoryJobStore }] = await Promise.all([
    import("../dist/index.js"),
    import("../dist/async-job-manager.js"),
    import("../dist/job-store.js"),
  ]);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const flightRecorder = {
    logStart() {},
    logComplete() {},
    queryRequests() {
      return [];
    },
    flush() {},
    close() {},
  };
  const persistence = {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 60 * 60 * 1000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15_000,
    instanceLeaseTtlMs: 90_000,
    httpJobGraceMs: 300_000,
    orphanSweepIntervalMs: 30_000,
    instanceGcMs: 3_600_000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
  const asyncJobManager = new AsyncJobManager(
    logger,
    undefined,
    new MemoryJobStore(),
    flightRecorder
  );
  const server = createGatewayServer({
    asyncJobManager,
    flightRecorder,
    logger,
    persistence,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "site-tool-capture", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return {
      generatedAt: "deterministic build output",
      packageName: pkg.name,
      packageVersion: pkg.version,
      captureCommand: "node scripts/generate-site-discovery.mjs",
      source: "runtime MCP tools/list from dist/index.js over in-memory MCP transport",
      toolCount: result.tools.length,
      tools: result.tools
        .map(tool => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    throw new Error(`Failed to capture runtime MCP tools/list: ${error.message}`);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await asyncJobManager.dispose({ timeoutMs: 1000 }).catch(() => {});
  }
}

function readFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function groupTool(name) {
  if (name.startsWith("api_")) return "Configured API providers";
  if (name.endsWith("_request") || name.endsWith("_request_async") || name === "codex_fork_session") {
    return "Provider requests";
  }
  if (name.startsWith("llm_job_") || name === "llm_request_result") return "Async jobs";
  if (name.startsWith("session_")) return "Sessions";
  if (name.startsWith("workspace_")) return "Workspaces";
  if (
    [
      "validate_with_models",
      "second_opinion",
      "compare_answers",
      "red_team_review",
      "consensus_check",
      "ask_model",
      "synthesize_validation",
      "list_available_models",
      "job_status",
      "job_result",
      "validation_receipt",
    ].includes(name)
  ) {
    return "Validation and review";
  }
  if (name.startsWith("provider_subcommands_") || name.startsWith("provider_")) {
    return "Provider introspection";
  }
  return "Operations";
}

function renderToolsMarkdown(fixture) {
  const groups = new Map();
  for (const tool of fixture.tools) {
    const group = groupTool(tool.name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(tool);
  }

  const order = [
    "Provider requests",
    "Configured API providers",
    "Async jobs",
    "Sessions",
    "Validation and review",
    "Workspaces",
    "Provider introspection",
    "Operations",
  ];

  const lines = [
    "# llm-cli-gateway tools",
    "",
    "> Runtime-derived public MCP tool index for llm-cli-gateway.",
    "",
    "This file is generated from the gateway's actual MCP `tools/list` response, not from source-code pattern matching. Update it with:",
    "",
    "```bash",
    "npm run site:generate",
    "```",
    "",
    `- Package: \`${fixture.packageName}@${fixture.packageVersion}\``,
    `- Tool count: ${fixture.toolCount}`,
    `- Source: ${fixture.source}`,
    `- Capture command: \`${fixture.captureCommand}\``,
    `- Generated at: ${fixture.generatedAt}`,
    "",
  ];

  for (const group of order) {
    const tools = groups.get(group);
    if (!tools || tools.length === 0) continue;
    lines.push(`## ${group}`, "");
    for (const tool of tools) {
      const description = tool.description.replace(/\s+/g, " ").trim() || "No description exposed.";
      lines.push(`- \`${tool.name}\` - ${description}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function main() {
  readJson(".well-known/agent.json");
  readJson(".well-known/mcp/server-card.json");
  const catalog = buildCatalog();

  writeGenerated("agent.json", readText(".well-known/agent.json"));
  writeGenerated(".well-known/mcp.json", readText(".well-known/mcp/server-card.json"));
  writeGenerated(".well-known/api-catalog", stableJson(catalog));
  writeGenerated(".well-known/ai-catalog.json", stableJson(catalog));

  let fixture;
  if (skipToolsCapture) {
    fixture = readFixture();
  } else {
    fixture = await captureTools();
    const fixtureContent = stableJson(fixture);
    if (checkOnly) {
      const current = readFileSync(fixturePath, "utf8");
      if (current !== fixtureContent) {
        throw new Error(
          `${relative(repoRoot, fixturePath)} is out of date; run node scripts/generate-site-discovery.mjs`
        );
      }
    } else {
      writeFileSync(fixturePath, fixtureContent);
    }
  }

  if (!writeFixtureOnly) {
    writeGenerated("tools.md", renderToolsMarkdown(fixture));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
