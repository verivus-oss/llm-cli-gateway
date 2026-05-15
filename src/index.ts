#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { readFileSync, readdirSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { executeCli, killAllProcessGroups } from "./executor.js";
import { parseStreamJson } from "./stream-json-parser.js";
import { ISessionManager, createSessionManager } from "./session-manager.js";
import { ResourceProvider } from "./resources.js";
import { PerformanceMetrics } from "./metrics.js";
import {
  estimateTokens,
  optimizePrompt as optimizePromptText,
  optimizeResponse as optimizeResponseText,
} from "./optimizer.js";
import { loadConfig } from "./config.js";
import { DatabaseConnection } from "./db.js";
import { checkHealth } from "./health.js";
import { getCliInfo, resolveModelAlias } from "./model-registry.js";
import { AsyncJobManager } from "./async-job-manager.js";
import { JobStore, resolveJobStoreDbPath } from "./job-store.js";
import { ApprovalManager, ApprovalPolicy, ApprovalRecord } from "./approval-manager.js";
import { checkReviewIntegrity, ReviewIntegrityResult } from "./review-integrity.js";
import {
  buildClaudeMcpConfig,
  ClaudeMcpConfigResult,
  ClaudeMcpServerName,
  CLAUDE_MCP_SERVER_NAMES,
} from "./claude-mcp-config.js";
import {
  resolveSessionResumeArgs,
  resolveGrokSessionArgs,
  resolveCodexSessionArgs,
  sanitizeCliArgValues,
  GATEWAY_SESSION_PREFIX,
} from "./request-helpers.js";
import { createFlightRecorder, FlightRecorderLike } from "./flight-recorder.js";
import { getCliVersions, runCliUpgrade } from "./cli-updater.js";

type ExtendedToolResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  sessionId?: string;
  resumable?: boolean;
  structuredContent?: Record<string, unknown>;
  approval?: ApprovalRecord | null;
  mcpServers?: {
    requested: ClaudeMcpServerName[];
    enabled?: ClaudeMcpServerName[];
    missing?: ClaudeMcpServerName[];
  };
  reviewIntegrity?: ReviewIntegrityResult;
};

// Simple logger that writes to stderr (stdout is used for MCP protocol)
const logger = {
  info: (message: string, ...args: any[]) => {
    console.error(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.error(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
};

function logOptimizationTokens(
  kind: "prompt" | "response",
  correlationId: string,
  original: string,
  optimized: string
) {
  const originalTokens = estimateTokens(original);
  const optimizedTokens = estimateTokens(optimized);
  const reduction =
    originalTokens === 0 ? 0 : ((originalTokens - optimizedTokens) / originalTokens) * 100;
  logger.info(
    `[${correlationId}] ${kind} tokens ${originalTokens} → ${optimizedTokens} (${reduction.toFixed(1)}% reduction)`
  );
}

// Sync-to-async deadline: if a sync tool's CLI call hasn't finished within this
// window, the tool returns a deferred async job reference instead of blocking
// until the MCP client's tool-call timeout fires (~60s in many runtimes).
// Configurable via SYNC_DEADLINE_MS env var. Set to 0 to disable (pure sync).
const SYNC_DEADLINE_MS = (() => {
  const env = process.env.SYNC_DEADLINE_MS;
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 45_000; // 45s default — safely under the 60s MCP client cap
})();

//──────────────────────────────────────────────────────────────────────────────
// Skills loader — reads .agents/skills/*/SKILL.md at startup
//──────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, "..", ".agents", "skills");

interface SkillEntry {
  name: string;
  content: string;
  description: string;
}

function loadSkills(): SkillEntry[] {
  const skills: SkillEntry[] = [];
  try {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const skillPath = join(SKILLS_DIR, dir.name, "SKILL.md");
      try {
        const content = readFileSync(skillPath, "utf-8");
        // Extract description from YAML frontmatter
        const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m);
        const description = descMatch?.[1]?.trim() || dir.name;
        skills.push({ name: dir.name, content, description });
      } catch {
        // Skill file missing or unreadable — skip silently
      }
    }
  } catch {
    // Skills directory missing — not fatal
  }
  return skills;
}

const loadedSkills = loadSkills();

// L1: Compact server instructions (~200 tokens) — injected into every client's
// system prompt at connection time. Covers key patterns + pointers to L2 resources.
const SERVER_INSTRUCTIONS = `llm-cli-gateway: Multi-LLM orchestration via MCP.

Tools: claude_request, codex_request, gemini_request, grok_request (sync) | *_request_async (async)
Jobs: llm_job_status, llm_job_result, llm_job_cancel
Sessions: session_create, session_list, session_set_active, session_get, session_delete, session_clear_all
Other: list_models, cli_versions, cli_upgrade, approval_list, llm_process_health

Key behaviors:
- Sync auto-defers at ${SYNC_DEADLINE_MS}ms. Poll deferred jobs via llm_job_status/llm_job_result.
- Sessions: Claude --continue, Gemini --resume, Grok --resume/--continue, Codex \`exec resume <ID>\` / \`exec resume --last\` (all real CLI continuity). For Codex, sessionId must be a real Codex UUID (from ~/.codex/sessions/); gateway-generated gw-* IDs are rejected.
- Approval gates: opt-in via approvalStrategy:"mcp_managed".
- Idle timeout kills stuck processes (default 10min, configurable via idleTimeoutMs).

Skills (full docs via MCP resources):
${loadedSkills.map(s => `- skills://${s.name} — ${s.description}`).join("\n")}`;

const server = new McpServer(
  { name: "llm-cli-gateway", version: "1.0.0" },
  { instructions: SERVER_INSTRUCTIONS }
);

// Global state (initialized asynchronously)
let sessionManager: ISessionManager;
let db: DatabaseConnection | null = null;
const performanceMetrics = new PerformanceMetrics();
let resourceProvider: ResourceProvider;
const flightRecorder: FlightRecorderLike = createFlightRecorder(logger);

// Durable job store: persists every async job to ~/.llm-cli-gateway/logs.db so callers
// can collect results across long polling gaps and gateway restarts, and so repeated
// identical requests dedup onto the running/completed job instead of starting over.
const jobStore: JobStore | null = (() => {
  const dbPath = resolveJobStoreDbPath();
  if (!dbPath) {
    logger.info("Durable job store disabled (LLM_GATEWAY_LOGS_DB=none)");
    return null;
  }
  try {
    return new JobStore(dbPath, logger);
  } catch (err) {
    logger.error("Failed to open durable job store; continuing in-memory only", err);
    return null;
  }
})();

const asyncJobManager = new AsyncJobManager(
  logger,
  (cli, durationMs, success) => {
    performanceMetrics.recordRequest(cli, durationMs, success);
  },
  jobStore
);
const approvalManager = new ApprovalManager(undefined, logger);
const MCP_SERVER_ENUM = z.enum(CLAUDE_MCP_SERVER_NAMES);

// Per-CLI idle timeouts: kill process if no stdout/stderr activity for this duration.
// Claude idle timeout only applies in stream-json mode (with --include-partial-messages).
// In text/json mode, Claude produces no output until done, so idle timeout would false-positive.
const CLI_IDLE_TIMEOUTS: Record<string, number | undefined> = {
  claude: 600_000, // 10 minutes — only used when outputFormat=stream-json
  codex: 600_000, // 10 minutes — Codex streams stderr progress
  gemini: 600_000, // 10 minutes — Gemini streams stdout in real-time
  grok: 600_000, // 10 minutes — Grok streams stderr/stdout activity in headless mode
};

function resolveIdleTimeout(cli: string, override?: number): number | undefined {
  if (override !== undefined) return override;
  return CLI_IDLE_TIMEOUTS[cli];
}

const SYNC_POLL_INTERVAL_MS = 1_000;

interface DeferredJobResponse {
  deferred: true;
  jobId: string;
  cli: string;
  correlationId: string;
  message: string;
}

/**
 * Start an async job and poll until completion or deadline.
 * Returns the job result if it finishes in time, or a deferral marker.
 */
async function awaitJobOrDefer(
  cli: "claude" | "codex" | "gemini" | "grok",
  args: string[],
  corrId: string,
  idleTimeoutMs?: number,
  outputFormat?: string,
  forceRefresh?: boolean
): Promise<{ stdout: string; stderr: string; code: number } | DeferredJobResponse> {
  if (SYNC_DEADLINE_MS === 0) {
    // Disabled — fall through to direct execution.
    // Note: direct execution bypasses dedup. forceRefresh is implied.
    return executeCli(cli, args, { idleTimeout: idleTimeoutMs, logger });
  }

  const outcome = asyncJobManager.startJobWithDedup(cli, args, corrId, { idleTimeoutMs, outputFormat, forceRefresh });
  const job = outcome.snapshot;
  if (outcome.deduped) {
    logger.info(`[${corrId}] sync request deduped onto running job ${job.id} (original corrId=${outcome.originalCorrelationId})`);
  }
  const deadline = Date.now() + SYNC_DEADLINE_MS;

  while (Date.now() < deadline) {
    const snapshot = asyncJobManager.getJobSnapshot(job.id);
    if (snapshot && snapshot.status !== "running") {
      // Job finished within deadline — extract result
      const result = asyncJobManager.getJobResult(job.id);
      if (!result) {
        return { stdout: "", stderr: "Job result unavailable", code: 1 };
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode ?? 1,
      };
    }
    await new Promise(resolve => setTimeout(resolve, SYNC_POLL_INTERVAL_MS));
  }

  // Deadline exceeded — return deferral
  logger.info(
    `[${corrId}] ${cli} sync deadline exceeded (${SYNC_DEADLINE_MS}ms), deferring to async job ${job.id}`
  );
  return {
    deferred: true,
    jobId: job.id,
    cli,
    correlationId: corrId,
    message: `Execution exceeded sync deadline (${SYNC_DEADLINE_MS}ms). Poll with llm_job_status, fetch with llm_job_result.`,
  };
}

function isDeferredResponse(
  result: { stdout: string; stderr: string; code: number } | DeferredJobResponse
): result is DeferredJobResponse {
  return "deferred" in result && result.deferred === true;
}

function buildDeferredToolResponse(
  deferred: DeferredJobResponse,
  sessionId?: string
): ExtendedToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "deferred",
            jobId: deferred.jobId,
            cli: deferred.cli,
            correlationId: deferred.correlationId,
            message: deferred.message,
            sessionId: sessionId || null,
            pollWith: "llm_job_status",
            fetchWith: "llm_job_result",
            cancelWith: "llm_job_cancel",
          },
          null,
          2
        ),
      },
    ],
  };
}

