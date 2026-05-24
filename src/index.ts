#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { executeCli, killAllProcessGroups } from "./executor.js";
import { parseStreamJson } from "./stream-json-parser.js";
import { parseCodexJsonStream } from "./codex-json-parser.js";
import { parseGeminiJson } from "./gemini-json-parser.js";
import { ISessionManager, createSessionManager } from "./session-manager.js";
import { ResourceProvider } from "./resources.js";
import { PerformanceMetrics } from "./metrics.js";
import {
  estimateTokens,
  optimizePrompt as optimizePromptText,
  optimizeResponse as optimizeResponseText,
} from "./optimizer.js";
import { loadConfig, loadPersistenceConfig, type PersistenceConfig } from "./config.js";
import { DatabaseConnection } from "./db.js";
import { checkHealth } from "./health.js";
import { clearModelRegistryCache, getCliInfo, resolveModelAlias } from "./model-registry.js";
import { AsyncJobManager } from "./async-job-manager.js";
import { createJobStore, type JobStore } from "./job-store.js";
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
  resolveMistralSessionArgs,
  resolveCodexSessionArgs,
  sanitizeCliArgValues,
  prepareMistralRequest as buildMistralCliInvocation,
  MISTRAL_AGENT_MODES,
  type MistralAgentMode,
  GATEWAY_SESSION_PREFIX,
  resolveClaudePermissionFlags,
  resolveCodexSandboxFlags,
  CLAUDE_PERMISSION_MODES,
  GEMINI_APPROVAL_MODES,
  CODEX_SANDBOX_MODES,
  CODEX_ASK_FOR_APPROVAL_MODES,
  CLAUDE_EFFORT_LEVELS,
  prepareClaudeHighImpactFlags,
  validateClaudeAgentsMap,
  prepareCodexHighImpactFlags,
  prepareCodexForkRequest,
  CODEX_CONFIG_OVERRIDES_SCHEMA,
  prepareGeminiHighImpactFlags,
  prependGeminiAttachments,
  resolveGeminiSessionPlan,
  GEMINI_HIGH_IMPACT_PARAMS_SCHEMA,
  type ClaudePermissionMode,
  type CodexSandboxMode,
  type CodexAskForApproval,
  type ClaudeEffortLevel,
  type ClaudeAgentDefinition,
} from "./request-helpers.js";
import { createFlightRecorder, FlightRecorderLike } from "./flight-recorder.js";
import { getCliVersions, runCliUpgrade } from "./cli-updater.js";
import { startHttpGateway, type HttpGatewayHandle } from "./http-transport.js";
import { printDoctorJson } from "./doctor.js";
import { registerValidationTools } from "./validation-tools.js";
import {
  assertUpstreamCliArgs,
  assertUpstreamCliEnv,
  buildUpstreamContractReport,
} from "./upstream-contracts.js";
import { entrypointFileURL } from "./entrypoint-url.js";

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
  warn: (message: string, ...args: any[]) => {
    console.error(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
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

type GatewayLogger = typeof logger;

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

Tools: claude_request, codex_request, gemini_request, grok_request, mistral_request (sync) | *_request_async (async)
Validation: validate_with_models, second_opinion, compare_answers, red_team_review, consensus_check, ask_model, synthesize_validation
Jobs: llm_job_status, llm_job_result, llm_job_cancel
Sessions: session_create, session_list, session_set_active, session_get, session_delete, session_clear_all
Other: list_models, cli_versions, upstream_contracts, cli_upgrade, approval_list, llm_process_health

Key behaviors:
- Sync auto-defers at ${SYNC_DEADLINE_MS}ms. Poll deferred jobs via llm_job_status/llm_job_result.
- Sessions: Claude --continue, Gemini --resume, Grok --resume/--continue, Mistral --resume/--continue (requires session_logging.enabled=true in ~/.vibe/config.toml), Codex \`exec resume <ID>\` / \`exec resume --last\` (all real CLI continuity). For Codex, sessionId must be a real Codex UUID (from ~/.codex/sessions/); gateway-generated gw-* IDs are rejected.
- Approval gates: opt-in via approvalStrategy:"mcp_managed".
- Idle timeout kills stuck processes (default 10min, configurable via idleTimeoutMs).

Skills (full docs via MCP resources):
${loadedSkills.map(s => `- skills://${s.name} — ${s.description}`).join("\n")}`;

function newGatewayMcpServer(): McpServer {
  return new McpServer(
    { name: "llm-cli-gateway", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
}

// Global state (initialized asynchronously)
let sessionManager: ISessionManager;
let db: DatabaseConnection | null = null;
const performanceMetrics = new PerformanceMetrics();
let resourceProvider: ResourceProvider;
const flightRecorder: FlightRecorderLike = createFlightRecorder(logger);

// Resolved persistence config — single source of truth for the async-job backend.
// Driven by ~/.llm-cli-gateway/config.toml (+ deprecated env-var overrides).
// When backend = "none", the JobStore is null AND *_request_async tools are not
// registered (see createGatewayServer), making silent in-memory loss
// structurally impossible.
const persistenceConfig: PersistenceConfig = loadPersistenceConfig(logger);
const jobStore: JobStore | null = (() => {
  try {
    return createJobStore(persistenceConfig, logger);
  } catch (err) {
    logger.error("Failed to open durable job store; async tools will be unavailable", err);
    return null;
  }
})();

function newAsyncJobManager(
  metrics: PerformanceMetrics,
  runtimeLogger: GatewayLogger,
  store: JobStore | null = jobStore
): AsyncJobManager {
  return new AsyncJobManager(
    runtimeLogger,
    (cli, durationMs, success) => {
      metrics.recordRequest(cli, durationMs, success);
    },
    store
  );
}

const asyncJobManager = newAsyncJobManager(performanceMetrics, logger);
const approvalManager = new ApprovalManager(undefined, logger);
const MCP_SERVER_ENUM = z.enum(CLAUDE_MCP_SERVER_NAMES);

// U22: Session-provider enum extended to five providers. The storage layer's
// CLI_TYPES already includes "mistral"; the MCP-tool layer mirrors that here so
// session_create / session_list / session_clear_all accept the fifth provider.
export const SESSION_PROVIDER_VALUES = ["claude", "codex", "gemini", "grok", "mistral"] as const;
export const SESSION_PROVIDER_ENUM = z.enum(SESSION_PROVIDER_VALUES);
export type SessionProvider = (typeof SESSION_PROVIDER_VALUES)[number];
let activeServer: McpServer | null = null;
let activeHttpGateway: HttpGatewayHandle | null = null;

export interface GatewayServerDeps {
  sessionManager?: ISessionManager;
  resourceProvider?: ResourceProvider;
  db?: DatabaseConnection | null;
  performanceMetrics?: PerformanceMetrics;
  asyncJobManager?: AsyncJobManager;
  approvalManager?: ApprovalManager;
  flightRecorder?: FlightRecorderLike;
  logger?: GatewayLogger;
  persistence?: PersistenceConfig;
}

interface GatewayServerRuntime {
  sessionManager: ISessionManager;
  resourceProvider: ResourceProvider;
  db: DatabaseConnection | null;
  performanceMetrics: PerformanceMetrics;
  asyncJobManager: AsyncJobManager;
  approvalManager: ApprovalManager;
  flightRecorder: FlightRecorderLike;
  logger: GatewayLogger;
  persistence: PersistenceConfig;
}

function resolveGatewayServerRuntime(
  deps: GatewayServerDeps = {},
  options: { isolateState?: boolean } = {}
): GatewayServerRuntime {
  const runtimeLogger = deps.logger ?? logger;
  const runtimeSessionManager = deps.sessionManager ?? sessionManager;
  const runtimePerformanceMetrics =
    deps.performanceMetrics ??
    (options.isolateState ? new PerformanceMetrics() : performanceMetrics);
  const runtimeAsyncJobManager =
    deps.asyncJobManager ??
    (options.isolateState
      ? // Factory-created test/HTTP session servers must not mark another instance's
        // durable jobs orphaned. Stdio startup injects the process-global manager.
        newAsyncJobManager(runtimePerformanceMetrics, runtimeLogger, null)
      : asyncJobManager);
  const runtimeApprovalManager =
    deps.approvalManager ??
    (options.isolateState ? new ApprovalManager(undefined, runtimeLogger) : approvalManager);

  return {
    sessionManager: runtimeSessionManager,
    resourceProvider:
      deps.resourceProvider ??
      (options.isolateState
        ? new ResourceProvider(runtimeSessionManager, runtimePerformanceMetrics)
        : resourceProvider),
    db: "db" in deps ? (deps.db ?? null) : db,
    performanceMetrics: runtimePerformanceMetrics,
    asyncJobManager: runtimeAsyncJobManager,
    approvalManager: runtimeApprovalManager,
    flightRecorder: deps.flightRecorder ?? flightRecorder,
    logger: runtimeLogger,
    persistence: deps.persistence ?? persistenceConfig,
  };
}

// Per-CLI idle timeouts: kill process if no stdout/stderr activity for this duration.
// Claude idle timeout only applies in stream-json mode (with --include-partial-messages).
// In text/json mode, Claude produces no output until done, so idle timeout would false-positive.
const CLI_IDLE_TIMEOUTS: Record<string, number | undefined> = {
  claude: 600_000, // 10 minutes — only used when outputFormat=stream-json
  codex: 600_000, // 10 minutes — Codex streams stderr progress
  gemini: 600_000, // 10 minutes — Gemini streams stdout in real-time
  grok: 600_000, // 10 minutes — Grok streams stderr/stdout activity in headless mode
  mistral: 600_000, // 10 minutes — Vibe streams stdout/stderr in headless mode
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
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
  args: string[],
  corrId: string,
  idleTimeoutMs?: number,
  outputFormat?: string,
  forceRefresh?: boolean,
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime(),
  env?: Record<string, string>,
  onComplete?: () => void
): Promise<{ stdout: string; stderr: string; code: number } | DeferredJobResponse> {
  // U26 fix: ownership of onComplete is a contract. Once this function returns
  // OR throws, the caller MUST consider onComplete consumed — i.e. it has
  // either been run, or the AsyncJobManager has taken ownership of it. The
  // caller never needs to reclaim.
  let onCompleteOwnedByCaller = onComplete !== undefined;
  const consumeOnComplete = (): void => {
    if (!onCompleteOwnedByCaller || !onComplete) return;
    onCompleteOwnedByCaller = false;
    try {
      onComplete();
    } catch (err) {
      runtime.logger.error(`awaitJobOrDefer onComplete (${cli}) threw`, err);
    }
  };

  try {
    assertUpstreamCliArgs(cli, args);
    assertUpstreamCliEnv(cli, env);
  } catch (err) {
    consumeOnComplete();
    throw err;
  }

  if (SYNC_DEADLINE_MS === 0) {
    // Disabled — fall through to direct execution.
    // Note: direct execution bypasses dedup. forceRefresh is implied.
    const command = cli === "mistral" ? "vibe" : cli;
    try {
      return await executeCli(command, args, {
        idleTimeout: idleTimeoutMs,
        logger: runtime.logger,
        env: env ? ({ ...process.env, ...env } as NodeJS.ProcessEnv) : undefined,
      });
    } finally {
      // Direct-execution path completes inline; release per-request resources
      // (e.g. outputSchema temp files) here.
      consumeOnComplete();
    }
  }

  let outcome;
  try {
    outcome = runtime.asyncJobManager.startJobWithDedup(cli, args, corrId, {
      idleTimeoutMs,
      outputFormat,
      forceRefresh,
      env,
      onComplete,
    });
    // Handoff succeeded: AsyncJobManager owns onComplete (it'll fire via
    // fireOnComplete on terminal status, or run inline immediately for dedup).
    onCompleteOwnedByCaller = false;
  } catch (err) {
    // Spawn or pre-spawn failure inside AsyncJobManager. The record was never
    // registered, so onComplete will never be called by the manager. Reclaim
    // here so the temp file is not leaked.
    consumeOnComplete();
    throw err;
  }
  const job = outcome.snapshot;
  if (outcome.deduped) {
    runtime.logger.info(
      `[${corrId}] sync request deduped onto running job ${job.id} (original corrId=${outcome.originalCorrelationId})`
    );
  }
  const deadline = Date.now() + SYNC_DEADLINE_MS;

  while (Date.now() < deadline) {
    const snapshot = runtime.asyncJobManager.getJobSnapshot(job.id);
    if (snapshot && snapshot.status !== "running") {
      // Job finished within deadline — extract result
      const result = runtime.asyncJobManager.getJobResult(job.id);
      if (!result) {
        return { stdout: "", stderr: "Job result unavailable", code: 1 };
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr || result.error || "",
        code: result.exitCode ?? 1,
      };
    }
    await new Promise(resolve => setTimeout(resolve, SYNC_POLL_INTERVAL_MS));
  }

  // Deadline exceeded — return deferral
  runtime.logger.info(
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
  const isLaunchExit = code === 127 || code === -4058;

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
  } else if (isLaunchExit) {
    errorMessage += `:\n${stderr || `The '${cli}' command was not found. Install the ${cli} CLI and make sure it is on PATH.`}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI failed to launch`);
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
              : isLaunchExit
                ? "spawn_error"
                : "cli_error",
    },
  };
}

function extractUsageAndCost(
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
  output: string,
  outputFormat?: string
): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
} {
  if (cli === "claude" && outputFormat === "stream-json") {
    const parsed = parseStreamJson(output);
    if (!parsed.usage) {
      return { costUsd: parsed.costUsd ?? undefined };
    }
    return {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cacheReadTokens: parsed.usage.cacheReadInputTokens || undefined,
      cacheCreationTokens: parsed.usage.cacheCreationInputTokens || undefined,
      costUsd: parsed.costUsd ?? undefined,
    };
  }
  if (cli === "codex" && outputFormat === "json") {
    const parsed = parseCodexJsonStream(output);
    if (!parsed.usage) {
      return {};
    }
    return {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadTokens: parsed.usage.cache_read_tokens,
      cacheCreationTokens: parsed.usage.cache_creation_tokens,
      costUsd: parsed.usage.cost_usd,
    };
  }
  if (cli === "gemini" && outputFormat === "json") {
    const parsed = parseGeminiJson(output);
    if (!parsed || !parsed.usage) {
      return {};
    }
    return {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadTokens: parsed.usage.cache_read_tokens,
    };
  }
  // Mistral/Vibe: does not surface usage in its stdout/stream-json output. A
  // future unit can read it from `~/.vibe/logs/session/<id>/metadata.json`
  // once we resolve the session id post-run.
  return {};
}

function safeFlightStart(
  entry: Parameters<FlightRecorderLike["logStart"]>[0],
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): void {
  try {
    runtime.flightRecorder.logStart(entry);
  } catch (error) {
    runtime.logger.error("Flight recorder logStart failed", error);
  }
}

function safeFlightComplete(
  correlationId: string,
  result: Parameters<FlightRecorderLike["logComplete"]>[1],
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): void {
  try {
    runtime.flightRecorder.logComplete(correlationId, result);
  } catch (error) {
    runtime.logger.error("Flight recorder logComplete failed", error);
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

function registerBaseResources(server: McpServer, runtime: GatewayServerRuntime): void {
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
  runtime.logger.info(`Registered ${loadedSkills.length} skill resources`);

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
      runtime.logger.debug("Reading all sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Claude sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Codex sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Gemini sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading Grok sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );

  // Register Mistral sessions resource
  server.registerResource(
    "mistral-sessions",
    "sessions://mistral",
    {
      title: "🌬 Mistral Sessions",
      description: "Mistral Vibe conversation sessions",
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading Mistral sessions resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Claude models resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Codex models resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading Gemini models resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading Grok models resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );

  // Register Mistral models resource
  server.registerResource(
    "mistral-models",
    "models://mistral",
    {
      title: "🌬 Mistral Models",
      description: "Mistral Vibe models and capabilities",
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading Mistral models resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
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
      runtime.logger.debug("Reading performance metrics resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );
}

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

export function prepareClaudeRequest(
  params: {
    prompt: string;
    model?: string;
    outputFormat: "text" | "json" | "stream-json";
    allowedTools?: string[];
    disallowedTools?: string[];
    dangerouslySkipPermissions: boolean;
    permissionMode?: ClaudePermissionMode;
    approvalStrategy: "legacy" | "mcp_managed";
    approvalPolicy?: string;
    mcpServers?: ClaudeMcpServerName[];
    strictMcpConfig: boolean;
    correlationId?: string;
    optimizePrompt: boolean;
    operation: string;
    // U25: Claude high-impact features
    agent?: string;
    agents?: Record<string, unknown>;
    forkSession?: boolean;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    effort?: ClaudeEffortLevel;
    excludeDynamicSystemPromptSections?: boolean;
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
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
    runtime.logger.info(
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
    approvalDecision = runtime.approvalManager.decide({
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
  } else {
    const permFlags = resolveClaudePermissionFlags({
      permissionMode: params.permissionMode,
      dangerouslySkipPermissions: params.dangerouslySkipPermissions,
    });
    if (permFlags.warning) {
      runtime.logger.warn(`[${corrId}] ${permFlags.warning}`);
    }
    args.push(...permFlags.args);
  }
  if (params.strictMcpConfig || mcpConfig.enabled.length > 0) {
    args.push("--mcp-config", mcpConfig.path);
    if (params.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }

  // U25: Claude high-impact features (agent, agents, fork, system-prompt, budget, effort, …)
  let validatedAgents: Record<string, ClaudeAgentDefinition> | undefined;
  if (params.agents && Object.keys(params.agents).length > 0) {
    const result = validateClaudeAgentsMap(params.agents);
    if (!result.ok) {
      return createErrorResponse(
        "claude",
        1,
        "",
        corrId,
        new Error(result.message)
      ) as ExtendedToolResponse;
    }
    validatedAgents = result.value;
  }
  args.push(
    ...prepareClaudeHighImpactFlags({
      agent: params.agent,
      agents: validatedAgents,
      forkSession: params.forkSession,
      systemPrompt: params.systemPrompt,
      appendSystemPrompt: params.appendSystemPrompt,
      maxBudgetUsd: params.maxBudgetUsd,
      maxTurns: params.maxTurns,
      effort: params.effort,
      excludeDynamicSystemPromptSections: params.excludeDynamicSystemPromptSections,
    })
  );

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

export interface CodexRequestPrep extends CliRequestPrep {
  /**
   * U26: Cleanup hook for any `outputSchema` temp file written during prep.
   * Callers MUST invoke this in a `finally` block (regardless of whether the
   * spawn succeeded, failed, or never ran) to avoid leaking the 0o600 temp
   * file into `os.tmpdir()`.
   */
  cleanup?: () => void;
}

export function prepareCodexRequest(
  params: {
    prompt: string;
    model?: string;
    fullAuto: boolean;
    sandboxMode?: CodexSandboxMode;
    askForApproval?: CodexAskForApproval;
    useLegacyFullAutoFlag?: boolean;
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
    /**
     * U23: output format. When set to "json", emits `--json` so Codex streams
     * the JSONL event format that `parseCodexJsonStream` (and downstream
     * `extractUsageAndCost`) can consume. Defaults to "text".
     */
    outputFormat?: "text" | "json";
    // U26 high-impact params
    outputSchema?: string | Record<string, unknown>;
    search?: boolean;
    profile?: string;
    configOverrides?: Record<string, string>;
    ephemeral?: boolean;
    images?: string[];
    ignoreUserConfig?: boolean;
    ignoreRules?: boolean;
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CodexRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("codex", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({ prompt: params.prompt });
  if (reviewIntegrity.violations.length > 0) {
    runtime.logger.info(
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
    approvalDecision = runtime.approvalManager.decide({
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
      createNewSession: params.createNewSession,
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
  // Codex sandbox / approval: resolve modern flags + legacy fullAuto shorthand.
  // `codex exec resume` rejects all of these (the original session's policy is
  // inherited), so we only emit them when starting a NEW session.
  if (sessionPlan.mode === "new") {
    const sandboxFlags = resolveCodexSandboxFlags({
      sandboxMode: params.sandboxMode,
      askForApproval: params.askForApproval,
      fullAuto: params.fullAuto,
      useLegacyFullAutoFlag: params.useLegacyFullAutoFlag,
    });
    if (sandboxFlags.warning) {
      runtime.logger.warn(`[${corrId}] ${sandboxFlags.warning}`);
    }
    args.push(...sandboxFlags.args);
  }
  if (params.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  // U23 fix: emit `--json` when the caller asked for JSON output so the
  // codex-json-parser actually receives JSONL events. This is what makes
  // extractUsageAndCost() reachable from the tool surface; without it, the
  // U23 parser is dead code.
  if (params.outputFormat === "json") {
    args.push("--json");
  }
  args.push("--skip-git-repo-check");

  // U26: High-impact feature flags. Some of these (`--output-schema`,
  // `--search`, `-C`, `--add-dir`) are rejected by `codex exec resume`, so we
  // only emit them on a NEW session. Images / ephemeral / profile /
  // ignore-rules / ignore-user-config are allowed on resume per the audited
  // CLI help; we emit them in both branches.
  let highImpactCleanup: (() => void) | undefined;
  if (sessionPlan.mode === "new") {
    const high = prepareCodexHighImpactFlags({
      outputSchema: params.outputSchema,
      search: params.search,
      profile: params.profile,
      configOverrides: params.configOverrides,
      ephemeral: params.ephemeral,
      images: params.images,
      ignoreUserConfig: params.ignoreUserConfig,
      ignoreRules: params.ignoreRules,
    });
    if (high.missingImagePath) {
      return createErrorResponse(
        params.operation,
        1,
        "",
        corrId,
        new Error(`images: path does not exist: ${high.missingImagePath}`)
      );
    }
    args.push(...high.args);
    highImpactCleanup = high.cleanup;
  } else {
    // On resume, emit only the resume-safe subset (profile, ephemeral,
    // images, ignoreUserConfig, ignoreRules). outputSchema, search, and
    // configOverrides are dropped silently to mirror existing behavior for
    // sandbox/ask-for-approval on resume.
    const high = prepareCodexHighImpactFlags({
      profile: params.profile,
      ephemeral: params.ephemeral,
      images: params.images,
      ignoreUserConfig: params.ignoreUserConfig,
      ignoreRules: params.ignoreRules,
    });
    if (high.missingImagePath) {
      return createErrorResponse(
        params.operation,
        1,
        "",
        corrId,
        new Error(`images: path does not exist: ${high.missingImagePath}`)
      );
    }
    args.push(...high.args);
    highImpactCleanup = high.cleanup;
  }

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
    cleanup: highImpactCleanup,
  };
}

export function prepareGeminiRequest(
  params: {
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
    /**
     * U23: output format. When set to "json", emits `-o json` so Gemini emits
     * the JSON object containing usageMetadata that `parseGeminiJson` (and
     * downstream `extractUsageAndCost`) can consume. Defaults to "text".
     */
    outputFormat?: "text" | "json";
    // U27: high-impact features (all optional)
    sandbox?: boolean;
    policyFiles?: string[];
    adminPolicyFiles?: string[];
    attachments?: string[];
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("gemini", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: params.prompt,
    allowedTools: params.allowedTools,
  });
  if (reviewIntegrity.violations.length > 0) {
    runtime.logger.info(
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
    approvalDecision = runtime.approvalManager.decide({
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

  // U27: Validate high-impact policy paths and prepend attachment tokens
  // BEFORE the `-p` pair is emitted, preserving the U21 ordering invariant.
  const highImpact = prepareGeminiHighImpactFlags({
    sandbox: params.sandbox,
    policyFiles: params.policyFiles,
    adminPolicyFiles: params.adminPolicyFiles,
  });
  if (highImpact.missingPolicyPath) {
    return createErrorResponse(
      params.operation,
      1,
      "",
      corrId,
      new Error(
        `${highImpact.missingPolicyField}: path does not exist: ${highImpact.missingPolicyPath}`
      )
    );
  }

  if (params.attachments && params.attachments.length > 0) {
    try {
      effectivePrompt = prependGeminiAttachments(effectivePrompt, params.attachments);
    } catch (err) {
      return createErrorResponse(
        params.operation,
        1,
        "",
        corrId,
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  // U21: Emit the prompt via -p/--prompt rather than as a positional argument.
  // Positional prompts depend on Gemini's TTY/mode-detection heuristics; -p is
  // the documented non-interactive flag and is robust against future CLI mode
  // changes.
  const args = ["-p", effectivePrompt];
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
  // U27 high-impact flags (-s / --policy / --admin-policy) appended after the
  // existing flag set so positional ordering relative to `-p` is preserved.
  args.push(...highImpact.args);
  // U23 fix: emit `-o json` when the caller asked for JSON output. The Gemini
  // JSON parser is otherwise unreachable from the tool surface and the
  // structured usageMetadata is silently dropped.
  if (params.outputFormat === "json") {
    args.push("-o", "json");
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

function prepareGrokRequest(
  params: {
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
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("grok", params.model, cliInfo);

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: params.prompt,
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
  });
  if (reviewIntegrity.violations.length > 0) {
    runtime.logger.info(
      `[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`,
      {
        cli: "grok",
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
    approvalDecision = runtime.approvalManager.decide({
      cli: "grok",
      operation: params.operation,
      prompt: params.prompt, // Use raw prompt for review-context detection, not optimized
      bypassRequested:
        Boolean(params.alwaysApprove) || params.permissionMode === "bypassPermissions",
      fullAuto: false,
      requestedMcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: { model: resolvedModel || "default" },
      reviewIntegrity,
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  const effectiveAlwaysApprove =
    params.approvalStrategy === "mcp_managed" ? true : Boolean(params.alwaysApprove);

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

function prepareMistralRequest(
  params: {
    prompt: string;
    model?: string;
    outputFormat?: string;
    permissionMode?: MistralAgentMode;
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
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): (CliRequestPrep & { mistralEnv: Record<string, string> }) | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const requestedModel = params.model ?? (cliInfo.mistral.defaultModel ? "default" : undefined);
  const resolvedModel = resolveModelAlias("mistral", requestedModel, cliInfo);

  const reviewIntegrity = checkReviewIntegrity({
    prompt: params.prompt,
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
  });
  if (reviewIntegrity.violations.length > 0) {
    runtime.logger.info(
      `[${corrId}] Review integrity violations detected: ${reviewIntegrity.violations.map(v => v.type).join(", ")}`,
      {
        cli: "mistral",
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
    approvalDecision = runtime.approvalManager.decide({
      cli: "mistral",
      operation: params.operation,
      prompt: params.prompt,
      bypassRequested: params.permissionMode === "auto-approve",
      fullAuto: false,
      requestedMcpServers,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      policy: params.approvalPolicy as ApprovalPolicy | undefined,
      metadata: {
        model: resolvedModel ?? "vibe-default",
        vibeActiveModelEnv: Boolean(resolvedModel),
      },
      reviewIntegrity,
    });
    if (approvalDecision.status !== "approved") {
      return createApprovalDeniedResponse(params.operation, approvalDecision);
    }
  }

  // Under mcp_managed, force --agent auto-approve so the approval gate's
  // verdict carries through to the CLI invocation (mirrors Grok's --always-approve
  // forcing under mcp_managed).
  const effectivePermissionMode: MistralAgentMode =
    params.approvalStrategy === "mcp_managed"
      ? "auto-approve"
      : (params.permissionMode ?? "auto-approve");

  const prep = buildMistralCliInvocation({
    prompt: effectivePrompt,
    resolvedModel,
    outputFormat: params.outputFormat,
    permissionMode: effectivePermissionMode,
    effort: params.effort,
    reasoningEffort: params.reasoningEffort,
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
  });

  if (prep.ignoredDisallowedTools) {
    runtime.logger.info(
      `[${corrId}] Mistral does not support disallowedTools; ignoring (caller passed ${params.disallowedTools?.length ?? 0} entries)`
    );
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    approvalDecision,
    reviewIntegrity,
    args: prep.args,
    mistralEnv: prep.env,
  };
}

function isMistralModelSelectionFailure(stderr: string): boolean {
  return /active model ['"].+['"] not found|model ['"].+['"] (?:isn't|is not) found|unknown model|model not found/i.test(
    stderr
  );
}

function selectMistralRecoveryModel(failedModel: string | undefined): string | undefined {
  clearModelRegistryCache();
  const refreshed = getCliInfo(true).mistral;
  const candidates = [
    refreshed.defaultModel,
    ...(refreshed.modelOrder ?? []),
    ...Object.keys(refreshed.models),
  ].filter((model): model is string => Boolean(model && model !== failedModel));

  return candidates.find(model => model !== "local");
}

function buildCliResponse(
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
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
  /** U23: "json" emits `-o json` so token usage is parsed and reported. */
  outputFormat?: "text" | "json";
  // U27: high-impact features
  sandbox?: boolean;
  policyFiles?: string[];
  adminPolicyFiles?: string[];
  attachments?: string[];
}

export interface HandlerDeps {
  sessionManager: ISessionManager;
  logger: {
    info: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
  runtime?: GatewayServerRuntime;
}

export interface AsyncHandlerDeps extends HandlerDeps {
  asyncJobManager: AsyncJobManager;
}

function resolveHandlerRuntime(deps: HandlerDeps): GatewayServerRuntime {
  if (deps.runtime) return deps.runtime;
  const asyncDeps = deps as Partial<AsyncHandlerDeps>;
  // Older HandlerDeps callers may not provide `warn`; default-route to `info`.
  const depLogger = deps.logger;
  const normalizedLogger: GatewayLogger = {
    info: depLogger.info,
    warn:
      depLogger.warn ?? ((msg: string, ...rest: any[]) => depLogger.info(`[WARN] ${msg}`, ...rest)),
    error: depLogger.error,
    debug: depLogger.debug,
  };
  return resolveGatewayServerRuntime({
    sessionManager: deps.sessionManager,
    logger: normalizedLogger,
    asyncJobManager: asyncDeps.asyncJobManager,
  });
}

export async function handleGeminiRequest(
  deps: HandlerDeps,
  params: GeminiRequestParams
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const startTime = Date.now();
  const prep = prepareGeminiRequest(
    {
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
      outputFormat: params.outputFormat,
      sandbox: params.sandbox,
      policyFiles: params.policyFiles,
      adminPolicyFiles: params.adminPolicyFiles,
      attachments: params.attachments,
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args } = prep;
  let durationMs = 0;
  let wasSuccessful = false;
  safeFlightStart(
    {
      correlationId: corrId,
      cli: "gemini",
      model: prep.resolvedModel || "default",
      prompt: params.prompt,
      sessionId: params.sessionId,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] gemini_request invoked with model=${prep.resolvedModel || "default"}, approvalMode=${params.approvalMode}, prompt length=${params.prompt.length}`
  );

  try {
    // U27: Session arg planning. For fresh sessions, emit `--session-id <uuid>`
    // so the gateway and Gemini agree on the session identifier from turn 1.
    // For resume flows, fall back to `--resume <id>` (existing behavior).
    const sessionPlan = resolveGeminiSessionPlan({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionPlan.args);
    const userProvidedSession = sessionPlan.resumed;
    const effectiveSessionIdHint = sessionPlan.emittedSessionId ?? params.sessionId;

    const result = await awaitJobOrDefer(
      "gemini",
      args,
      corrId,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime
    );

    // Deferred — job still running, return async reference
    if (isDeferredResponse(result)) {
      return buildDeferredToolResponse(result, effectiveSessionIdHint);
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - startTime);

    if (code !== 0) {
      deps.logger.info(`[${corrId}] gemini_request failed in ${durationMs}ms`);
      safeFlightComplete(
        corrId,
        {
          response: stderr || "",
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          optimizationApplied: false,
          exitCode: code,
          errorMessage: stderr || `Exit code ${code}`,
          status: "failed",
        },
        runtime
      );
      return createErrorResponse("gemini", code, stderr, corrId);
    }
    wasSuccessful = true;

    // U27 Post-success session I/O. Mirror the gateway store 1:1 to whatever
    // session id Gemini is using (either the user-supplied resume id or the
    // deterministic --session-id we emitted).
    let effectiveSessionId = effectiveSessionIdHint;
    if (effectiveSessionId) {
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
      userProvidedSession,
      params.outputFormat
    );
    const geminiUsage = extractUsageAndCost("gemini", stdout, params.outputFormat);
    safeFlightComplete(
      corrId,
      {
        response: stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        approvalDecision: prep.approvalDecision?.status,
        optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
        exitCode: 0,
        status: "completed",
        inputTokens: geminiUsage.inputTokens,
        outputTokens: geminiUsage.outputTokens,
        cacheReadTokens: geminiUsage.cacheReadTokens,
        cacheCreationTokens: geminiUsage.cacheCreationTokens,
        costUsd: geminiUsage.costUsd,
      },
      runtime
    );
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startTime);
    deps.logger.info(`[${corrId}] gemini_request threw exception after ${elapsedMs}ms`);
    safeFlightComplete(
      corrId,
      {
        response: "",
        durationMs: elapsedMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 1,
        errorMessage: (error as Error).message,
        status: "failed",
      },
      runtime
    );
    return createErrorResponse("gemini", 1, "", corrId, error as Error);
  } finally {
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
    runtime.performanceMetrics.recordRequest("gemini", finalizedDurationMs, wasSuccessful);
  }
}

export async function handleGeminiRequestAsync(
  deps: AsyncHandlerDeps,
  params: Omit<GeminiRequestParams, "optimizeResponse">
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const prep = prepareGeminiRequest(
    {
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
      outputFormat: params.outputFormat,
      sandbox: params.sandbox,
      policyFiles: params.policyFiles,
      adminPolicyFiles: params.adminPolicyFiles,
      attachments: params.attachments,
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // U27: Session arg planning with deterministic --session-id for fresh sessions.
    const sessionPlan = resolveGeminiSessionPlan({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionPlan.args);

    // Pre-start session I/O (async handlers: prevent orphaned jobs)
    let effectiveSessionId = sessionPlan.emittedSessionId ?? params.sessionId;
    if (effectiveSessionId) {
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
    }

    // Start job only after all session I/O succeeds. U23: forward outputFormat
    // so AsyncJobManager records it in the durable store (the manager also
    // surfaces it in the snapshot).
    assertUpstreamCliArgs("gemini", args);
    assertUpstreamCliEnv("gemini", undefined);
    const job = deps.asyncJobManager.startJob(
      "gemini",
      args,
      corrId,
      undefined,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh
    );
    deps.logger.info(`[${corrId}] gemini_request_async started job ${job.id}`);

    const asyncResponse: Record<string, unknown> = {
      success: true,
      job,
      sessionId: effectiveSessionId || null,
      resumable: sessionPlan.resumed,
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
  const runtime = resolveHandlerRuntime(deps);
  const startTime = Date.now();
  const prep = prepareGrokRequest(
    {
      prompt: params.prompt,
      model: params.model,
      outputFormat: params.outputFormat,
      alwaysApprove: params.alwaysApprove,
      permissionMode: params.permissionMode,
      effort: params.effort,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "grok_request",
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args } = prep;
  let durationMs = 0;
  let wasSuccessful = false;
  safeFlightStart(
    {
      correlationId: corrId,
      cli: "grok",
      model: prep.resolvedModel || "default",
      prompt: params.prompt,
      sessionId: params.sessionId,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] grok_request invoked with model=${prep.resolvedModel || "default"}, permissionMode=${params.permissionMode}, prompt length=${params.prompt.length}`
  );

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveGrokSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionResult.resumeArgs);

    const result = await awaitJobOrDefer(
      "grok",
      args,
      corrId,
      resolveIdleTimeout("grok", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime
    );

    // Deferred — job still running, return async reference
    if (isDeferredResponse(result)) {
      return buildDeferredToolResponse(result, sessionResult.effectiveSessionId);
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - startTime);

    if (code !== 0) {
      deps.logger.info(`[${corrId}] grok_request failed in ${durationMs}ms`);
      safeFlightComplete(
        corrId,
        {
          response: stderr || "",
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          optimizationApplied: false,
          exitCode: code,
          errorMessage: stderr || `Exit code ${code}`,
          status: "failed",
        },
        runtime
      );
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
        "grok",
        "Grok Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    deps.logger.info(`[${corrId}] grok_request completed successfully in ${durationMs}ms`);
    const response = buildCliResponse(
      "grok",
      stdout,
      params.optimizeResponse ?? false,
      corrId,
      effectiveSessionId,
      prep,
      durationMs,
      sessionResult.userProvidedSession,
      params.outputFormat
    );
    safeFlightComplete(
      corrId,
      {
        response: stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        approvalDecision: prep.approvalDecision?.status,
        optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
        exitCode: 0,
        status: "completed",
      },
      runtime
    );
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startTime);
    deps.logger.info(`[${corrId}] grok_request threw exception after ${elapsedMs}ms`);
    safeFlightComplete(
      corrId,
      {
        response: "",
        durationMs: elapsedMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 1,
        errorMessage: (error as Error).message,
        status: "failed",
      },
      runtime
    );
    return createErrorResponse("grok", 1, "", corrId, error as Error);
  } finally {
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
    runtime.performanceMetrics.recordRequest("grok", finalizedDurationMs, wasSuccessful);
  }
}

export async function handleGrokRequestAsync(
  deps: AsyncHandlerDeps,
  params: Omit<GrokRequestParams, "optimizeResponse">
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const prep = prepareGrokRequest(
    {
      prompt: params.prompt,
      model: params.model,
      outputFormat: params.outputFormat,
      alwaysApprove: params.alwaysApprove,
      permissionMode: params.permissionMode,
      effort: params.effort,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "grok_request_async",
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveGrokSessionArgs({
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
          await deps.sessionManager.createSession("grok", "Grok Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "grok",
        "Grok Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    // Start job only after all session I/O succeeds
    assertUpstreamCliArgs("grok", args);
    assertUpstreamCliEnv("grok", undefined);
    const job = deps.asyncJobManager.startJob(
      "grok",
      args,
      corrId,
      undefined,
      resolveIdleTimeout("grok", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh
    );
    deps.logger.info(`[${corrId}] grok_request_async started job ${job.id}`);

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
    return createErrorResponse("grok_request_async", 1, "", corrId, error as Error);
  }
}

export interface MistralRequestParams {
  prompt: string;
  model?: string;
  outputFormat?: string;
  sessionId?: string;
  resumeLatest: boolean;
  createNewSession: boolean;
  permissionMode?: MistralAgentMode;
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

export async function handleMistralRequest(
  deps: HandlerDeps,
  params: MistralRequestParams
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const startTime = Date.now();
  const prep = prepareMistralRequest(
    {
      prompt: params.prompt,
      model: params.model,
      outputFormat: params.outputFormat,
      permissionMode: params.permissionMode,
      effort: params.effort,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "mistral_request",
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, mistralEnv } = prep;
  let durationMs = 0;
  let wasSuccessful = false;
  safeFlightStart(
    {
      correlationId: corrId,
      cli: "mistral",
      model: prep.resolvedModel || "default",
      prompt: params.prompt,
      sessionId: params.sessionId,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] mistral_request invoked with model=${prep.resolvedModel || "default"}, permissionMode=${params.permissionMode || "auto-approve"}, prompt length=${params.prompt.length}`
  );

  try {
    const sessionResult = resolveMistralSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionResult.resumeArgs);

    let result = await awaitJobOrDefer(
      "mistral",
      args,
      corrId,
      resolveIdleTimeout("mistral", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime,
      mistralEnv
    );

    if (isDeferredResponse(result)) {
      return buildDeferredToolResponse(result, sessionResult.effectiveSessionId);
    }

    if (result.code !== 0 && isMistralModelSelectionFailure(result.stderr)) {
      const recoveryModel = selectMistralRecoveryModel(prep.resolvedModel);
      if (recoveryModel) {
        deps.logger.info(
          `[${corrId}] mistral_request detected stale Vibe model selection; retrying once with ${recoveryModel}`
        );
        const retryPrep = buildMistralCliInvocation({
          prompt: prep.effectivePrompt,
          resolvedModel: recoveryModel,
          outputFormat: params.outputFormat,
          permissionMode:
            params.approvalStrategy === "mcp_managed"
              ? "auto-approve"
              : (params.permissionMode ?? "auto-approve"),
          effort: params.effort,
          reasoningEffort: params.reasoningEffort,
          allowedTools: params.allowedTools,
          disallowedTools: params.disallowedTools,
        });
        const retryArgs = [...retryPrep.args, ...sessionResult.resumeArgs];
        result = await awaitJobOrDefer(
          "mistral",
          retryArgs,
          corrId,
          resolveIdleTimeout("mistral", params.idleTimeoutMs),
          params.outputFormat,
          true,
          runtime,
          retryPrep.env
        );
        if (isDeferredResponse(result)) {
          return buildDeferredToolResponse(result, sessionResult.effectiveSessionId);
        }
        prep.resolvedModel = recoveryModel;
        prep.args = retryArgs;
      }
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - startTime);

    if (code !== 0) {
      deps.logger.info(`[${corrId}] mistral_request failed in ${durationMs}ms`);
      safeFlightComplete(
        corrId,
        {
          response: stderr || "",
          durationMs,
          retryCount: 0,
          circuitBreakerState: "closed",
          optimizationApplied: false,
          exitCode: code,
          errorMessage: stderr || `Exit code ${code}`,
          status: "failed",
        },
        runtime
      );
      return createErrorResponse("mistral", code, stderr, corrId);
    }
    wasSuccessful = true;

    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("mistral", "Mistral Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "mistral",
        "Mistral Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    deps.logger.info(`[${corrId}] mistral_request completed successfully in ${durationMs}ms`);
    const response = buildCliResponse(
      "mistral",
      stdout,
      params.optimizeResponse ?? false,
      corrId,
      effectiveSessionId,
      prep,
      durationMs,
      sessionResult.userProvidedSession,
      params.outputFormat
    );
    safeFlightComplete(
      corrId,
      {
        response: stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        approvalDecision: prep.approvalDecision?.status,
        optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
        exitCode: 0,
        status: "completed",
      },
      runtime
    );
    return response;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startTime);
    deps.logger.info(`[${corrId}] mistral_request threw exception after ${elapsedMs}ms`);
    safeFlightComplete(
      corrId,
      {
        response: "",
        durationMs: elapsedMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 1,
        errorMessage: (error as Error).message,
        status: "failed",
      },
      runtime
    );
    return createErrorResponse("mistral", 1, "", corrId, error as Error);
  } finally {
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
    runtime.performanceMetrics.recordRequest("mistral", finalizedDurationMs, wasSuccessful);
  }
}

export async function handleMistralRequestAsync(
  deps: AsyncHandlerDeps,
  params: Omit<MistralRequestParams, "optimizeResponse">
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const prep = prepareMistralRequest(
    {
      prompt: params.prompt,
      model: params.model,
      outputFormat: params.outputFormat,
      permissionMode: params.permissionMode,
      effort: params.effort,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "mistral_request_async",
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision, mistralEnv } = prep;

  try {
    const sessionResult = resolveMistralSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    args.push(...sessionResult.resumeArgs);

    let effectiveSessionId = sessionResult.effectiveSessionId;
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      const existing = await deps.sessionManager.getSession(effectiveSessionId);
      if (!existing) {
        try {
          await deps.sessionManager.createSession("mistral", "Mistral Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    } else if (!params.createNewSession && !effectiveSessionId) {
      const newSession = await deps.sessionManager.createSession(
        "mistral",
        "Mistral Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    assertUpstreamCliArgs("mistral", args);
    assertUpstreamCliEnv("mistral", mistralEnv);
    const job = deps.asyncJobManager.startJob(
      "mistral",
      args,
      corrId,
      undefined,
      resolveIdleTimeout("mistral", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      mistralEnv
    );
    deps.logger.info(`[${corrId}] mistral_request_async started job ${job.id}`);

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
    return createErrorResponse("mistral_request_async", 1, "", corrId, error as Error);
  }
}

export async function handleCodexRequestAsync(
  deps: AsyncHandlerDeps,
  params: {
    prompt: string;
    model?: string;
    fullAuto: boolean;
    sandboxMode?: CodexSandboxMode;
    askForApproval?: CodexAskForApproval;
    useLegacyFullAutoFlag?: boolean;
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
    /** U23: when "json", emits Codex `--json` so the parser is reachable. */
    outputFormat?: "text" | "json";
    outputSchema?: string | Record<string, unknown>;
    search?: boolean;
    profile?: string;
    configOverrides?: Record<string, string>;
    ephemeral?: boolean;
    images?: string[];
    ignoreUserConfig?: boolean;
    ignoreRules?: boolean;
  }
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const prep = prepareCodexRequest(
    {
      prompt: params.prompt,
      model: params.model,
      fullAuto: params.fullAuto,
      sandboxMode: params.sandboxMode,
      askForApproval: params.askForApproval,
      useLegacyFullAutoFlag: params.useLegacyFullAutoFlag,
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
      outputFormat: params.outputFormat,
      outputSchema: params.outputSchema,
      search: params.search,
      profile: params.profile,
      configOverrides: params.configOverrides,
      ephemeral: params.ephemeral,
      images: params.images,
      ignoreUserConfig: params.ignoreUserConfig,
      ignoreRules: params.ignoreRules,
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  // U26 fix: outputSchema temp-file ownership. The cleanup callable lives in
  // exactly one place at a time: this scope until startJob succeeds, then
  // AsyncJobManager (via onComplete → persistComplete → fireOnComplete) once
  // the job is registered. Any code path that fails to hand it off MUST run
  // it locally.
  const prepCleanup =
    "cleanup" in prep && typeof prep.cleanup === "function" ? prep.cleanup : undefined;
  let prepCleanupOwnedHere = prepCleanup !== undefined;
  const runPrepCleanupLocally = (): void => {
    if (!prepCleanupOwnedHere || !prepCleanup) return;
    prepCleanupOwnedHere = false;
    try {
      prepCleanup();
    } catch (err) {
      deps.logger.error(`[${corrId}] codex_request_async outputSchema cleanup threw`, err);
    }
  };

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

    // Start job only after all session I/O succeeds. If startJob throws before
    // registering the record, ownership stays here and we run it in the catch.
    assertUpstreamCliArgs("codex", args);
    assertUpstreamCliEnv("codex", undefined);
    let job;
    try {
      job = deps.asyncJobManager.startJob(
        "codex",
        args,
        corrId,
        undefined,
        resolveIdleTimeout("codex", params.idleTimeoutMs),
        params.outputFormat,
        params.forceRefresh,
        undefined,
        prepCleanup
      );
      // Handoff succeeded: AsyncJobManager will fire prepCleanup on terminal
      // status. Release our local ownership claim so the catch path doesn't
      // double-fire.
      prepCleanupOwnedHere = false;
    } catch (startErr) {
      // startJob never stored the record → manager won't call onComplete. We
      // still own the cleanup; let the outer catch run it.
      throw startErr;
    }
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
    // Pre-start failure: either session I/O threw, or startJob threw before
    // registering the record. In either case the manager will NOT fire
    // prepCleanup, so we must run it here.
    runPrepCleanupLocally();
    return createErrorResponse("codex_request_async", 1, "", corrId, error as Error);
  }
}

//──────────────────────────────────────────────────────────────────────────────
// Claude Code Tool
//──────────────────────────────────────────────────────────────────────────────

export function createGatewayServer(deps: GatewayServerDeps = {}): McpServer {
  const runtime = resolveGatewayServerRuntime(deps, { isolateState: true });
  const {
    sessionManager,
    asyncJobManager,
    approvalManager,
    performanceMetrics,
    logger,
    persistence,
  } = runtime;
  // Structural invariant: tools register iff ALL THREE conditions hold:
  //   (1) persistence.backend !== "none"  — the operator/config has not
  //       explicitly disabled durable persistence;
  //   (2) persistence.asyncJobsEnabled === true — the derived opt-in flag
  //       agrees (loadPersistenceConfig sets this iff backend is one of
  //       sqlite/postgres/memory);
  //   (3) asyncJobManager.hasStore() === true — the runtime manager
  //       actually has a store attached (isolate-mode runtimes use null).
  //
  // Each guard closes a distinct re-entry path for the silent-loss footgun:
  //   - Without (1), a caller can inject {backend:'none', asyncJobsEnabled:true}
  //     and re-advertise the async tools while reporting backend='none' in
  //     llm_process_health — exactly contradicting SPEC CLAIM 4f.
  //   - Without (2), config that opts out is ignored.
  //   - Without (3), a null-store manager (isolate-mode / HTTP per-session)
  //     accepts registrations that have nowhere to persist results.
  const asyncJobsEnabled =
    persistence.backend !== "none" && persistence.asyncJobsEnabled && asyncJobManager.hasStore();
  const server = newGatewayMcpServer();
  registerBaseResources(server, runtime);
  registerValidationTools(server, { asyncJobManager });

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
        .describe(
          'DEPRECATED: prefer `permissionMode: "bypassPermissions"`. Maps to it when `permissionMode` is unset.'
        ),
      permissionMode: z
        .enum(CLAUDE_PERMISSION_MODES)
        .optional()
        .describe(
          "Claude --permission-mode: default|acceptEdits|plan|auto|dontAsk|bypassPermissions. `default` is a no-op (no flag emitted)."
        ),
      // U25 — Claude high-impact features
      agent: z
        .string()
        .optional()
        .describe("Claude --agent: dispatch to a named single sub-agent."),
      agents: z
        .record(z.record(z.unknown()))
        .optional()
        .describe(
          "Claude --agents: inline JSON map of agent name → { description, prompt, tools?, model? }."
        ),
      forkSession: z
        .boolean()
        .optional()
        .describe("Claude --fork-session: branch from an existing session into a fresh fork."),
      systemPrompt: z
        .string()
        .optional()
        .describe("Claude --system-prompt: replace the system prompt entirely."),
      appendSystemPrompt: z
        .string()
        .optional()
        .describe("Claude --append-system-prompt: append to the existing system prompt."),
      maxBudgetUsd: z
        .number()
        .positive()
        .optional()
        .describe("Claude --max-budget-usd: spend cap for this request in USD."),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Claude --max-turns: cap on agent loop iterations."),
      effort: z
        .enum(CLAUDE_EFFORT_LEVELS)
        .optional()
        .describe("Claude --effort: low|medium|high|xhigh|max."),
      excludeDynamicSystemPromptSections: z
        .boolean()
        .optional()
        .describe(
          "Claude --exclude-dynamic-system-prompt-sections: trim dynamic context blocks from the system prompt."
        ),
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
        .describe(
          "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
        ),
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
      permissionMode,
      agent,
      agents,
      forkSession,
      systemPrompt,
      appendSystemPrompt,
      maxBudgetUsd,
      maxTurns,
      effort,
      excludeDynamicSystemPromptSections,
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
      if (systemPrompt !== undefined && appendSystemPrompt !== undefined) {
        return createErrorResponse(
          "claude",
          1,
          "",
          correlationId,
          new Error(
            "systemPrompt and appendSystemPrompt are mutually exclusive; use one or the other (not both)."
          )
        );
      }
      const prep = prepareClaudeRequest(
        {
          prompt,
          model,
          outputFormat,
          allowedTools,
          disallowedTools,
          dangerouslySkipPermissions,
          permissionMode,
          approvalStrategy,
          approvalPolicy,
          mcpServers,
          strictMcpConfig,
          correlationId,
          optimizePrompt,
          operation: "claude_request",
          agent,
          agents,
          forkSession,
          systemPrompt,
          appendSystemPrompt,
          maxBudgetUsd,
          maxTurns,
          effort,
          excludeDynamicSystemPromptSections,
        },
        runtime
      );
      if (!("args" in prep)) return prep;

      const { corrId, args } = prep;
      let durationMs = 0;
      let wasSuccessful = false;
      safeFlightStart(
        {
          correlationId: corrId,
          cli: "claude",
          model: prep.resolvedModel || "default",
          prompt,
          sessionId,
        },
        runtime
      );
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
          forceRefresh,
          runtime
        );

        // Deferred — job still running, return async reference
        if (isDeferredResponse(result)) {
          return buildDeferredToolResponse(result, effectiveSessionId);
        }

        const { stdout, stderr, code } = result;
        durationMs = Math.max(0, Date.now() - startTime);

        if (code !== 0) {
          logger.info(`[${corrId}] claude_request failed in ${durationMs}ms`);
          safeFlightComplete(
            corrId,
            {
              response: stderr || "",
              durationMs,
              retryCount: 0,
              circuitBreakerState: "closed",
              optimizationApplied: optimizePrompt || optimizeResponse,
              exitCode: code,
              errorMessage: stderr || `Exit code ${code}`,
              status: "failed",
            },
            runtime
          );
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
          safeFlightComplete(
            corrId,
            {
              response: parsed.text,
              inputTokens: parsed.usage?.inputTokens,
              outputTokens: parsed.usage?.outputTokens,
              cacheReadTokens: parsed.usage?.cacheReadInputTokens || undefined,
              cacheCreationTokens: parsed.usage?.cacheCreationInputTokens || undefined,
              durationMs,
              retryCount: 0,
              circuitBreakerState: "closed",
              costUsd: parsed.costUsd ?? undefined,
              optimizationApplied: optimizePrompt || optimizeResponse,
              exitCode: 0,
              status: "completed",
            },
            runtime
          );
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
        safeFlightComplete(
          corrId,
          {
            response: stdout,
            durationMs,
            retryCount: 0,
            circuitBreakerState: "closed",
            optimizationApplied: optimizePrompt || optimizeResponse,
            exitCode: 0,
            status: "completed",
          },
          runtime
        );
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
        safeFlightComplete(
          corrId,
          {
            response: "",
            durationMs: elapsedMs,
            retryCount: 0,
            circuitBreakerState: "closed",
            optimizationApplied: optimizePrompt || optimizeResponse,
            exitCode: 1,
            errorMessage: (error as Error).message,
            status: "failed",
          },
          runtime
        );
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
      fullAuto: z
        .boolean()
        .default(false)
        .describe(
          "DEPRECATED: prefer `sandboxMode` + `askForApproval`. Expands to `--sandbox workspace-write --ask-for-approval never`."
        ),
      sandboxMode: z
        .enum(CODEX_SANDBOX_MODES)
        .optional()
        .describe("Codex --sandbox: read-only|workspace-write|danger-full-access."),
      askForApproval: z
        .enum(CODEX_ASK_FOR_APPROVAL_MODES)
        .optional()
        .describe("Codex --ask-for-approval: untrusted|on-request|never."),
      useLegacyFullAutoFlag: z
        .boolean()
        .default(false)
        .describe("Escape hatch: emit `--full-auto` directly instead of expanding (deprecated)."),
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
        .describe(
          "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
        ),
      // U23: emit `--json` so the codex-json-parser surfaces input/output/cache
      // tokens (and any cost) through extractUsageAndCost. Without "json", the
      // parser is unreachable and Codex usage is never reported.
      outputFormat: z
        .enum(["text", "json"])
        .default("text")
        .describe(
          "Codex output format. `json` emits --json (JSONL events) so token usage and cost are parsed and reported in the flight recorder. `text` is the default."
        ),
      // U26: high-impact feature flags. All optional.
      outputSchema: z
        .union([z.string(), z.record(z.unknown())])
        .optional()
        .describe(
          "Codex --output-schema. Pass a path (string) or an inline JSON Schema object; object is materialised to a 0o600 temp file under os.tmpdir() and deleted after the run."
        ),
      search: z.boolean().optional().describe("Emit Codex --search to enable web search."),
      profile: z
        .string()
        .optional()
        .describe("Codex --profile <name>: select a profile from ~/.codex/config.toml."),
      configOverrides: CODEX_CONFIG_OVERRIDES_SCHEMA.describe(
        "Codex -c key=value overrides. Keys: /^[a-zA-Z0-9._]+$/. Values: no CR/LF."
      ),
      ephemeral: z
        .boolean()
        .optional()
        .describe("Codex --ephemeral: do not persist the session to disk."),
      images: z
        .array(z.string())
        .optional()
        .describe(
          "Codex -i <path>: image attachments. Each path must exist; missing paths fail fast."
        ),
      ignoreUserConfig: z
        .boolean()
        .optional()
        .describe("Codex --ignore-user-config: ignore ~/.codex/config.toml for this run."),
      ignoreRules: z
        .boolean()
        .optional()
        .describe("Codex --ignore-rules: skip project rule files for this run."),
    },
    async ({
      prompt,
      model,
      fullAuto,
      sandboxMode,
      askForApproval,
      useLegacyFullAutoFlag,
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
      outputFormat,
      outputSchema,
      search,
      profile,
      configOverrides,
      ephemeral,
      images,
      ignoreUserConfig,
      ignoreRules,
    }) => {
      const startTime = Date.now();
      const prep = prepareCodexRequest(
        {
          prompt,
          model,
          fullAuto,
          sandboxMode,
          askForApproval,
          useLegacyFullAutoFlag,
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
          outputFormat,
          outputSchema,
          search,
          profile,
          configOverrides,
          ephemeral,
          images,
          ignoreUserConfig,
          ignoreRules,
        },
        runtime
      );
      if (!("args" in prep)) return prep;

      const { corrId, args } = prep;
      let durationMs = 0;
      let wasSuccessful = false;
      safeFlightStart(
        {
          correlationId: corrId,
          cli: "codex",
          model: prep.resolvedModel || "default",
          prompt,
          sessionId,
        },
        runtime
      );
      logger.info(
        `[${corrId}] codex_request invoked with model=${prep.resolvedModel || "default"}, fullAuto=${fullAuto}, prompt length=${prompt.length}`
      );

      // U26 fix: pass the outputSchema cleanup to awaitJobOrDefer, which
      // guarantees the cleanup runs exactly once — inline for direct
      // execution, on terminal status for the job-backed path (sync
      // completion or deferred). The outer finally MUST NOT clean again.
      const prepCleanup =
        "cleanup" in prep && typeof prep.cleanup === "function" ? prep.cleanup : undefined;

      try {
        const result = await awaitJobOrDefer(
          "codex",
          args,
          corrId,
          resolveIdleTimeout("codex", idleTimeoutMs),
          outputFormat,
          forceRefresh,
          runtime,
          undefined,
          prepCleanup
        );

        // Deferred — job still running, return async reference. Cleanup
        // ownership belongs to AsyncJobManager via onComplete.
        if (isDeferredResponse(result)) {
          return buildDeferredToolResponse(result, sessionId);
        }

        const { stdout, stderr, code } = result;
        durationMs = Math.max(0, Date.now() - startTime);

        if (code !== 0) {
          logger.info(`[${corrId}] codex_request failed in ${durationMs}ms`);
          safeFlightComplete(
            corrId,
            {
              response: stderr || "",
              durationMs,
              retryCount: 0,
              circuitBreakerState: "closed",
              optimizationApplied: optimizePrompt || optimizeResponse,
              exitCode: code,
              errorMessage: stderr || `Exit code ${code}`,
              status: "failed",
            },
            runtime
          );
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
        const codexUsage = extractUsageAndCost("codex", stdout, outputFormat);
        safeFlightComplete(
          corrId,
          {
            response: stdout,
            durationMs,
            retryCount: 0,
            circuitBreakerState: "closed",
            optimizationApplied: optimizePrompt || optimizeResponse,
            exitCode: 0,
            status: "completed",
            inputTokens: codexUsage.inputTokens,
            outputTokens: codexUsage.outputTokens,
            cacheReadTokens: codexUsage.cacheReadTokens,
            cacheCreationTokens: codexUsage.cacheCreationTokens,
            costUsd: codexUsage.costUsd,
          },
          runtime
        );
        return buildCliResponse(
          "codex",
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
        logger.info(`[${corrId}] codex_request threw exception after ${elapsedMs}ms`);
        safeFlightComplete(
          corrId,
          {
            response: "",
            durationMs: elapsedMs,
            retryCount: 0,
            circuitBreakerState: "closed",
            optimizationApplied: optimizePrompt || optimizeResponse,
            exitCode: 1,
            errorMessage: (error as Error).message,
            status: "failed",
          },
          runtime
        );
        return createErrorResponse("codex", 1, "", corrId, error as Error);
      } finally {
        const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
        performanceMetrics.recordRequest("codex", finalizedDurationMs, wasSuccessful);
        // Cleanup is owned by awaitJobOrDefer's contract; nothing to do here.
      }
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // U26: codex_fork_session — `codex fork <SESSION_ID|--last> <prompt>`
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "codex_fork_session",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .describe("Prompt text for the forked Codex session"),
      sessionId: z
        .string()
        .optional()
        .describe("Codex session UUID to fork from. Mutually exclusive with `forkLast`."),
      forkLast: z
        .boolean()
        .optional()
        .describe("Fork from the most recent Codex session. Mutually exclusive with `sessionId`."),
      model: z.string().optional().describe("Model name or alias (e.g. gpt-5.5, latest)"),
      sandboxMode: z
        .enum(CODEX_SANDBOX_MODES)
        .optional()
        .describe("Codex --sandbox: read-only|workspace-write|danger-full-access."),
      askForApproval: z
        .enum(CODEX_ASK_FOR_APPROVAL_MODES)
        .optional()
        .describe("Codex --ask-for-approval: untrusted|on-request|never."),
      correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
      idleTimeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(3_600_000)
        .optional()
        .describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
    },
    async ({
      prompt,
      sessionId,
      forkLast,
      model,
      sandboxMode,
      askForApproval,
      correlationId,
      idleTimeoutMs,
    }) => {
      const corrId = correlationId || randomUUID();
      const startTime = Date.now();
      let durationMs = 0;
      let wasSuccessful = false;

      // Enforce mutual exclusion at tool boundary (Zod records the params but
      // the SDK's `.tool(...)` does not accept top-level refines).
      if (sessionId && forkLast) {
        return createErrorResponse(
          "codex_fork_session",
          1,
          "",
          corrId,
          new Error("sessionId and forkLast are mutually exclusive")
        );
      }
      if (!sessionId && !forkLast) {
        return createErrorResponse(
          "codex_fork_session",
          1,
          "",
          corrId,
          new Error("one of sessionId or forkLast is required")
        );
      }

      let forkArgs: string[];
      try {
        forkArgs = prepareCodexForkRequest({ prompt, sessionId, forkLast }).args;
      } catch (err) {
        return createErrorResponse("codex_fork_session", 1, "", corrId, err as Error);
      }

      const cliInfo = getCliInfo();
      const resolvedModel = resolveModelAlias("codex", model, cliInfo);

      // Compose argv: forkArgs already starts with `fork`. Inject model and
      // sandbox/approval flags BEFORE the positional <sessionId|--last> +
      // prompt to keep them as flags rather than positionals. forkArgs layout
      // is either ["fork", "--last", prompt] or ["fork", sessionId, prompt];
      // we splice flags right after "fork".
      const flagSegment: string[] = [];
      if (resolvedModel) flagSegment.push("--model", resolvedModel);
      const sandboxFlags = resolveCodexSandboxFlags({
        sandboxMode,
        askForApproval,
      });
      if (sandboxFlags.warning) {
        logger.warn(`[${corrId}] ${sandboxFlags.warning}`);
      }
      flagSegment.push(...sandboxFlags.args);

      const finalArgs = [forkArgs[0], ...flagSegment, ...forkArgs.slice(1)];

      logger.info(
        `[${corrId}] codex_fork_session invoked (forkLast=${Boolean(forkLast)}, sessionId=${sessionId ? "set" : "unset"})`
      );

      try {
        const result = await awaitJobOrDefer(
          "codex",
          finalArgs,
          corrId,
          resolveIdleTimeout("codex", idleTimeoutMs),
          undefined,
          false,
          runtime
        );

        if (isDeferredResponse(result)) {
          return buildDeferredToolResponse(result, sessionId);
        }

        const { stdout, stderr, code } = result;
        durationMs = Math.max(0, Date.now() - startTime);
        if (code !== 0) {
          return createErrorResponse("codex", code, stderr, corrId);
        }
        wasSuccessful = true;
        return {
          content: [{ type: "text" as const, text: stdout }],
        };
      } catch (error) {
        return createErrorResponse("codex_fork_session", 1, "", corrId, error as Error);
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
        .enum(GEMINI_APPROVAL_MODES)
        .optional()
        .describe("Approval: default|auto_edit|yolo|plan"),
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
        .describe(
          "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
        ),
      // U23: emit `-o json` to extract token usage via parseGeminiJson. Default
      // remains text so existing callers see no behavior change.
      outputFormat: z
        .enum(["text", "json"])
        .default("text")
        .describe(
          "Gemini output format. `json` emits `-o json` so usageMetadata is parsed and reported."
        ),
      sandbox: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.sandbox.describe(
        "Run Gemini in sandbox mode (-s)"
      ),
      policyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.policyFiles.describe(
        "Policy file paths (--policy <path>, one per file). Paths must exist."
      ),
      adminPolicyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.adminPolicyFiles.describe(
        "Admin policy file paths (--admin-policy <path>, one per file). Paths must exist."
      ),
      attachments: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.attachments.describe(
        "Absolute file paths prepended as @<path> tokens to the prompt"
      ),
    },
    async ({
      prompt,
      model,
      sessionId,
      resumeLatest,
      createNewSession,
      approvalMode,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      allowedTools,
      includeDirs,
      correlationId,
      optimizePrompt,
      optimizeResponse,
      idleTimeoutMs,
      forceRefresh,
      outputFormat,
      sandbox,
      policyFiles,
      adminPolicyFiles,
      attachments,
    }) => {
      return handleGeminiRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          model,
          sessionId,
          resumeLatest,
          createNewSession,
          approvalMode,
          approvalStrategy,
          approvalPolicy,
          mcpServers,
          allowedTools,
          includeDirs,
          correlationId,
          optimizePrompt,
          optimizeResponse,
          idleTimeoutMs,
          forceRefresh,
          outputFormat,
          sandbox,
          policyFiles,
          adminPolicyFiles,
          attachments,
        }
      );
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Grok Tool
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "grok_request",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .describe("Prompt text for Grok"),
      model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
      outputFormat: z
        .enum(["plain", "json", "streaming-json"])
        .optional()
        .describe("Output format (plain|json|streaming-json). Grok default is plain."),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (user-provided CLI handle for --resume)"),
      resumeLatest: z
        .boolean()
        .default(false)
        .describe("Resume most recent Grok session in cwd (--continue)"),
      createNewSession: z.boolean().default(false).describe("Force new session"),
      alwaysApprove: z
        .boolean()
        .default(false)
        .describe("Auto-approve all tool executions (--always-approve)"),
      permissionMode: z
        .enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])
        .optional()
        .describe("Grok permission mode"),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Grok effort level"),
      reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
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
        .describe(
          "MCP server names for approval tracking (Grok manages its own MCP config via `grok mcp`)"
        ),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Allowed built-in tools (passed as --tools comma list)"),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe("Disallowed built-in tools (passed as --disallowed-tools comma list)"),
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
        .describe(
          "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
        ),
    },
    async ({
      prompt,
      model,
      outputFormat,
      sessionId,
      resumeLatest,
      createNewSession,
      alwaysApprove,
      permissionMode,
      effort,
      reasoningEffort,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      allowedTools,
      disallowedTools,
      correlationId,
      optimizePrompt,
      optimizeResponse,
      idleTimeoutMs,
      forceRefresh,
    }) => {
      return handleGrokRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          model,
          outputFormat,
          sessionId,
          resumeLatest,
          createNewSession,
          alwaysApprove,
          permissionMode,
          effort,
          reasoningEffort,
          approvalStrategy,
          approvalPolicy,
          mcpServers,
          allowedTools,
          disallowedTools,
          correlationId,
          optimizePrompt,
          optimizeResponse,
          idleTimeoutMs,
          forceRefresh,
        }
      );
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Mistral Vibe Tool
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "mistral_request",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .describe("Prompt text for Mistral Vibe"),
      model: z
        .string()
        .optional()
        .describe(
          "Model alias (e.g. mistral-medium-3.5, latest). Resolved alias is injected via VIBE_ACTIVE_MODEL env var; Vibe has no --model flag."
        ),
      outputFormat: z
        .enum(["plain", "json", "stream-json"])
        .optional()
        .describe("Output format (plain|json|stream-json). Vibe default is plain."),
      sessionId: z
        .string()
        .optional()
        .describe(
          "Session ID (user-provided CLI handle for --resume). Requires [session_logging] enabled = true in ~/.vibe/config.toml."
        ),
      resumeLatest: z
        .boolean()
        .default(false)
        .describe("Resume most recent Vibe session in cwd (--continue)"),
      createNewSession: z.boolean().default(false).describe("Force new session"),
      permissionMode: z
        .enum(MISTRAL_AGENT_MODES)
        .optional()
        .describe(
          "Vibe agent mode (default|plan|accept-edits|auto-approve|chat|explore|lean). Defaults to auto-approve for programmatic use."
        ),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Vibe effort level"),
      reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
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
        .describe(
          "MCP server names for approval tracking (Vibe manages its own MCP config via `vibe mcp`)"
        ),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Allowlist of built-in tools — each emitted as a separate --enabled-tools <tool> flag"
        ),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Accepted for caller parity; Vibe has no deny-list flag, so values are ignored (a warning is logged)."
        ),
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
        .describe(
          "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
        ),
    },
    async ({
      prompt,
      model,
      outputFormat,
      sessionId,
      resumeLatest,
      createNewSession,
      permissionMode,
      effort,
      reasoningEffort,
      approvalStrategy,
      approvalPolicy,
      mcpServers,
      allowedTools,
      disallowedTools,
      correlationId,
      optimizePrompt,
      optimizeResponse,
      idleTimeoutMs,
      forceRefresh,
    }) => {
      return handleMistralRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          model,
          outputFormat,
          sessionId,
          resumeLatest,
          createNewSession,
          permissionMode,
          effort,
          reasoningEffort,
          approvalStrategy,
          approvalPolicy,
          mcpServers,
          allowedTools,
          disallowedTools,
          correlationId,
          optimizePrompt,
          optimizeResponse,
          idleTimeoutMs,
          forceRefresh,
        }
      );
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Async Long-Running Job Tools (No Time-Bound LLM Execution)
  //
  // STRUCTURAL INVARIANT: these tools are only registered when a real job
  // store is attached (`persistence.asyncJobsEnabled === true`). When the
  // operator has configured `[persistence].backend = "none"`, none of the
  // *_request_async / llm_job_* tools exist in the MCP tool list at all —
  // orchestrating agents get a clean "tool not found" signal at connect
  // time instead of silent in-memory loss after the 1-hour TTL.
  //──────────────────────────────────────────────────────────────────────────────

  if (asyncJobsEnabled) {
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
          .describe(
            "Output format (text|json|stream-json). stream-json: NDJSON with idle timeout."
          ),
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
          .describe(
            'DEPRECATED: prefer `permissionMode: "bypassPermissions"`. Maps to it when `permissionMode` is unset.'
          ),
        permissionMode: z
          .enum(CLAUDE_PERMISSION_MODES)
          .optional()
          .describe(
            "Claude --permission-mode: default|acceptEdits|plan|auto|dontAsk|bypassPermissions. `default` is a no-op."
          ),
        // U25 — Claude high-impact features
        agent: z
          .string()
          .optional()
          .describe("Claude --agent: dispatch to a named single sub-agent."),
        agents: z
          .record(z.record(z.unknown()))
          .optional()
          .describe(
            "Claude --agents: inline JSON map of agent name → { description, prompt, tools?, model? }."
          ),
        forkSession: z
          .boolean()
          .optional()
          .describe("Claude --fork-session: branch from an existing session into a fresh fork."),
        systemPrompt: z
          .string()
          .optional()
          .describe("Claude --system-prompt: replace the system prompt entirely."),
        appendSystemPrompt: z
          .string()
          .optional()
          .describe("Claude --append-system-prompt: append to the existing system prompt."),
        maxBudgetUsd: z
          .number()
          .positive()
          .optional()
          .describe("Claude --max-budget-usd: spend cap for this request in USD."),
        maxTurns: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Claude --max-turns: cap on agent loop iterations."),
        effort: z
          .enum(CLAUDE_EFFORT_LEVELS)
          .optional()
          .describe("Claude --effort: low|medium|high|xhigh|max."),
        excludeDynamicSystemPromptSections: z
          .boolean()
          .optional()
          .describe(
            "Claude --exclude-dynamic-system-prompt-sections: trim dynamic context blocks from the system prompt."
          ),
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
          .describe(
            "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
          ),
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
        permissionMode,
        agent,
        agents,
        forkSession,
        systemPrompt,
        appendSystemPrompt,
        maxBudgetUsd,
        maxTurns,
        effort,
        excludeDynamicSystemPromptSections,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        strictMcpConfig,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
      }) => {
        if (systemPrompt !== undefined && appendSystemPrompt !== undefined) {
          return createErrorResponse(
            "claude",
            1,
            "",
            correlationId,
            new Error(
              "systemPrompt and appendSystemPrompt are mutually exclusive; use one or the other (not both)."
            )
          );
        }
        const prep = prepareClaudeRequest(
          {
            prompt,
            model,
            outputFormat,
            allowedTools,
            disallowedTools,
            dangerouslySkipPermissions,
            permissionMode,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            strictMcpConfig,
            correlationId,
            optimizePrompt,
            operation: "claude_request_async",
            agent,
            agents,
            forkSession,
            systemPrompt,
            appendSystemPrompt,
            maxBudgetUsd,
            maxTurns,
            effort,
            excludeDynamicSystemPromptSections,
          },
          runtime
        );
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
          const effectiveIdleTimeout =
            outputFormat === "stream-json"
              ? resolveIdleTimeout("claude", idleTimeoutMs)
              : undefined;
          assertUpstreamCliArgs("claude", args);
          assertUpstreamCliEnv("claude", undefined);
          const job = asyncJobManager.startJob(
            "claude",
            args,
            corrId,
            undefined,
            effectiveIdleTimeout,
            outputFormat,
            forceRefresh
          );
          logger.info(
            `[${corrId}] claude_request_async started job ${job.id}, outputFormat=${outputFormat}`
          );

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
        fullAuto: z
          .boolean()
          .default(false)
          .describe(
            "DEPRECATED: prefer `sandboxMode` + `askForApproval`. Expands to `--sandbox workspace-write --ask-for-approval never`."
          ),
        sandboxMode: z
          .enum(CODEX_SANDBOX_MODES)
          .optional()
          .describe("Codex --sandbox: read-only|workspace-write|danger-full-access."),
        askForApproval: z
          .enum(CODEX_ASK_FOR_APPROVAL_MODES)
          .optional()
          .describe("Codex --ask-for-approval: untrusted|on-request|never."),
        useLegacyFullAutoFlag: z
          .boolean()
          .default(false)
          .describe("Escape hatch: emit `--full-auto` directly (deprecated)."),
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
          .describe(
            "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
          ),
        // U23: emit `--json` to enable JSONL event-stream parsing for token usage.
        outputFormat: z
          .enum(["text", "json"])
          .default("text")
          .describe(
            "Codex output format. `json` emits --json (JSONL events) for token usage extraction."
          ),
        // U26: high-impact feature flags. All optional.
        outputSchema: z
          .union([z.string(), z.record(z.unknown())])
          .optional()
          .describe("Codex --output-schema. Pass a path (string) or an inline JSON Schema object."),
        search: z.boolean().optional().describe("Emit Codex --search to enable web search."),
        profile: z.string().optional().describe("Codex --profile <name>."),
        configOverrides: CODEX_CONFIG_OVERRIDES_SCHEMA.describe(
          "Codex -c key=value overrides. Keys: /^[a-zA-Z0-9._]+$/. Values: no CR/LF."
        ),
        ephemeral: z.boolean().optional().describe("Codex --ephemeral."),
        images: z.array(z.string()).optional().describe("Codex -i <path>: image attachments."),
        ignoreUserConfig: z.boolean().optional().describe("Codex --ignore-user-config."),
        ignoreRules: z.boolean().optional().describe("Codex --ignore-rules."),
      },
      async ({
        prompt,
        model,
        fullAuto,
        sandboxMode,
        askForApproval,
        useLegacyFullAutoFlag,
        dangerouslyBypassApprovalsAndSandbox,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        sessionId,
        resumeLatest,
        createNewSession,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
        outputFormat,
        outputSchema,
        search,
        profile,
        configOverrides,
        ephemeral,
        images,
        ignoreUserConfig,
        ignoreRules,
      }) => {
        return handleCodexRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            model,
            fullAuto,
            sandboxMode,
            askForApproval,
            useLegacyFullAutoFlag,
            dangerouslyBypassApprovalsAndSandbox,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            sessionId,
            resumeLatest,
            createNewSession,
            correlationId,
            optimizePrompt,
            idleTimeoutMs,
            forceRefresh,
            outputFormat,
            outputSchema,
            search,
            profile,
            configOverrides,
            ephemeral,
            images,
            ignoreUserConfig,
            ignoreRules,
          }
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
        sessionId: z
          .string()
          .optional()
          .describe("Session ID (user-provided CLI handle for --resume)"),
        resumeLatest: z.boolean().default(false).describe("Resume latest session"),
        createNewSession: z.boolean().default(false).describe("Force new session"),
        approvalMode: z
          .enum(GEMINI_APPROVAL_MODES)
          .optional()
          .describe("Approval: default|auto_edit|yolo|plan"),
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
          .describe(
            "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
          ),
        // U23: emit `-o json` to extract token usage via parseGeminiJson. Default
        // remains text so existing callers see no behavior change.
        outputFormat: z
          .enum(["text", "json"])
          .default("text")
          .describe(
            "Gemini output format. `json` emits `-o json` so usageMetadata is parsed and reported."
          ),
        sandbox: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.sandbox.describe(
          "Run Gemini in sandbox mode (-s)"
        ),
        policyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.policyFiles.describe(
          "Policy file paths (--policy <path>, one per file). Paths must exist."
        ),
        adminPolicyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.adminPolicyFiles.describe(
          "Admin policy file paths (--admin-policy <path>, one per file). Paths must exist."
        ),
        attachments: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.attachments.describe(
          "Absolute file paths prepended as @<path> tokens to the prompt"
        ),
      },
      async ({
        prompt,
        model,
        sessionId,
        resumeLatest,
        createNewSession,
        approvalMode,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        allowedTools,
        includeDirs,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
        outputFormat,
        sandbox,
        policyFiles,
        adminPolicyFiles,
        attachments,
      }) => {
        return handleGeminiRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            model,
            sessionId,
            resumeLatest,
            createNewSession,
            approvalMode,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            allowedTools,
            includeDirs,
            correlationId,
            optimizePrompt,
            idleTimeoutMs,
            forceRefresh,
            outputFormat,
            sandbox,
            policyFiles,
            adminPolicyFiles,
            attachments,
          }
        );
      }
    );

    server.tool(
      "grok_request_async",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .describe("Prompt text for Grok"),
        model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
        outputFormat: z
          .enum(["plain", "json", "streaming-json"])
          .optional()
          .describe("Output format (plain|json|streaming-json). Grok default is plain."),
        sessionId: z
          .string()
          .optional()
          .describe("Session ID (user-provided CLI handle for --resume)"),
        resumeLatest: z
          .boolean()
          .default(false)
          .describe("Resume most recent Grok session in cwd (--continue)"),
        createNewSession: z.boolean().default(false).describe("Force new session"),
        alwaysApprove: z
          .boolean()
          .default(false)
          .describe("Auto-approve all tool executions (--always-approve)"),
        permissionMode: z
          .enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])
          .optional()
          .describe("Grok permission mode"),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Grok effort level"),
        reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
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
          .describe(
            "MCP server names for approval tracking (Grok manages its own MCP config via `grok mcp`)"
          ),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe("Allowed built-in tools (passed as --tools comma list)"),
        disallowedTools: z
          .array(z.string())
          .optional()
          .describe("Disallowed built-in tools (passed as --disallowed-tools comma list)"),
        correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
        optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
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
          .describe(
            "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
          ),
      },
      async ({
        prompt,
        model,
        outputFormat,
        sessionId,
        resumeLatest,
        createNewSession,
        alwaysApprove,
        permissionMode,
        effort,
        reasoningEffort,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        allowedTools,
        disallowedTools,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
      }) => {
        return handleGrokRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            model,
            outputFormat,
            sessionId,
            resumeLatest,
            createNewSession,
            alwaysApprove,
            permissionMode,
            effort,
            reasoningEffort,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            allowedTools,
            disallowedTools,
            correlationId,
            optimizePrompt,
            idleTimeoutMs,
            forceRefresh,
          }
        );
      }
    );

    server.tool(
      "mistral_request_async",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .describe("Prompt text for Mistral Vibe"),
        model: z
          .string()
          .optional()
          .describe(
            "Model alias (resolved into VIBE_ACTIVE_MODEL env var — Vibe has no --model flag)"
          ),
        outputFormat: z
          .enum(["plain", "json", "stream-json"])
          .optional()
          .describe("Output format (plain|json|stream-json). Vibe default is plain."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Session ID (user-provided CLI handle for --resume). Requires [session_logging] enabled = true in ~/.vibe/config.toml."
          ),
        resumeLatest: z
          .boolean()
          .default(false)
          .describe("Resume most recent Vibe session in cwd (--continue)"),
        createNewSession: z.boolean().default(false).describe("Force new session"),
        permissionMode: z
          .enum(MISTRAL_AGENT_MODES)
          .optional()
          .describe(
            "Vibe agent mode (default|plan|accept-edits|auto-approve|chat|explore|lean). Defaults to auto-approve for programmatic use."
          ),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Vibe effort level"),
        reasoningEffort: z.string().optional().describe("Reasoning effort for reasoning models"),
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
          .describe(
            "MCP server names for approval tracking (Vibe manages its own MCP config via `vibe mcp`)"
          ),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Allowlist of built-in tools — each emitted as a separate --enabled-tools <tool> flag"
          ),
        disallowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Accepted for caller parity; Vibe has no deny-list flag, so values are ignored (a warning is logged)."
          ),
        correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
        optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
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
          .describe(
            "Bypass dedup and force a fresh CLI run even if a recent identical request exists"
          ),
      },
      async ({
        prompt,
        model,
        outputFormat,
        sessionId,
        resumeLatest,
        createNewSession,
        permissionMode,
        effort,
        reasoningEffort,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        allowedTools,
        disallowedTools,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
      }) => {
        return handleMistralRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            model,
            outputFormat,
            sessionId,
            resumeLatest,
            createNewSession,
            permissionMode,
            effort,
            reasoningEffort,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            allowedTools,
            disallowedTools,
            correlationId,
            optimizePrompt,
            idleTimeoutMs,
            forceRefresh,
          }
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
  } // end if (asyncJobsEnabled)

  server.tool("llm_process_health", {}, async () => {
    const health = asyncJobManager.getJobHealth();
    const persistenceBlock = {
      backend: persistence.backend,
      dbPath: persistence.path,
      dsn: persistence.dsn ? "[redacted]" : null,
      retentionDays: persistence.retentionDays,
      dedupWindowMs: persistence.dedupWindowMs,
      asyncJobsEnabled: persistence.asyncJobsEnabled,
      acknowledgeEphemeral: persistence.acknowledgeEphemeral,
      sources: persistence.sources,
      warning: persistence.asyncJobsEnabled
        ? null
        : "Async job persistence is disabled (backend = 'none'). *_request_async tools are NOT registered on this gateway. Set [persistence].backend = 'sqlite' (or 'memory' + acknowledgeEphemeral = true) to enable them.",
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: true, ...health, persistence: persistenceBlock },
            null,
            2
          ),
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Max number of approval records"),
      cli: z
        .enum(["claude", "codex", "gemini", "grok", "mistral"])
        .optional()
        .describe("Optional CLI filter"),
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
          z.enum(["claude", "codex", "gemini", "grok", "mistral"]).optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
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
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          z.enum(["claude", "codex", "gemini", "grok", "mistral"]).optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
    },
    async ({ cli }) => {
      const versions = await getCliVersions(cli);
      return { content: [{ type: "text", text: JSON.stringify({ versions }, null, 2) }] };
    }
  );

  server.tool(
    "upstream_contracts",
    {
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          SESSION_PROVIDER_ENUM.optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
      probeInstalled: z
        .boolean()
        .default(false)
        .describe("When true, run local --help probes and compare advertised flags"),
    },
    async ({ cli, probeInstalled }) => {
      const report = buildUpstreamContractReport({ cli, probeInstalled });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  server.tool(
    "cli_upgrade",
    {
      cli: z.enum(["claude", "codex", "gemini", "grok", "mistral"]).describe("CLI to upgrade"),
      target: z
        .string()
        .min(1)
        .default("latest")
        .describe("Package tag/version/target to install (default: latest)"),
      dryRun: z
        .boolean()
        .default(true)
        .describe("When true, return the upgrade plan without running it"),
      timeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(3_600_000)
        .optional()
        .describe("Upgrade timeout in ms when dryRun=false"),
    },
    async ({ cli, target, dryRun, timeoutMs }) => {
      try {
        const result = await runCliUpgrade({ cli, target, dryRun, timeoutMs, logger });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: message,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
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
      cli: SESSION_PROVIDER_ENUM.describe("CLI type (claude|codex|gemini|grok|mistral)"),
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
      cli: SESSION_PROVIDER_ENUM.optional().describe(
        "CLI filter (claude|codex|gemini|grok|mistral)"
      ),
    },
    async ({ cli }) => {
      try {
        const sessions = await sessionManager.listSessions(cli);
        const activeSessions = {
          claude: await sessionManager.getActiveSession("claude"),
          codex: await sessionManager.getActiveSession("codex"),
          gemini: await sessionManager.getActiveSession("gemini"),
          grok: await sessionManager.getActiveSession("grok"),
          mistral: await sessionManager.getActiveSession("mistral"),
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
                    mistral: activeSessions.mistral?.id || null,
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
      cli: SESSION_PROVIDER_ENUM.describe("CLI type (claude|codex|gemini|grok|mistral)"),
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
      cli: SESSION_PROVIDER_ENUM.optional().describe(
        "CLI filter (claude|codex|gemini|grok|mistral)"
      ),
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

  return server;
}

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

function registerHealthResource(server: McpServer): void {
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

    if (activeHttpGateway) {
      await activeHttpGateway.close();
      logger.info("HTTP MCP transport closed");
      activeHttpGateway = null;
    }

    if (activeServer) {
      await activeServer.close();
      logger.info("MCP server closed");
      activeServer = null;
    }

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
  const args = process.argv.slice(2);
  if (args[0] === "doctor") {
    if (args.includes("--json")) {
      printDoctorJson();
      return;
    }
    process.stderr.write("Only doctor --json is supported in this layer.\n");
    process.exit(2);
  }
  if (args[0] === "contracts") {
    if (args.includes("--json")) {
      const cliArg = args.find(arg => arg.startsWith("--cli="))?.split("=")[1];
      const cli = SESSION_PROVIDER_VALUES.includes(cliArg as SessionProvider)
        ? (cliArg as SessionProvider)
        : undefined;
      if (cliArg && !cli) {
        process.stderr.write(`Unsupported --cli value: ${cliArg}\n`);
        process.exit(2);
      }
      const probeInstalled = args.includes("--probe-installed");
      process.stdout.write(
        JSON.stringify(buildUpstreamContractReport({ cli, probeInstalled }), null, 2) + "\n"
      );
      return;
    }
    process.stderr.write(
      "Usage: llm-cli-gateway contracts --json [--cli=claude|codex|gemini|grok|mistral] [--probe-installed]\n"
    );
    process.exit(2);
  }

  const transportArg = args.find(arg => arg.startsWith("--transport="));
  const transportMode =
    transportArg?.split("=")[1] ||
    process.env.LLM_GATEWAY_TRANSPORT ||
    process.env.MCP_TRANSPORT ||
    "stdio";
  logger.info(`Starting llm-cli-gateway MCP server with ${transportMode} transport`);

  // Initialize session manager first
  await initializeSessionManager();

  const serverDeps: GatewayServerDeps = {
    sessionManager,
    resourceProvider,
    db,
    performanceMetrics,
    asyncJobManager,
    approvalManager,
    flightRecorder,
    logger,
  };

  if (transportMode === "http") {
    activeHttpGateway = await startHttpGateway({
      deps: serverDeps,
      createGatewayServer,
      logger,
    });
    logger.info(`llm-cli-gateway HTTP MCP server connected and ready at ${activeHttpGateway.url}`);
    return;
  }

  if (transportMode !== "stdio") {
    throw new Error(`Unsupported transport: ${transportMode}`);
  }

  activeServer = createGatewayServer({
    ...serverDeps,
  });

  // Register health check resource if using PostgreSQL
  registerHealthResource(activeServer);

  const transport = new StdioServerTransport();
  await activeServer.connect(transport);
  logger.info("llm-cli-gateway MCP server connected and ready");
}

// Guard: only auto-start when run directly (not imported for testing)
// Resolve symlinks so `llm-cli-gateway` (npm-linked bin) matches import.meta.url
const __entryUrl = entrypointFileURL(process.argv[1]);
if (__entryUrl === import.meta.url) {
  main().catch(error => {
    logger.error("Fatal server error:", error);
    process.exit(1);
  });
}
