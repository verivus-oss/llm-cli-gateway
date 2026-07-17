#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPublicInternalMcpAliases,
  projectPublicMcpAliases,
} from "./public-site-mcp-policy.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(modulePath), "..");
const siteDir = join(repoRoot, "site");
const fixturePath = join(repoRoot, "site", "tools.fixture.json");
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

const checkOnly = process.argv.includes("--check");
const skipToolsCapture = process.argv.includes("--skip-tools-capture");
const writeFixtureOnly = process.argv.includes("--write-fixture-only");

export function assertCompatibleGenerationModes(options) {
  if (options.checkOnly && options.skipToolsCapture) {
    throw new Error("--check cannot be combined with --skip-tools-capture");
  }
  if (options.checkOnly && options.writeFixtureOnly) {
    throw new Error("--check cannot be combined with --write-fixture-only");
  }
}

function readJson(relPath) {
  return JSON.parse(readFileSync(join(siteDir, relPath), "utf8"));
}

function readText(relPath) {
  return readFileSync(join(siteDir, relPath), "utf8");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function compareDeterministicStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function writeGenerated(relPath, content) {
  const path = join(siteDir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  if (checkOnly) {
    let current;
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
      href: "https://llm-cli-gateway.dev/guides/personal-agent-config-kit.md",
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
        item: entries
          .filter(entry => entry.rel === "item")
          .map(({ href, type }) => ({ href, type })),
      },
    ],
  };
}

function publicSiteVersion(serverCard) {
  const version = serverCard?.version;
  if (typeof version !== "string" || !STABLE_VERSION_RE.test(version)) {
    throw new Error(".well-known/mcp/server-card.json must contain a stable public version");
  }
  return version;
}

function assertFixtureSiteVersion(fixture, expectedSiteVersion) {
  if (typeof fixture?.siteVersion !== "string" || !STABLE_VERSION_RE.test(fixture.siteVersion)) {
    throw new Error("site/tools.fixture.json must contain a stable siteVersion");
  }
  if (fixture.siteVersion !== expectedSiteVersion) {
    throw new Error(
      `site/tools.fixture.json siteVersion ${fixture.siteVersion} does not match the public server card ${expectedSiteVersion}`
    );
  }
}