// Helper function for standardized error responses
function createErrorResponse(
  cli: string,
  code: number,
  stderr: string,
  correlationId?: string,
  error?: Error
) {
  let errorMessage = `Error executing ${cli} CLI`;

  if (error) {
    // Command not found or spawn error
    errorMessage += `:\n${error.message}`;
    if (error.message.includes("ENOENT")) {
      errorMessage += `\n\nThe '${cli}' command was not found. Please ensure ${cli} CLI is installed and in your PATH.`;
    }
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI execution failed:`, error.message);
  } else if (code === 124) {
    // Wall-clock timeout
    errorMessage += `: Command timed out\n${stderr}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI timed out`);
  } else if (code === 125) {
    // Idle timeout (stuck process)
    errorMessage += `: Process killed due to inactivity\n${stderr}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI killed due to inactivity`);
  } else if (code !== 0) {
    // Other non-zero exit code
    errorMessage += ` (exit code ${code}):\n${stderr}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI failed with exit code ${code}`);
  }

  return {
    content: [{ type: "text" as const, text: errorMessage }],
    isError: true,
    structuredContent: {
      correlationId: correlationId || null,
      cli,
      exitCode: code,
      errorCategory:
        code === 124
          ? "timeout"
          : code === 125
            ? "idle_timeout"
            : error
              ? "spawn_error"
              : "cli_error",
    },
  };
}

function extractUsageAndCost(
  cli: "claude" | "codex" | "gemini" | "grok",
  output: string,
  outputFormat?: string
): {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
} {
  if (cli === "claude" && outputFormat === "stream-json") {
    const parsed = parseStreamJson(output);
    return {
      inputTokens: parsed.usage?.inputTokens,
      outputTokens: parsed.usage?.outputTokens,
      costUsd: parsed.costUsd ?? undefined,
    };
  }
  return {};
}

function safeFlightStart(entry: Parameters<FlightRecorderLike["logStart"]>[0]): void {
  try {
    flightRecorder.logStart(entry);
  } catch (error) {
    logger.error("Flight recorder logStart failed", error);
  }
}

function safeFlightComplete(
  correlationId: string,
  result: Parameters<FlightRecorderLike["logComplete"]>[1]
): void {
  try {
    flightRecorder.logComplete(correlationId, result);
  } catch (error) {
    logger.error("Flight recorder logComplete failed", error);
  }
}

function createApprovalDeniedResponse(
  operation: string,
  decision: ReturnType<ApprovalManager["decide"]>
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: `${operation} denied by MCP-managed approval policy`,
            approval: decision,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function normalizeMcpServers(mcpServers?: ClaudeMcpServerName[]): ClaudeMcpServerName[] {
  if (!mcpServers || mcpServers.length === 0) {
    return ["sqry"];
  }
  return [...new Set(mcpServers)];
}

function createMcpConfigErrorResponse(
  operation: string,
  correlationId: string,
  requested: ClaudeMcpServerName[],
  message: string,
  missing: ClaudeMcpServerName[] = []
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: `${operation} failed to prepare Claude MCP config`,
            message,
            correlationId,
            mcpServers: {
              requested,
              missing,
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function resolveClaudeMcpConfig(
  operation: string,
  correlationId: string,
  requestedMcpServers: ClaudeMcpServerName[],
  strictMcpConfig: boolean
):
  | { config: ClaudeMcpConfigResult }
  | { errorResponse: ReturnType<typeof createMcpConfigErrorResponse> } {
  let mcpConfig: ClaudeMcpConfigResult;
  try {
    mcpConfig = buildClaudeMcpConfig(requestedMcpServers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${correlationId}] ${operation} failed to build Claude MCP config: ${message}`);
    return {
      errorResponse: createMcpConfigErrorResponse(
        operation,
        correlationId,
        requestedMcpServers,
        message
      ),
    };
  }

  if (strictMcpConfig && mcpConfig.missing.length > 0) {
    const missing = mcpConfig.missing.join(", ");
    return {
      errorResponse: createMcpConfigErrorResponse(
        operation,
        correlationId,
        requestedMcpServers,
        `strictMcpConfig=true but requested servers are unavailable: ${missing}`,
        mcpConfig.missing
      ),
    };
  }

  return { config: mcpConfig };
}

//──────────────────────────────────────────────────────────────────────────────
// MCP Resources
//──────────────────────────────────────────────────────────────────────────────

// Register skill resources (L2: full docs, read on demand)
for (const skill of loadedSkills) {
  server.registerResource(
    `skill-${skill.name}`,
    `skills://${skill.name}`,
    {
      title: skill.name,
      description: skill.description,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: `skills://${skill.name}`,
          mimeType: "text/markdown",
          text: skill.content,
        },
      ],
    })
  );
}
logger.info(`Registered ${loadedSkills.length} skill resources`);

// Register all sessions resource
server.registerResource(
  "all-sessions",
  "sessions://all",
  {
    title: "📋 All Sessions",
    description: "All conversation sessions across CLIs",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading all sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Claude sessions resource
server.registerResource(
  "claude-sessions",
  "sessions://claude",
  {
    title: "🤖 Claude Sessions",
    description: "Claude conversation sessions",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Claude sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Codex sessions resource
server.registerResource(
  "codex-sessions",
  "sessions://codex",
  {
    title: "💻 Codex Sessions",
    description: "Codex conversation sessions",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Codex sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Gemini sessions resource
server.registerResource(
  "gemini-sessions",
  "sessions://gemini",
  {
    title: "✨ Gemini Sessions",
    description: "Gemini conversation sessions",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Gemini sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Grok sessions resource
server.registerResource(
  "grok-sessions",
  "sessions://grok",
  {
    title: "⚡ Grok Sessions",
    description: "Grok conversation sessions",
    mimeType: "application/json"
  },
  async (uri) => {
    logger.debug("Reading Grok sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Claude models resource
server.registerResource(
  "claude-models",
  "models://claude",
  {
    title: "🧠 Claude Models",
    description: "Claude models and capabilities",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Claude models resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Codex models resource
server.registerResource(
  "codex-models",
  "models://codex",
  {
    title: "🔧 Codex Models",
    description: "Codex models and capabilities",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Codex models resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Gemini models resource
server.registerResource(
  "gemini-models",
  "models://gemini",
  {
    title: "🌟 Gemini Models",
    description: "Gemini models and capabilities",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading Gemini models resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Grok models resource
server.registerResource(
  "grok-models",
  "models://grok",
  {
    title: "⚡ Grok Models",
    description: "Grok models and capabilities",
    mimeType: "application/json"
  },
  async (uri) => {
    logger.debug("Reading Grok models resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register performance metrics resource
server.registerResource(
  "performance-metrics",
  "metrics://performance",
  {
    title: "📈 Performance Metrics",
    description: "Request counts, latency, success/failure rates",
    mimeType: "application/json",
  },
  async uri => {
    logger.debug("Reading performance metrics resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// DRY Helpers: per-CLI request preparation + response construction
//──────────────────────────────────────────────────────────────────────────────

interface CliRequestPrep {
  corrId: string;
  effectivePrompt: string;
  resolvedModel: string | undefined;
  requestedMcpServers: ClaudeMcpServerName[];
  mcpConfig?: ClaudeMcpConfigResult;
  approvalDecision: ApprovalRecord | null;
  reviewIntegrity?: ReviewIntegrityResult;
  args: string[];
}

function prepareClaudeRequest(params: {
  prompt: string;
  model?: string;
  outputFormat: "text" | "json" | "stream-json";
  allowedTools?: string[];
  disallowedTools?: string[];
  dangerouslySkipPermissions: boolean;
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  mcpServers?: ClaudeMcpServerName[];
  strictMcpConfig: boolean;
  correlationId?: string;
  optimizePrompt: boolean;
  operation: string;
}): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("claude", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: params.prompt,
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
  });
  if (reviewIntegrity.violations.length > 0) {
    logger.info(
      `[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`,
      {
        cli: "claude",
        operation: params.operation,
        score: reviewIntegrity.totalScore,
      }
    );
  }

  let effectivePrompt = params.prompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = normalizeMcpServers(params.mcpServers);
  const mcpConfigResolution = resolveClaudeMcpConfig(
    params.operation,
    corrId,
    requestedMcpServers,
    params.strictMcpConfig
  );
  if ("errorResponse" in mcpConfigResolution) {
    return mcpConfigResolution.errorResponse;
  }
  const mcpConfig = mcpConfigResolution.config;

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = approvalManager.decide({
      cli: "claude",
      operation: params.operation,
      prompt: params.prompt, // Use raw prompt for review-context detection, not optimized
      bypassRequested: params.dangerouslySkipPermissions,
      fullAuto: false,
      requestedMcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: { model: resolvedModel || "default", strictMcpConfig: params.strictMcpConfig },
      reviewIntegrity,
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  const args = ["-p", effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (params.outputFormat === "json") {
    args.push("--output-format", "json");
  } else if (params.outputFormat === "stream-json") {
    args.push("--output-format", "stream-json", "--include-partial-messages");
  }
  if (params.allowedTools && params.allowedTools.length > 0) {
    sanitizeCliArgValues(params.allowedTools, "allowedTools");
    args.push("--allowed-tools", ...params.allowedTools);
  }
  if (params.disallowedTools && params.disallowedTools.length > 0) {
    sanitizeCliArgValues(params.disallowedTools, "disallowedTools");
    args.push("--disallowed-tools", ...params.disallowedTools);
  }
  if (params.approvalStrategy === "mcp_managed") {
    args.push("--permission-mode", "bypassPermissions");
  } else if (params.dangerouslySkipPermissions) {
    args.push("--permission-mode", "bypassPermissions");
  }
  if (params.strictMcpConfig || mcpConfig.enabled.length > 0) {
    args.push("--mcp-config", mcpConfig.path);
    if (params.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    mcpConfig,
    approvalDecision,
    reviewIntegrity,
    args,
  };
}

function prepareCodexRequest(params: {
  prompt: string;
  model?: string;
  fullAuto: boolean;
  dangerouslyBypassApprovalsAndSandbox: boolean;
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  mcpServers?: ClaudeMcpServerName[];
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
  correlationId?: string;
  optimizePrompt: boolean;
  operation: string;
}): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("codex", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({ prompt: params.prompt });
  if (reviewIntegrity.violations.length > 0) {
    logger.info(
      `[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`,
      {
        cli: "codex",
        operation: params.operation,
        score: reviewIntegrity.totalScore,
      }
    );
  }

  let effectivePrompt = params.prompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = normalizeMcpServers(params.mcpServers);

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = approvalManager.decide({
      cli: "codex",
      operation: params.operation,
      prompt: params.prompt, // Use raw prompt for review-context detection, not optimized
      bypassRequested: params.dangerouslyBypassApprovalsAndSandbox,
      fullAuto: params.fullAuto,
      requestedMcpServers,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: { model: resolvedModel || "default" },
      reviewIntegrity,
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  // Resume mode: codex exec resume <SESSION_ID|--last> [flags] PROMPT
  // Note: `codex exec resume` does NOT accept `--full-auto`; the original
  // session's approval policy is inherited. We silently drop fullAuto on resume.
  let sessionPlan;
  try {
    sessionPlan = resolveCodexSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession
    });
  } catch (err) {
    return createErrorResponse(params.operation, 1, "", corrId, err as Error);
  }

  const args: string[] = ["exec"];
  if (sessionPlan.mode !== "new") {
    args.push("resume");
    if (sessionPlan.mode === "resume-latest") {
      args.push("--last");
    }
  }
  if (resolvedModel) args.push("--model", resolvedModel);
  if (sessionPlan.mode === "new" && params.fullAuto) {
    args.push("--full-auto");
  }
  if (params.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("--skip-git-repo-check");
  if (sessionPlan.mode === "resume-by-id" && sessionPlan.sessionId) {
    args.push(sessionPlan.sessionId);
  }
  args.push(effectivePrompt);

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    approvalDecision,
    reviewIntegrity,
    args,
  };
}

function prepareGeminiRequest(params: {
  prompt: string;
  model?: string;
  approvalMode?: string;
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  allowedTools?: string[];
  includeDirs?: string[];
  mcpServers?: ClaudeMcpServerName[];
  correlationId?: string;
  optimizePrompt: boolean;
  operation: string;
}): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("gemini", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: params.prompt,
    allowedTools: params.allowedTools,
  });
  if (reviewIntegrity.violations.length > 0) {
    logger.info(
      `[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`,
      {
        cli: "gemini",
        operation: params.operation,
        score: reviewIntegrity.totalScore,
      }
    );
  }

  let effectivePrompt = params.prompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = normalizeMcpServers(params.mcpServers);

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = approvalManager.decide({
      cli: "gemini",
      operation: params.operation,
      prompt: params.prompt, // Use raw prompt for review-context detection, not optimized
      bypassRequested: params.approvalMode === "yolo",
      fullAuto: false,
      requestedMcpServers,
      allowedTools: params.allowedTools,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: { model: resolvedModel || "default" },
      reviewIntegrity,
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  const effectiveApprovalMode =
    params.approvalStrategy === "mcp_managed" ? "yolo" : params.approvalMode;

  const args = [effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (effectiveApprovalMode) args.push("--approval-mode", effectiveApprovalMode);
  if (params.allowedTools && params.allowedTools.length > 0) {
    sanitizeCliArgValues(params.allowedTools, "allowedTools");
    params.allowedTools.forEach(tool => args.push("--allowed-tools", tool));
  }
  if (requestedMcpServers.length > 0) {
    sanitizeCliArgValues(requestedMcpServers, "mcpServers");
    requestedMcpServers.forEach(serverName => args.push("--allowed-mcp-server-names", serverName));
  }
  if (params.includeDirs && params.includeDirs.length > 0) {
    sanitizeCliArgValues(params.includeDirs, "includeDirs");
    params.includeDirs.forEach(dir => args.push("--include-directories", dir));
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    approvalDecision,
    reviewIntegrity,
    args,
  };
}

function prepareGrokRequest(params: {
  prompt: string;
  model?: string;
  outputFormat?: string;
  alwaysApprove?: boolean;
  permissionMode?: string;
  effort?: string;
  reasoningEffort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  mcpServers?: ClaudeMcpServerName[];
  correlationId?: string;
  optimizePrompt: boolean;
  operation: string;
}): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("grok", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({ prompt: params.prompt, allowedTools: params.allowedTools, disallowedTools: params.disallowedTools });
  if (reviewIntegrity.violations.length > 0) {
    logger.info(`[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`, {
      cli: "grok", operation: params.operation, score: reviewIntegrity.totalScore
    });
  }

  let effectivePrompt = params.prompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = normalizeMcpServers(params.mcpServers);

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = approvalManager.decide({
      cli: "grok",
      operation: params.operation,
      prompt: params.prompt, // Use raw prompt for review-context detection, not optimized
      bypassRequested: Boolean(params.alwaysApprove) || params.permissionMode === "bypassPermissions",
      fullAuto: false,
      requestedMcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: { model: resolvedModel || "default" },
      reviewIntegrity
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  const effectiveAlwaysApprove = params.approvalStrategy === "mcp_managed" ? true : Boolean(params.alwaysApprove);

  const args = ["-p", effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (params.outputFormat) args.push("--output-format", params.outputFormat);
  if (effectiveAlwaysApprove) {
    args.push("--always-approve");
  } else if (params.permissionMode) {
    args.push("--permission-mode", params.permissionMode);
  }
  if (params.effort) args.push("--effort", params.effort);
  if (params.reasoningEffort) args.push("--reasoning-effort", params.reasoningEffort);
  if (params.allowedTools && params.allowedTools.length > 0) {
    args.push("--tools", params.allowedTools.join(","));
  }
  if (params.disallowedTools && params.disallowedTools.length > 0) {
    args.push("--disallowed-tools", params.disallowedTools.join(","));
  }

  return { corrId, effectivePrompt, resolvedModel, requestedMcpServers, approvalDecision, reviewIntegrity, args };
}

function buildCliResponse(
  cli: "claude" | "codex" | "gemini" | "grok",
  stdout: string,
  optimizeResponse: boolean,
  corrId: string,
  sessionId: string | undefined,
  prep: CliRequestPrep,
  durationMs: number,
  resumable?: boolean,
  outputFormat?: string
): ExtendedToolResponse {
  let finalStdout = stdout;
  // Skip response optimization for JSON output to prevent corrupting structured data
  if (optimizeResponse && outputFormat !== "json") {
    const optimized = optimizeResponseText(finalStdout);
    logOptimizationTokens("response", corrId, finalStdout, optimized);
    finalStdout = optimized;
  }

  // Append review integrity warnings to response text (skip for JSON output to avoid corruption)
  if (
    prep.reviewIntegrity &&
    prep.reviewIntegrity.violations.length > 0 &&
    outputFormat !== "json"
  ) {
    const warnings = prep.reviewIntegrity.violations
      .map(v => `- [${v.type}] ${v.detail}`)
      .join("\n");
    finalStdout += `\n\n⚠️ Review Integrity Warnings (score: ${prep.reviewIntegrity.totalScore}):\n${warnings}`;
  }

  const response: ExtendedToolResponse = {
    content: [{ type: "text" as const, text: finalStdout }],
    structuredContent: {
      model: prep.resolvedModel || "default",
      cli,
      correlationId: corrId,
      sessionId: sessionId || null,
      durationMs,
      ...extractUsageAndCost(cli, stdout, outputFormat),
      exitCode: 0,
      retryCount: 0,
    },
    mcpServers: prep.mcpConfig
      ? {
          requested: prep.requestedMcpServers,
          enabled: prep.mcpConfig.enabled,
          missing: prep.mcpConfig.missing,
        }
      : { requested: prep.requestedMcpServers },
  };
  if (sessionId) {
    response.sessionId = sessionId;
  }
  if (resumable !== undefined) {
    response.resumable = resumable;
  }
  if (prep.approvalDecision) {
    response.approval = prep.approvalDecision;
  }
  if (prep.reviewIntegrity && prep.reviewIntegrity.violations.length > 0) {
    response.reviewIntegrity = prep.reviewIntegrity;
  }
  return response;
}

//──────────────────────────────────────────────────────────────────────────────
// Exported Handler Functions (for DI-based testing)
//──────────────────────────────────────────────────────────────────────────────

export interface GeminiRequestParams {
  prompt: string;
  model?: string;
  sessionId?: string;
  resumeLatest: boolean;
  createNewSession: boolean;
  approvalMode?: string;
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  mcpServers?: ClaudeMcpServerName[];
  allowedTools?: string[];
  includeDirs?: string[];
  correlationId?: string;
  optimizePrompt: boolean;
  optimizeResponse?: boolean;
  idleTimeoutMs?: number;
  forceRefresh?: boolean;
}

export interface HandlerDeps {
  sessionManager: ISessionManager;
  logger: {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
}

export interface AsyncHandlerDeps extends HandlerDeps {
  asyncJobManager: AsyncJobManager;
}

export async function handleGeminiRequest(
  deps: HandlerDeps,
  params: GeminiRequestParams
): Promise<ExtendedToolResponse> {
  const startTime = Date.now();
  const prep = prepareGeminiRequest({
    prompt: params.prompt,
    model: params.model,
    approvalMode: params.approvalMode,
    approvalStrategy: params.approvalStrategy,
    approvalPolicy: params.approvalPolicy,
    allowedTools: params.allowedTools,
    includeDirs: params.includeDirs,
    mcpServers: params.mcpServers,
    correlationId: params.correlationId,
    optimizePrompt: params.optimizePrompt,
    operation: "gemini_request",
  });
  if (!("args" in prep)) return prep;

  const { corrId, args } = prep;
  let durationMs = 0;
  let wasSuccessful = false;
  safeFlightStart({
    correlationId: corrId,
    cli: "gemini",
    model: prep.resolvedModel || "default",
    prompt: params.prompt,
    sessionId: params.sessionId,
  });
  deps.logger.info(
    `[${corrId}] gemini_request invoked with model=${prep.resolvedModel || "default"}, approvalMode=${params.approvalMode}, prompt length=${params.prompt.length}`
  );

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveSessionResumeArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionResult.resumeArgs);

    const result = await awaitJobOrDefer(
      "gemini",
      args,
      corrId,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      undefined,
      params.forceRefresh
    );

    // Deferred — job still running, return async reference
    if (isDeferredResponse(result)) {
      return buildDeferredToolResponse(result, sessionResult.effectiveSessionId);
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - startTime);

    if (code !== 0) {
      deps.logger.info(`[${corrId}] gemini_request failed in ${durationMs}ms`);
      safeFlightComplete(corrId, {
        response: stderr || "",
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: code,
        errorMessage: stderr || `Exit code ${code}`,
        status: "failed",
      });
      return createErrorResponse("gemini", code, stderr, corrId);
    }
    wasSuccessful = true;

    // Post-success session I/O (sync handlers: no phantom sessions on CLI failure)
    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("gemini", "Gemini Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "gemini",
        "Gemini Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    deps.logger.info(`[${corrId}] gemini_request completed successfully in ${durationMs}ms`);
    const response = buildCliResponse(
      "gemini",
      stdout,
      params.optimizeResponse ?? false,
      corrId,
      effectiveSessionId,
      prep,
      durationMs,
      sessionResult.userProvidedSession
    );
    safeFlightComplete(corrId, {
      response: stdout,
      durationMs,
      retryCount: 0,
      circuitBreakerState: "closed",
      approvalDecision: prep.approvalDecision?.status,
      optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
      exitCode: 0,
      status: "completed",
    });
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startTime);
    deps.logger.info(`[${corrId}] gemini_request threw exception after ${elapsedMs}ms`);
    safeFlightComplete(corrId, {
      response: "",
      durationMs: elapsedMs,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 1,
      errorMessage: (error as Error).message,
      status: "failed",
    });
    return createErrorResponse("gemini", 1, "", corrId, error as Error);
  } finally {
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
    performanceMetrics.recordRequest("gemini", finalizedDurationMs, wasSuccessful);
  }
}

export async function handleGeminiRequestAsync(
  deps: AsyncHandlerDeps,
  params: Omit<GeminiRequestParams, "optimizeResponse">
): Promise<ExtendedToolResponse> {
  const prep = prepareGeminiRequest({
    prompt: params.prompt,
    model: params.model,
    approvalMode: params.approvalMode,
    approvalStrategy: params.approvalStrategy,
    approvalPolicy: params.approvalPolicy,
    allowedTools: params.allowedTools,
    includeDirs: params.includeDirs,
    mcpServers: params.mcpServers,
    correlationId: params.correlationId,
    optimizePrompt: params.optimizePrompt,
    operation: "gemini_request_async",
  });
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveSessionResumeArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionResult.resumeArgs);

    // Pre-start session I/O (async handlers: prevent orphaned jobs)
    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("gemini", "Gemini Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "gemini",
        "Gemini Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    // Start job only after all session I/O succeeds
    const job = deps.asyncJobManager.startJob(
      "gemini",
      args,
      corrId,
      undefined,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      undefined,
      params.forceRefresh
    );
    deps.logger.info(`[${corrId}] gemini_request_async started job ${job.id}`);

    const asyncResponse: Record<string, unknown> = {
      success: true,
      job,
      sessionId: effectiveSessionId || null,
      resumable: sessionResult.userProvidedSession,
      approval: approvalDecision,
      mcpServers: { requested: requestedMcpServers },
    };
    if (prep.reviewIntegrity && prep.reviewIntegrity.violations.length > 0) {
      asyncResponse.reviewIntegrity = prep.reviewIntegrity;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(asyncResponse, null, 2),
        },
      ],
    };
  } catch (error) {
    return createErrorResponse("gemini_request_async", 1, "", corrId, error as Error);
  }
}

export interface GrokRequestParams {
  prompt: string;
  model?: string;
  outputFormat?: string;
  sessionId?: string;
  resumeLatest: boolean;
  createNewSession: boolean;
  alwaysApprove?: boolean;
  permissionMode?: string;
  effort?: string;
  reasoningEffort?: string;
  approvalStrategy: "legacy" | "mcp_managed";
  approvalPolicy?: string;
  mcpServers?: ClaudeMcpServerName[];
  allowedTools?: string[];
  disallowedTools?: string[];
  correlationId?: string;
  optimizePrompt: boolean;
  optimizeResponse?: boolean;
  idleTimeoutMs?: number;
  forceRefresh?: boolean;
}

export async function handleGrokRequest(
  deps: HandlerDeps,
  params: GrokRequestParams
): Promise<ExtendedToolResponse> {
  const startTime = Date.now();
  const prep = prepareGrokRequest({
    prompt: params.prompt, model: params.model, outputFormat: params.outputFormat,
    alwaysApprove: params.alwaysApprove, permissionMode: params.permissionMode,
    effort: params.effort, reasoningEffort: params.reasoningEffort,
    allowedTools: params.allowedTools, disallowedTools: params.disallowedTools,
    approvalStrategy: params.approvalStrategy, approvalPolicy: params.approvalPolicy,
    mcpServers: params.mcpServers, correlationId: params.correlationId,
    optimizePrompt: params.optimizePrompt, operation: "grok_request"
  });
  if (!("args" in prep)) return prep;

  const { corrId, args } = prep;
  let durationMs = 0;
  let wasSuccessful = false;
  safeFlightStart({
    correlationId: corrId,
    cli: "grok",
    model: prep.resolvedModel || "default",
    prompt: params.prompt,
    sessionId: params.sessionId
  });
  deps.logger.info(`[${corrId}] grok_request invoked with model=${prep.resolvedModel || "default"}, permissionMode=${params.permissionMode}, prompt length=${params.prompt.length}`);

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveGrokSessionArgs({
      sessionId: params.sessionId, resumeLatest: params.resumeLatest, createNewSession: params.createNewSession
    });
    args.push(...sessionResult.resumeArgs);

    const result = await awaitJobOrDefer("grok", args, corrId, resolveIdleTimeout("grok", params.idleTimeoutMs), params.outputFormat, params.forceRefresh);

    // Deferred — job still running, return async reference
    if (isDeferredResponse(result)) {
      return buildDeferredToolResponse(result, sessionResult.effectiveSessionId);
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - startTime);

    if (code !== 0) {
      deps.logger.info(`[${corrId}] grok_request failed in ${durationMs}ms`);
      safeFlightComplete(corrId, {
        response: stderr || "", durationMs, retryCount: 0, circuitBreakerState: "closed",
        optimizationApplied: false, exitCode: code, errorMessage: stderr || `Exit code ${code}`, status: "failed"
      });
      return createErrorResponse("grok", code, stderr, corrId);
    }
    wasSuccessful = true;

    // Post-success session I/O (sync handlers: no phantom sessions on CLI failure)
    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("grok", "Grok Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "grok", "Grok Session", `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    deps.logger.info(`[${corrId}] grok_request completed successfully in ${durationMs}ms`);
    const response = buildCliResponse("grok", stdout, params.optimizeResponse ?? false, corrId, effectiveSessionId, prep, durationMs, sessionResult.userProvidedSession, params.outputFormat);
    safeFlightComplete(corrId, {
      response: stdout, durationMs, retryCount: 0, circuitBreakerState: "closed",
      approvalDecision: prep.approvalDecision?.status, optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
      exitCode: 0, status: "completed"
    });
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startTime);
    deps.logger.info(`[${corrId}] grok_request threw exception after ${elapsedMs}ms`);
    safeFlightComplete(corrId, {
      response: "", durationMs: elapsedMs, retryCount: 0, circuitBreakerState: "closed",
      optimizationApplied: false, exitCode: 1, errorMessage: (error as Error).message, status: "failed"
    });
    return createErrorResponse("grok", 1, "", corrId, error as Error);
  } finally {
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
    performanceMetrics.recordRequest("grok", finalizedDurationMs, wasSuccessful);
  }
}

export async function handleGrokRequestAsync(
  deps: AsyncHandlerDeps,
  params: Omit<GrokRequestParams, "optimizeResponse">
): Promise<ExtendedToolResponse> {
  const prep = prepareGrokRequest({
    prompt: params.prompt, model: params.model, outputFormat: params.outputFormat,
    alwaysApprove: params.alwaysApprove, permissionMode: params.permissionMode,
    effort: params.effort, reasoningEffort: params.reasoningEffort,
    allowedTools: params.allowedTools, disallowedTools: params.disallowedTools,
    approvalStrategy: params.approvalStrategy, approvalPolicy: params.approvalPolicy,
    mcpServers: params.mcpServers, correlationId: params.correlationId,
    optimizePrompt: params.optimizePrompt, operation: "grok_request_async"
  });
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveGrokSessionArgs({
      sessionId: params.sessionId, resumeLatest: params.resumeLatest, createNewSession: params.createNewSession
    });
    args.push(...sessionResult.resumeArgs);

    // Pre-start session I/O (async handlers: prevent orphaned jobs)
    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("grok", "Grok Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "grok", "Grok Session", `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    // Start job only after all session I/O succeeds
    const job = deps.asyncJobManager.startJob("grok", args, corrId, undefined, resolveIdleTimeout("grok", params.idleTimeoutMs), params.outputFormat, params.forceRefresh);
    deps.logger.info(`[${corrId}] grok_request_async started job ${job.id}`);

    const asyncResponse: Record<string, unknown> = {
      success: true,
      job,
      sessionId: effectiveSessionId || null,
      resumable: sessionResult.userProvidedSession,
      approval: approvalDecision,
      mcpServers: { requested: requestedMcpServers }
    };
    if (prep.reviewIntegrity && prep.reviewIntegrity.violations.length > 0) {
      asyncResponse.reviewIntegrity = prep.reviewIntegrity;
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(asyncResponse, null, 2)
      }]
    };
  } catch (error) {
    return createErrorResponse("grok_request_async", 1, "", corrId, error as Error);
  }
}

export async function handleCodexRequestAsync(
  deps: AsyncHandlerDeps,
  params: {
    prompt: string;
    model?: string;
    fullAuto: boolean;
    dangerouslyBypassApprovalsAndSandbox: boolean;
    approvalStrategy: "legacy" | "mcp_managed";
    approvalPolicy?: string;
    mcpServers?: ClaudeMcpServerName[];
    sessionId?: string;
    resumeLatest?: boolean;
    createNewSession: boolean;
    correlationId?: string;
    optimizePrompt: boolean;
    idleTimeoutMs?: number;
    forceRefresh?: boolean;
  }
): Promise<ExtendedToolResponse> {
  const prep = prepareCodexRequest({
    prompt: params.prompt,
    model: params.model,
    fullAuto: params.fullAuto,
    dangerouslyBypassApprovalsAndSandbox: params.dangerouslyBypassApprovalsAndSandbox,
    approvalStrategy: params.approvalStrategy,
    approvalPolicy: params.approvalPolicy,
    mcpServers: params.mcpServers,
    sessionId: params.sessionId,
    resumeLatest: params.resumeLatest,
    createNewSession: params.createNewSession,
    correlationId: params.correlationId,
    optimizePrompt: params.optimizePrompt,
    operation: "codex_request_async",
  });
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // Pre-start session I/O (async handlers: prevent orphaned jobs)
    let effectiveSessionId = params.sessionId;
    if (!params.createNewSession && !params.sessionId) {
      const activeSession = await deps.sessionManager.getActiveSession("codex");
      if (activeSession) {
        effectiveSessionId = activeSession.id;
      } else {
        const newSession = await deps.sessionManager.createSession("codex", "Codex Session");
        effectiveSessionId = newSession.id;
      }
    } else if (params.sessionId) {
      await deps.sessionManager.updateSessionUsage(params.sessionId);
    } else if (params.createNewSession) {
      const newSession = await deps.sessionManager.createSession("codex", "Codex Session");
      effectiveSessionId = newSession.id;
    }

    // Start job only after all session I/O succeeds
    const job = deps.asyncJobManager.startJob(
      "codex",
      args,
      corrId,
      undefined,
      resolveIdleTimeout("codex", params.idleTimeoutMs),
      undefined,
      params.forceRefresh
    );
    deps.logger.info(`[${corrId}] codex_request_async started job ${job.id}`);

    const asyncResponse: Record<string, unknown> = {
      success: true,
      job,
      sessionId: effectiveSessionId || null,
      approval: approvalDecision,
      mcpServers: { requested: requestedMcpServers },
    };
    if (prep.reviewIntegrity && prep.reviewIntegrity.violations.length > 0) {
      asyncResponse.reviewIntegrity = prep.reviewIntegrity;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(asyncResponse, null, 2),
        },
      ],
    };
  } catch (error) {
    return createErrorResponse("codex_request_async", 1, "", corrId, error as Error);
  }
}

//──────────────────────────────────────────────────────────────────────────────
// Claude Code Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "claude_request",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Claude"),
    model: z
      .string()
      .optional()
      .describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
    outputFormat: z
      .enum(["text", "json", "stream-json"])
      .default("text")
      .describe("Output format (text|json|stream-json). stream-json: NDJSON with idle timeout."),
    sessionId: z.string().optional().describe("Session ID (uses active if omitted)"),
    continueSession: z.boolean().default(false).describe("Continue active session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Allowed tools (['Bash(git:*)','Edit','Write'])"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed tools"),
    dangerouslySkipPermissions: z
      .boolean()
      .default(false)
      .describe("Bypass permissions (sandbox only)"),
    approvalStrategy: z
      .enum(["legacy", "mcp_managed"])
      .default("legacy")
      .describe("Approval strategy"),
    approvalPolicy: z
      .enum(["strict", "balanced", "permissive"])
      .optional()
      .describe("Approval policy override"),
    mcpServers: z
      .array(MCP_SERVER_ENUM)
      .default(["sqry"])
      .describe("MCP servers exposed to Claude"),
    strictMcpConfig: z
      .boolean()
      .default(false)
      .describe("Restrict Claude to provided MCP config only"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output"),
    idleTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(3_600_000)
      .optional()
      .describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z
      .boolean()
      .default(false)
      .describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists"),
  },
  async ({
    prompt,
    model,
    outputFormat,
    sessionId,
    continueSession,
    createNewSession,
    allowedTools,
    disallowedTools,
    dangerouslySkipPermissions,
    approvalStrategy,
    approvalPolicy,
    mcpServers,
    strictMcpConfig,
    correlationId,
    optimizePrompt,
    optimizeResponse,
    idleTimeoutMs,
    forceRefresh,
  }) => {
    const startTime = Date.now();
    const prep = prepareClaudeRequest({
      prompt,
      model,
      outputFormat,
      allowedTools,
      disallowedTools,
      dangerouslySkipPermissions,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      strictMcpConfig,
      correlationId,
      optimizePrompt,
      operation: "claude_request",
    });
    if (!("args" in prep)) return prep;

    const { corrId, args } = prep;
    let durationMs = 0;
    let wasSuccessful = false;
    safeFlightStart({
      correlationId: corrId,
      cli: "claude",
      model: prep.resolvedModel || "default",
      prompt,
      sessionId,
    });
    logger.info(
      `[${corrId}] claude_request invoked with model=${prep.resolvedModel || "default"}, outputFormat=${outputFormat}, prompt length=${prompt.length}, sessionId=${sessionId}`
    );

    try {
      // Session management
      let effectiveSessionId = sessionId;
      let useContinue = continueSession;
      const activeSession = await sessionManager.getActiveSession("claude");

      if (!createNewSession && !continueSession && !sessionId && activeSession) {
        effectiveSessionId = activeSession.id;
        useContinue = true;
      }
      if (!useContinue && effectiveSessionId && activeSession?.id === effectiveSessionId) {
        useContinue = true;
      }
      if (useContinue) {
        args.push("--continue");
      } else if (effectiveSessionId) {
        args.push("--session-id", effectiveSessionId);
        await sessionManager.updateSessionUsage(effectiveSessionId);
      }

      // Idle timeout only for stream-json (text/json produce no output until done)
      const effectiveIdleTimeout =
        outputFormat === "stream-json" ? resolveIdleTimeout("claude", idleTimeoutMs) : undefined;
      const result = await awaitJobOrDefer(
        "claude",
        args,
        corrId,
        effectiveIdleTimeout,
        outputFormat,
        forceRefresh
      );

      // Deferred — job still running, return async reference
      if (isDeferredResponse(result)) {
        return buildDeferredToolResponse(result, effectiveSessionId);
      }

      const { stdout, stderr, code } = result;
      durationMs = Math.max(0, Date.now() - startTime);

      if (code !== 0) {
        logger.info(`[${corrId}] claude_request failed in ${durationMs}ms`);
        safeFlightComplete(corrId, {
          response: stderr || "",
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          optimizationApplied: optimizePrompt || optimizeResponse,
          exitCode: code,
          errorMessage: stderr || `Exit code ${code}`,
          status: "failed",
        });
        return createErrorResponse("claude", code, stderr, corrId);
      }
      wasSuccessful = true;

      // If we used a session ID and it's not tracked yet, create a session record
      if (effectiveSessionId) {
        const existingSession = await sessionManager.getSession(effectiveSessionId);
        if (!existingSession) {
          await sessionManager.createSession("claude", "Claude Session", effectiveSessionId);
        }
      }

      logger.info(`[${corrId}] claude_request completed successfully in ${durationMs}ms`);

      // Parse stream-json NDJSON output to extract result text
      if (outputFormat === "stream-json") {
        const parsed = parseStreamJson(stdout);
        if (parsed.costUsd !== null) {
          logger.debug(
            `[${corrId}] stream-json cost=$${parsed.costUsd}, model=${parsed.model}, turns=${parsed.numTurns}`
          );
        }
        safeFlightComplete(corrId, {
          response: parsed.text,
          inputTokens: parsed.usage?.inputTokens,
          outputTokens: parsed.usage?.outputTokens,
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          costUsd: parsed.costUsd ?? undefined,
          optimizationApplied: optimizePrompt || optimizeResponse,
          exitCode: 0,
          status: "completed",
        });
        return buildCliResponse(
          "claude",
          parsed.text,
          optimizeResponse,
          corrId,
          effectiveSessionId,
          prep,
          durationMs,
          undefined,
          outputFormat
        );
      }
      safeFlightComplete(corrId, {
        response: stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: optimizePrompt || optimizeResponse,
        exitCode: 0,
        status: "completed",
      });
      return buildCliResponse(
        "claude",
        stdout,
        optimizeResponse,
        corrId,
        effectiveSessionId,
        prep,
        durationMs,
        undefined,
        outputFormat
      );
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      logger.info(`[${corrId}] claude_request threw exception after ${elapsedMs}ms`);
      safeFlightComplete(corrId, {
        response: "",
        durationMs: elapsedMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: optimizePrompt || optimizeResponse,
        exitCode: 1,
        errorMessage: (error as Error).message,
        status: "failed",
      });
      return createErrorResponse("claude", 1, "", corrId, error as Error);
    } finally {
      const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
      performanceMetrics.recordRequest("claude", finalizedDurationMs, wasSuccessful);
    }
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Codex Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "codex_request",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Codex"),
    model: z.string().optional().describe("Model name or alias (e.g. gpt-5.4, latest)"),
    fullAuto: z.boolean().default(false).describe("Full-auto mode (sandboxed execution)"),
    dangerouslyBypassApprovalsAndSandbox: z
      .boolean()
      .default(false)
      .describe("Run Codex without approvals/sandbox"),
    approvalStrategy: z
      .enum(["legacy", "mcp_managed"])
      .default("legacy")
      .describe("Approval strategy"),
    approvalPolicy: z
      .enum(["strict", "balanced", "permissive"])
      .optional()
      .describe("Approval policy override"),
    mcpServers: z
      .array(MCP_SERVER_ENUM)
      .default(["sqry"])
      .describe("MCP server names for approval tracking (Codex manages its own MCP config)"),
    sessionId: z
      .string()
      .optional()
      .describe(
        "Codex session UUID to resume via `codex exec resume <ID>`. Must be a real Codex session ID (from `~/.codex/sessions/` or the `codex resume` picker). Gateway-generated `gw-*` IDs are rejected."
      ),
    resumeLatest: z
      .boolean()
      .default(false)
      .describe(
        "Resume the most recent Codex session in the current cwd via `codex exec resume --last`. Ignored if sessionId is set."
      ),
    createNewSession: z.boolean().default(false).describe("Force a fresh session (no resume)"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output"),
    idleTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(3_600_000)
      .optional()
      .describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z
      .boolean()
      .default(false)
      .describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists"),
  },
  async ({
    prompt,
    model,
    fullAuto,
    dangerouslyBypassApprovalsAndSandbox,
    approvalStrategy,
    approvalPolicy,
    mcpServers,
    sessionId,
    resumeLatest,
    createNewSession,
    correlationId,
    optimizePrompt,
    optimizeResponse,
    idleTimeoutMs,
    forceRefresh,
  }) => {
    const startTime = Date.now();
    const prep = prepareCodexRequest({
      prompt,
      model,
      fullAuto,
      dangerouslyBypassApprovalsAndSandbox,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      sessionId,
      resumeLatest,
      createNewSession,
      correlationId,
      optimizePrompt,
      operation: "codex_request",
    });
    if (!("args" in prep)) return prep;

    const { corrId, args } = prep;
    let durationMs = 0;
    let wasSuccessful = false;
    safeFlightStart({
      correlationId: corrId,
      cli: "codex",
      model: prep.resolvedModel || "default",
      prompt,
      sessionId,
    });
    logger.info(
      `[${corrId}] codex_request invoked with model=${prep.resolvedModel || "default"}, fullAuto=${fullAuto}, prompt length=${prompt.length}`
    );

    try {
      const result = await awaitJobOrDefer(
        "codex",
        args,
        corrId,
        resolveIdleTimeout("codex", idleTimeoutMs),
        undefined,
        forceRefresh
      );

      // Deferred — job still running, return async reference
      if (isDeferredResponse(result)) {
        return buildDeferredToolResponse(result, sessionId);
      }

      const { stdout, stderr, code } = result;
      durationMs = Math.max(0, Date.now() - startTime);

      if (code !== 0) {
        logger.info(`[${corrId}] codex_request failed in ${durationMs}ms`);
        safeFlightComplete(corrId, {
          response: stderr || "",
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          optimizationApplied: optimizePrompt || optimizeResponse,
          exitCode: code,
          errorMessage: stderr || `Exit code ${code}`,
          status: "failed",
        });
        return createErrorResponse("codex", code, stderr, corrId);
      }
      wasSuccessful = true;

      // Track session usage
      let effectiveSessionId = sessionId;
      if (!createNewSession && !sessionId) {
        const activeSession = await sessionManager.getActiveSession("codex");
        if (activeSession) {
          effectiveSessionId = activeSession.id;
        } else {
          const newSession = await sessionManager.createSession("codex", "Codex Session");
          effectiveSessionId = newSession.id;
        }
      } else if (sessionId) {
        await sessionManager.updateSessionUsage(sessionId);
      } else if (createNewSession) {
        const newSession = await sessionManager.createSession("codex", "Codex Session");
        effectiveSessionId = newSession.id;
      }

      logger.info(`[${corrId}] codex_request completed successfully in ${durationMs}ms`);
      safeFlightComplete(corrId, {
        response: stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: optimizePrompt || optimizeResponse,
        exitCode: 0,
        status: "completed",
      });
      return buildCliResponse(
        "codex",
        stdout,
        optimizeResponse,
        corrId,
        effectiveSessionId,
        prep,
        durationMs
      );
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      logger.info(`[${corrId}] codex_request threw exception after ${elapsedMs}ms`);
      safeFlightComplete(corrId, {
        response: "",
        durationMs: elapsedMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: optimizePrompt || optimizeResponse,
        exitCode: 1,
        errorMessage: (error as Error).message,
        status: "failed",
      });
      return createErrorResponse("codex", 1, "", corrId, error as Error);
    } finally {
      const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
      performanceMetrics.recordRequest("codex", finalizedDurationMs, wasSuccessful);
    }
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Gemini Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "gemini_request",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Gemini"),
    model: z
      .string()
      .optional()
      .describe(
        "Model name or alias (e.g. gemini-3-pro-preview, gemini-2.5-flash, pro, flash, latest)"
      ),
    sessionId: z.string().optional().describe("Session ID or 'latest'"),
    resumeLatest: z.boolean().default(false).describe("Resume latest session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    approvalMode: z
      .enum(["default", "auto_edit", "yolo"])
      .optional()
      .describe("Approval: default|auto_edit|yolo"),
    approvalStrategy: z
      .enum(["legacy", "mcp_managed"])
      .default("legacy")
      .describe("Approval strategy"),
    approvalPolicy: z
      .enum(["strict", "balanced", "permissive"])
      .optional()
      .describe("Approval policy override"),
    mcpServers: z
      .array(MCP_SERVER_ENUM)
      .default(["sqry"])
      .describe("MCP server names passed to Gemini as --allowed-mcp-server-names"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Allowed tools (['Write','Edit','Bash'])"),
    includeDirs: z.array(z.string()).optional().describe("Additional workspace directories"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, approvalStrategy, approvalPolicy, mcpServers, allowedTools, includeDirs, correlationId, optimizePrompt, optimizeResponse, idleTimeoutMs, forceRefresh }) => {
    return handleGeminiRequest(
      { sessionManager, logger },
      { prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, approvalStrategy, approvalPolicy, mcpServers, allowedTools, includeDirs, correlationId, optimizePrompt, optimizeResponse, idleTimeoutMs, forceRefresh }
    );
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Grok Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "grok_request",
  {
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Grok"),
    model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
    outputFormat: z.enum(["plain", "json", "streaming-json"]).optional().describe("Output format (plain|json|streaming-json). Grok default is plain."),
    sessionId: z.string().optional().describe("Session ID (user-provided CLI handle for --resume)"),
    resumeLatest: z.boolean().default(false).describe("Resume most recent Grok session in cwd (--continue)"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    alwaysApprove: z.boolean().default(false).describe("Auto-approve all tool executions (--always-approve)"),
    permissionMode: z.enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"]).optional().describe("Grok permission mode"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Grok effort level"),
    reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("legacy").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP server names for approval tracking (Grok manages its own MCP config via `grok mcp`)"),
    allowedTools: z.array(z.string()).optional().describe("Allowed built-in tools (passed as --tools comma list)"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed built-in tools (passed as --disallowed-tools comma list)"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, outputFormat, sessionId, resumeLatest, createNewSession, alwaysApprove, permissionMode, effort, reasoningEffort, approvalStrategy, approvalPolicy, mcpServers, allowedTools, disallowedTools, correlationId, optimizePrompt, optimizeResponse, idleTimeoutMs, forceRefresh }) => {
    return handleGrokRequest(
      { sessionManager, logger },
      { prompt, model, outputFormat, sessionId, resumeLatest, createNewSession, alwaysApprove, permissionMode, effort, reasoningEffort, approvalStrategy, approvalPolicy, mcpServers, allowedTools, disallowedTools, correlationId, optimizePrompt, optimizeResponse, idleTimeoutMs, forceRefresh }
    );
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Async Long-Running Job Tools (No Time-Bound LLM Execution)
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "claude_request_async",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Claude"),
    model: z
      .string()
      .optional()
      .describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
    outputFormat: z
      .enum(["text", "json", "stream-json"])
      .default("text")
      .describe("Output format (text|json|stream-json). stream-json: NDJSON with idle timeout."),
    sessionId: z.string().optional().describe("Session ID (uses active if omitted)"),
    continueSession: z.boolean().default(false).describe("Continue active session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Allowed tools (['Bash(git:*)','Edit','Write'])"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed tools"),
    dangerouslySkipPermissions: z
      .boolean()
      .default(false)
      .describe("Bypass permissions (sandbox only)"),
    approvalStrategy: z
      .enum(["legacy", "mcp_managed"])
      .default("legacy")
      .describe("Approval strategy"),
    approvalPolicy: z
      .enum(["strict", "balanced", "permissive"])
      .optional()
      .describe("Approval policy override"),
    mcpServers: z
      .array(MCP_SERVER_ENUM)
      .default(["sqry"])
      .describe("MCP servers exposed to Claude"),
    strictMcpConfig: z
      .boolean()
      .default(false)
      .describe("Restrict Claude to provided MCP config only"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, outputFormat, sessionId, continueSession, createNewSession, allowedTools, disallowedTools, dangerouslySkipPermissions, approvalStrategy, approvalPolicy, mcpServers, strictMcpConfig, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }) => {
    const prep = prepareClaudeRequest({
      prompt,
      model,
      outputFormat,
      allowedTools,
      disallowedTools,
      dangerouslySkipPermissions,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      strictMcpConfig,
      correlationId,
      optimizePrompt,
      operation: "claude_request_async",
    });
    if (!("args" in prep)) return prep;

    const { corrId, args, requestedMcpServers, mcpConfig, approvalDecision } = prep;

    try {
      // Session management (before job start for async)
      let effectiveSessionId = sessionId;
      let useContinue = continueSession;
      const activeSession = await sessionManager.getActiveSession("claude");

      if (!createNewSession && !continueSession && !sessionId && activeSession) {
        effectiveSessionId = activeSession.id;
        useContinue = true;
      }
      if (!useContinue && effectiveSessionId && activeSession?.id === effectiveSessionId) {
        useContinue = true;
      }
      if (useContinue) {
        args.push("--continue");
      } else if (effectiveSessionId) {
        args.push("--session-id", effectiveSessionId);
        await sessionManager.updateSessionUsage(effectiveSessionId);
      }

      if (effectiveSessionId) {
        const existingSession = await sessionManager.getSession(effectiveSessionId);
        if (!existingSession) {
          await sessionManager.createSession("claude", "Claude Session", effectiveSessionId);
        }
      }

      // Idle timeout only for stream-json (text/json produce no output until done)
      const effectiveIdleTimeout = outputFormat === "stream-json"
        ? resolveIdleTimeout("claude", idleTimeoutMs)
        : undefined;
      const job = asyncJobManager.startJob("claude", args, corrId, undefined, effectiveIdleTimeout, outputFormat, forceRefresh);
      logger.info(`[${corrId}] claude_request_async started job ${job.id}, outputFormat=${outputFormat}`);

      const asyncResponse: Record<string, unknown> = {
        success: true,
        job,
        sessionId: effectiveSessionId || activeSession?.id || null,
        approval: approvalDecision,
        mcpServers: {
          requested: requestedMcpServers,
          enabled: mcpConfig?.enabled,
          missing: mcpConfig?.missing,
        },
      };
      if (prep.reviewIntegrity && prep.reviewIntegrity.violations.length > 0) {
        asyncResponse.reviewIntegrity = prep.reviewIntegrity;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(asyncResponse, null, 2),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("claude_request_async", 1, "", corrId, error as Error);
    }
  }
);

server.tool(
  "codex_request_async",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Codex"),
    model: z.string().optional().describe("Model name or alias (e.g. gpt-5.4, latest)"),
    fullAuto: z.boolean().default(false).describe("Full-auto mode (sandboxed execution)"),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().default(false).describe("Run Codex without approvals/sandbox"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("legacy").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP server names for approval tracking (Codex manages its own MCP config)"),
    sessionId: z.string().optional().describe("Codex session UUID to resume via `codex exec resume <ID>`. Must be a real Codex session ID (from `~/.codex/sessions/` or the `codex resume` picker). Gateway-generated `gw-*` IDs are rejected."),
    resumeLatest: z.boolean().default(false).describe("Resume the most recent Codex session in the current cwd via `codex exec resume --last`. Ignored if sessionId is set."),
    createNewSession: z.boolean().default(false).describe("Force a fresh session (no resume)"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, fullAuto, dangerouslyBypassApprovalsAndSandbox, approvalStrategy, approvalPolicy, mcpServers, sessionId, resumeLatest, createNewSession, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }) => {
    return handleCodexRequestAsync(
      { sessionManager, asyncJobManager, logger },
      { prompt, model, fullAuto, dangerouslyBypassApprovalsAndSandbox, approvalStrategy, approvalPolicy, mcpServers, sessionId, resumeLatest, createNewSession, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }
    );
  }
);

server.tool(
  "gemini_request_async",
  {
    prompt: z
      .string()
      .min(1, "Prompt cannot be empty")
      .max(100000, "Prompt too long (max 100k chars)")
      .describe("Prompt text for Gemini"),
    model: z
      .string()
      .optional()
      .describe(
        "Model name or alias (e.g. gemini-3-pro-preview, gemini-2.5-flash, pro, flash, latest)"
      ),
    sessionId: z.string().optional().describe("Session ID (user-provided CLI handle for --resume)"),
    resumeLatest: z.boolean().default(false).describe("Resume latest session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    approvalMode: z
      .enum(["default", "auto_edit", "yolo"])
      .optional()
      .describe("Approval: default|auto_edit|yolo"),
    approvalStrategy: z
      .enum(["legacy", "mcp_managed"])
      .default("legacy")
      .describe("Approval strategy"),
    approvalPolicy: z
      .enum(["strict", "balanced", "permissive"])
      .optional()
      .describe("Approval policy override"),
    mcpServers: z
      .array(MCP_SERVER_ENUM)
      .default(["sqry"])
      .describe("MCP server names passed to Gemini as --allowed-mcp-server-names"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Allowed tools (['Write','Edit','Bash'])"),
    includeDirs: z.array(z.string()).optional().describe("Additional workspace directories"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, approvalStrategy, approvalPolicy, mcpServers, allowedTools, includeDirs, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }) => {
    return handleGeminiRequestAsync(
      { sessionManager, asyncJobManager, logger },
      { prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, approvalStrategy, approvalPolicy, mcpServers, allowedTools, includeDirs, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }
    );
  }
);

server.tool(
  "grok_request_async",
  {
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Grok"),
    model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
    outputFormat: z.enum(["plain", "json", "streaming-json"]).optional().describe("Output format (plain|json|streaming-json). Grok default is plain."),
    sessionId: z.string().optional().describe("Session ID (user-provided CLI handle for --resume)"),
    resumeLatest: z.boolean().default(false).describe("Resume most recent Grok session in cwd (--continue)"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    alwaysApprove: z.boolean().default(false).describe("Auto-approve all tool executions (--always-approve)"),
    permissionMode: z.enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"]).optional().describe("Grok permission mode"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Grok effort level"),
    reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("legacy").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP server names for approval tracking (Grok manages its own MCP config via `grok mcp`)"),
    allowedTools: z.array(z.string()).optional().describe("Allowed built-in tools (passed as --tools comma list)"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed built-in tools (passed as --disallowed-tools comma list)"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    idleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    forceRefresh: z.boolean().default(false).describe("Bypass dedup and force a fresh CLI run even if a recent identical request exists")
  },
  async ({ prompt, model, outputFormat, sessionId, resumeLatest, createNewSession, alwaysApprove, permissionMode, effort, reasoningEffort, approvalStrategy, approvalPolicy, mcpServers, allowedTools, disallowedTools, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }) => {
    return handleGrokRequestAsync(
      { sessionManager, asyncJobManager, logger },
      { prompt, model, outputFormat, sessionId, resumeLatest, createNewSession, alwaysApprove, permissionMode, effort, reasoningEffort, approvalStrategy, approvalPolicy, mcpServers, allowedTools, disallowedTools, correlationId, optimizePrompt, idleTimeoutMs, forceRefresh }
    );
  }
);

server.tool(
  "llm_job_status",
  {
    jobId: z.string().describe("Async job ID from *_request_async"),
  },
  async ({ jobId }) => {
    const job = asyncJobManager.getJobSnapshot(jobId);
    if (!job) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: "Job not found",
                jobId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              job,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "llm_job_result",
  {
    jobId: z.string().describe("Async job ID from *_request_async"),
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(2000000)
      .default(200000)
      .describe("Max chars returned per stream"),
  },
  async ({ jobId, maxChars }) => {
    const result = asyncJobManager.getJobResult(jobId, maxChars);
    if (!result) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: "Job not found",
                jobId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // Parse stream-json output for Claude async jobs
    const outputFormat = asyncJobManager.getJobOutputFormat(jobId);
    let parsed: ReturnType<typeof parseStreamJson> | undefined;
    if (outputFormat === "stream-json" && result.stdout) {
      parsed = parseStreamJson(result.stdout);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              result,
              ...(parsed
                ? {
                    parsed: {
                      text: parsed.text,
                      costUsd: parsed.costUsd,
                      usage: parsed.usage,
                      model: parsed.model,
                      numTurns: parsed.numTurns,
                    },
                  }
                : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "llm_job_cancel",
  {
    jobId: z.string().describe("Async job ID from *_request_async"),
  },
  async ({ jobId }) => {
    const cancel = asyncJobManager.cancelJob(jobId);
    if (!cancel.canceled) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                jobId,
                reason: cancel.reason || "Unable to cancel",
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              jobId,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool("llm_process_health", {}, async () => {
  const health = asyncJobManager.getJobHealth();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ success: true, ...health }, null, 2),
      },
    ],
  };
});

//──────────────────────────────────────────────────────────────────────────────
// Approval Audit Tools
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "approval_list",
  {
    limit: z.number().int().min(1).max(500).default(50).describe("Max number of approval records"),
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("Optional CLI filter"),
  },
  async ({ limit, cli }) => {
    const approvals = approvalManager.list(limit, cli);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              count: approvals.length,
              approvals,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// List Models Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "list_models",
  {
    cli: z
      .preprocess(
        value => (value === "" || value === null ? undefined : value),
        z.enum(["claude", "codex", "gemini"]).optional()
      )
      .describe("CLI filter (claude|codex|gemini)"),
  },
  async ({ cli }) => {
    const cliInfo = getCliInfo();
    const result = cli ? { [cli]: cliInfo[cli] } : cliInfo;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "cli_versions",
  {
    cli: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.enum(["claude", "codex", "gemini"]).optional()
    ).describe("CLI filter (claude|codex|gemini)")
  },
  async ({ cli }) => {
    const versions = await getCliVersions(cli);
    return { content: [{ type: "text", text: JSON.stringify({ versions }, null, 2) }] };
  }
);

server.tool(
  "cli_upgrade",
  {
    cli: z.enum(["claude", "codex", "gemini"]).describe("CLI to upgrade"),
    target: z.string().min(1).default("latest").describe("Package tag/version/target to install (default: latest)"),
    dryRun: z.boolean().default(true).describe("When true, return the upgrade plan without running it"),
    timeoutMs: z.number().int().min(30_000).max(3_600_000).optional().describe("Upgrade timeout in ms when dryRun=false")
  },
  async ({ cli, target, dryRun, timeoutMs }) => {
    try {
      const result = await runCliUpgrade({ cli, target, dryRun, timeoutMs, logger });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            ...result
          }, null, 2)
        }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: message
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Session Management Tools
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "session_create",
  {
    cli: z.enum(["claude", "codex", "gemini"]).describe("CLI type (claude|codex|gemini)"),
    description: z.string().optional().describe("Session description"),
    setAsActive: z.boolean().default(true).describe("Set as active session"),
  },
  async ({ cli, description, setAsActive }) => {
    try {
      const session = await sessionManager.createSession(cli, description);

      if (setAsActive) {
        await sessionManager.setActiveSession(cli, session.id);
      }

      logger.info(`Created new ${cli} session: ${session.id}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                session: {
                  id: session.id,
                  cli: session.cli,
                  description: session.description,
                  createdAt: session.createdAt,
                  isActive: setAsActive,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_create", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_list",
  {
    cli: z
      .enum(["claude", "codex", "gemini"])
      .optional()
      .describe("CLI filter (claude|codex|gemini)"),
  },
  async ({ cli }) => {
    try {
      const sessions = await sessionManager.listSessions(cli);
      const activeSessions = {
        claude: await sessionManager.getActiveSession("claude"),
        codex: await sessionManager.getActiveSession("codex"),
        gemini: await sessionManager.getActiveSession("gemini"),
        grok: await sessionManager.getActiveSession("grok"),
      };

      const sessionList = sessions.map(s => ({
        id: s.id,
        cli: s.cli,
        description: s.description,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        isActive: activeSessions[s.cli]?.id === s.id,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: sessionList.length,
                sessions: sessionList,
                activeSessions: {
                  claude: activeSessions.claude?.id || null,
                  codex: activeSessions.codex?.id || null,
                  gemini: activeSessions.gemini?.id || null,
                  grok: activeSessions.grok?.id || null,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_list", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_set_active",
  {
    cli: z.enum(["claude", "codex", "gemini"]).describe("CLI type (claude|codex|gemini)"),
    sessionId: z.string().nullable().describe("Session ID (null to clear)"),
  },
  async ({ cli, sessionId }) => {
    try {
      const success = await sessionManager.setActiveSession(cli, sessionId || null);

      if (!success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Session not found or does not belong to the specified CLI",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      logger.info(`Set active ${cli} session to: ${sessionId}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                cli,
                activeSessionId: sessionId,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_set_active", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_delete",
  {
    sessionId: z.string().describe("Session ID"),
  },
  async ({ sessionId }) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Session not found",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const success = await sessionManager.deleteSession(sessionId);
      logger.info(`Deleted session: ${sessionId}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success,
                deletedSession: {
                  id: session.id,
                  cli: session.cli,
                  description: session.description,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_delete", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_get",
  {
    sessionId: z.string().describe("Session ID"),
  },
  async ({ sessionId }) => {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Session not found",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const activeSession = await sessionManager.getActiveSession(session.cli);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                session: {
                  ...session,
                  isActive: activeSession?.id === session.id,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_get", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_clear_all",
  {
    cli: z
      .enum(["claude", "codex", "gemini"])
      .optional()
      .describe("CLI filter (claude|codex|gemini)"),
  },
  async ({ cli }) => {
    try {
      const count = await sessionManager.clearAllSessions(cli);
      logger.info(`Cleared ${count} sessions${cli ? ` for ${cli}` : ""}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                deletedCount: count,
                cli: cli || "all",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return createErrorResponse("session_clear_all", 1, "", undefined, error as Error);
    }
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Async Initialization
//──────────────────────────────────────────────────────────────────────────────

async function initializeSessionManager(): Promise<void> {
  const config = loadConfig();

  if (config.database && config.redis) {
    logger.info("Initializing PostgreSQL + Redis session manager");
    const { createDatabaseConnection } = await import("./db.js");
    db = await createDatabaseConnection(config, logger);
    sessionManager = await createSessionManager(config, db, logger);
    logger.info("PostgreSQL session manager initialized");
  } else {
    logger.info("Initializing file-based session manager");
    sessionManager = await createSessionManager(config, undefined, logger);
    logger.info("File-based session manager initialized");
  }

  resourceProvider = new ResourceProvider(sessionManager, performanceMetrics);
}

//──────────────────────────────────────────────────────────────────────────────
// Health Check Resource (only if using PostgreSQL)
//──────────────────────────────────────────────────────────────────────────────

function registerHealthResource(): void {
  if (db) {
    server.registerResource(
      "health",
      "health://status",
      {
        title: "🏥 Health Status",
        description: "DB connectivity and latency",
        mimeType: "application/json",
      },
      async () => {
        const health = await checkHealth(db!);
        return {
          contents: [
            {
              uri: "health://status",
              text: JSON.stringify(health, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      }
    );
    logger.info("Health check resource registered");
  }

  // Process health resource (always available, not dependent on DB)
  server.registerResource(
    "process-health",
    "metrics://process-health",
    {
      title: "Process Health",
      description: "Async job health (CPU, memory, zombie detection)",
      mimeType: "application/json",
    },
    async uri => {
      const health = asyncJobManager.getJobHealth();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    }
  );
  logger.info("Process health resource registered");
}

//──────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
//──────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Kill all active process groups (SIGTERM → wait 3s → SIGKILL)
    await killAllProcessGroups();
    logger.info("All process groups terminated");

    await server.close();
    logger.info("MCP server closed");

    if (db) {
      await db.disconnect();
      logger.info("Database connections closed");
    }

    flightRecorder.close();
    logger.info("Flight recorder closed");

    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

//──────────────────────────────────────────────────────────────────────────────
// Server Startup
//──────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("Starting llm-cli-gateway MCP server");

  // Initialize session manager first
  await initializeSessionManager();

  // Register health check resource if using PostgreSQL
  registerHealthResource();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("llm-cli-gateway MCP server connected and ready");
}

// Guard: only auto-start when run directly (not imported for testing)
// Resolve symlinks so `llm-cli-gateway` (npm-linked bin) matches import.meta.url
const __entryUrl = process.argv[1] ? new URL(realpathSync(process.argv[1]), "file://").href : "";
if (__entryUrl === import.meta.url) {
  main().catch(error => {
    logger.error("Fatal server error:", error);
    process.exit(1);
  });
}