export async function captureTools(siteVersion) {
  const [
    { createGatewayServer },
    { AsyncJobManager },
    { SqliteJobStore },
    { FileSessionManager },
    { ResourceProvider },
    { PerformanceMetrics },
    { ApprovalManager },
    { defaultLeastCostConfig, DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL },
    { PersonalConfigManager },
  ] = await Promise.all([
    import("../dist/index.js"),
    import("../dist/async-job-manager.js"),
    import("../dist/job-store.js"),
    import("../dist/session-manager.js"),
    import("../dist/resources.js"),
    import("../dist/metrics.js"),
    import("../dist/approval-manager.js"),
    import("../dist/config.js"),
    import("../dist/personal-config.js"),
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
  const captureDir = mkdtempSync(join(tmpdir(), "llm-cli-gateway-site-capture-"));
  const persistence = {
    backend: "sqlite",
    path: join(captureDir, "jobs.db"),
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 60 * 60 * 1000,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: true,
    instanceHeartbeatMs: 15_000,
    instanceLeaseTtlMs: 90_000,
    httpJobGraceMs: 300_000,
    orphanSweepIntervalMs: 30_000,
    instanceGcMs: 3_600_000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
  // This capture defines the public static tool surface. It must never inherit
  // enabled API providers, routing, ACP, Kit, workspace, or approval settings
  // from the workstation that happened to build the site.
  const cacheAwareness = {
    emitAnthropicCacheControl: false,
    anthropicTtlSeconds: 300,
    warnOnTtlExpiry: false,
    minStableTokensForCacheControl: { ...DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL },
    sources: { configFile: null },
  };
  const providers = { xai: null, providers: {}, sources: { configFile: null } };
  const acpConfig = {
    enabled: false,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: 600_000,
    initializeTimeoutMs: 10_000,
    sessionNewTimeoutMs: 10_000,
    promptTimeoutMs: 600_000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    allowMutatingSessionOps: false,
    fallbackToCliWhenUnhealthy: true,
    providers: {},
    sources: { configFile: null },
  };
  const adminConfig = { allowMutatingCliAdminOps: false, sources: { configFile: null } };
  const workspaces = {
    enabled: false,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos: [],
    allowedRoots: [],
    sources: { configFile: null },
  };
  const leastCost = defaultLeastCostConfig();
  const layout = {
    baselineDir: join(captureDir, "baseline"),
    runtimeDir: join(captureDir, "runtime"),
    localTomlPath: join(captureDir, "runtime", "local.toml"),
    statePath: join(captureDir, "runtime", "state.json"),
    releasesDir: join(captureDir, "runtime", "releases"),
    currentPointerPath: join(captureDir, "runtime", "current.json"),
    lockPath: join(captureDir, "runtime", "lock"),
    artifactsDir: join(captureDir, "runtime", "artifacts"),
  };
  const sessionManager = new FileSessionManager(join(captureDir, "sessions.json"), undefined, {
    logger,
  });
  const performanceMetrics = new PerformanceMetrics();
  const approvalManager = new ApprovalManager(join(captureDir, "approvals.jsonl"), logger);
  const personalConfig = new PersonalConfigManager(
    { enabled: false, baselinePath: layout.baselineDir, maxStaleHours: 168 },
    layout
  );
  // Capture the normal durable personal-appliance surface. A memory store would
  // omit validation-run-backed tools such as review_changes from the public
  // inventory even though default SQLite installations register them.
  const jobStore = new SqliteJobStore(persistence.path, logger);
  const asyncJobManager = new AsyncJobManager(logger, undefined, jobStore, flightRecorder);
  const resourceProvider = new ResourceProvider(
    sessionManager,
    performanceMetrics,
    flightRecorder,
    cacheAwareness,
    providers,
    undefined,
    acpConfig,
    leastCost
  );
  const server = createGatewayServer({
    sessionManager,
    resourceProvider,
    performanceMetrics,
    asyncJobManager,
    approvalManager,
    flightRecorder,
    logger,
    persistence,
    cacheAwareness,
    compression: { enabled: false, sources: { configFile: null } },
    providers,
    acpConfig,
    adminConfig,
    workspaces,
    leastCost,
    personalConfig,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "site-tool-capture", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const fixture = {
      generatedAt: "deterministic build output",
      packageName: pkg.name,
      packageVersion: pkg.version,
      // This distinguishes the current checkout used for the runtime capture
      // from the version represented by the public Pages site. During RC work,
      // Pages deliberately remains on the last stable npm latest release.
      siteVersion,
      captureCommand: "node scripts/generate-site-discovery.mjs",
      source: "runtime MCP tools/list from dist/index.js over in-memory MCP transport",
      toolCount: result.tools.length,
      tools: result.tools
        .map(tool => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
        }))
        .map(projectPublicMcpAliases)
        .sort((a, b) => compareDeterministicStrings(a.name, b.name)),
    };
    assertNoPublicInternalMcpAliases(fixture, "runtime-derived public tools fixture");
    return fixture;
  } catch (error) {
    throw new Error(`Failed to capture runtime MCP tools/list: ${error.message}`, {
      cause: error,
    });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await asyncJobManager.dispose({ timeoutMs: 1000 }).catch(() => {});
    jobStore.close();
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function readFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function renderServerCard(serverCard, fixture) {
  if (!serverCard || typeof serverCard !== "object" || Array.isArray(serverCard)) {
    throw new Error(".well-known/mcp/server-card.json must contain an object");
  }
  if (!Array.isArray(fixture.tools) || fixture.tools.some(tool => typeof tool?.name !== "string")) {
    throw new Error("site/tools.fixture.json must contain named runtime MCP tools");
  }
  assertNoPublicInternalMcpAliases(fixture, "site/tools.fixture.json");
  return stableJson({
    ...serverCard,
    // Keep the compact server card from becoming a stale, partial tool list.
    // The descriptive metadata remains authored here; the tool names come from
    // the same runtime tools/list capture that produces tools.md.
    tools: fixture.tools.map(tool => tool.name),
  });
}

function groupTool(name) {
  if (name.startsWith("api_")) return "Configured API providers";
  if (
    name.endsWith("_request") ||
    name.endsWith("_request_async") ||
    name === "codex_fork_session"
  ) {
    return "Provider requests";
  }
  if (name.startsWith("llm_job_") || name === "llm_request_result") return "Async jobs";
  if (name.startsWith("session_")) return "Sessions";
  if (name.startsWith("workspace_")) return "Workspaces";
  if (
    [
      "review_changes",
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

export function renderToolsMarkdown(fixture) {
  if (typeof fixture?.siteVersion !== "string" || !STABLE_VERSION_RE.test(fixture.siteVersion)) {
    throw new Error("site/tools.fixture.json must contain a stable siteVersion");
  }
  assertNoPublicInternalMcpAliases(fixture, "site/tools.fixture.json");
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
    `- Public site version: \`${fixture.siteVersion}\``,
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
  assertCompatibleGenerationModes({ checkOnly, skipToolsCapture, writeFixtureOnly });
  readJson(".well-known/agent.json");
  const serverCard = readJson(".well-known/mcp/server-card.json");
  const siteVersion = publicSiteVersion(serverCard);
  const catalog = buildCatalog();

  writeGenerated("agent.json", readText(".well-known/agent.json"));
  writeGenerated(".well-known/api-catalog", stableJson(catalog));
  writeGenerated(".well-known/ai-catalog.json", stableJson(catalog));

  let fixture;
  if (skipToolsCapture) {
    fixture = readFixture();
  } else {
    fixture = await captureTools(siteVersion);
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
  assertFixtureSiteVersion(fixture, siteVersion);
  assertNoPublicInternalMcpAliases(fixture, "site/tools.fixture.json");

  const serverCardContent = renderServerCard(serverCard, fixture);
  writeGenerated(".well-known/mcp/server-card.json", serverCardContent);
  writeGenerated(".well-known/mcp.json", serverCardContent);

  if (!writeFixtureOnly) {
    writeGenerated("tools.md", renderToolsMarkdown(fixture));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
