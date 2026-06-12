#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod/v3";
import { executeCli, killAllProcessGroups, providerCommandName } from "./executor.js";
import { parseStreamJson } from "./stream-json-parser.js";
import { parseCodexJsonStream } from "./codex-json-parser.js";
import { parseGeminiJson, parseGeminiStreamJson } from "./gemini-json-parser.js";
import { parseVibeMetaJson } from "./mistral-meta-json-parser.js";
import { homedir } from "os";
import {
  CLI_TYPES,
  PROVIDER_TYPES,
  ISessionManager,
  createSessionManager,
  type CliType,
  type ProviderType,
  type Session,
} from "./session-manager.js";
import {
  createWorktree,
  createWorktreeSessionCleanupHook,
  type WorktreeHandle,
} from "./worktree-manager.js";
import { ResourceProvider } from "./resources.js";
import { PerformanceMetrics } from "./metrics.js";
import {
  estimateTokens,
  optimizePrompt as optimizePromptText,
  optimizeResponse as optimizeResponseText,
} from "./optimizer.js";
import {
  loadConfig,
  loadPersistenceConfig,
  loadCacheAwarenessConfig,
  loadProvidersConfig,
  defaultGatewayConfigPath,
  isXaiProviderEnabled,
  minStableTokensForModel,
  type PersistenceConfig,
  type CacheAwarenessConfig,
  type ProvidersConfig,
} from "./config.js";
import {
  createXaiResponse,
  XaiApiError,
  type XaiReasoningEffort,
  type XaiResponsesInputMessage,
  type XaiResponsesResult,
} from "./xai-api-provider.js";
import { DatabaseConnection } from "./db.js";
import { checkHealth } from "./health.js";
import {
  clearModelRegistryCache,
  getAvailableCliInfo,
  getCliInfo,
  resolveModelAlias,
} from "./model-registry.js";
import { getProviderToolCapabilities } from "./provider-tool-capabilities.js";
import {
  AsyncJobManager,
  type AsyncJobFlightRecorderEntry,
  type AsyncJobUsageExtractor,
} from "./async-job-manager.js";
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
import {
  resolvePromptInput,
  PromptPartsSchema,
  assembleClaudeCacheBlocks,
  type PromptParts,
} from "./prompt-parts.js";
import {
  computeSessionCacheStats,
  computeTtlRemaining,
  readPersistedRequest,
  PERSISTED_REQUEST_DEFAULT_MAX_CHARS,
} from "./cache-stats.js";
import { getCliVersions, runCliUpgrade } from "./cli-updater.js";
import { startHttpGateway, type HttpGatewayHandle } from "./http-transport.js";
import { getRequestContext } from "./request-context.js";
import { printDoctorJson } from "./doctor.js";
import {
  createWorkspace,
  describeWorkspace,
  getWorkspace,
  loadWorkspaceRegistry,
  registerExistingWorkspace,
  resolveWorkspaceForProvider,
  validatePathInsideWorkspace,
  type EffectiveWorkspace,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { generateSecret, hashSecret } from "./oauth.js";
import { registerValidationTools } from "./validation-tools.js";
import {
  assertUpstreamCliArgs,
  assertUpstreamCliEnv,
  buildProviderSubcommandsCompactCatalog,
  buildUpstreamContractReport,
  getCliSubcommandContract,
  probeInstalledCliContract,
  serializeCliSubcommandContract,
  UPSTREAM_CLI_CONTRACTS,
} from "./upstream-contracts.js";
import {
  buildArgvFromGeneration,
  deriveZodShapeFromGeneration,
  GROK_FLAG_GENERATION,
  GROK_GEN_OUTPUT_FORMAT,
  GROK_GEN_MAIN,
  GROK_GEN_PROMPT_FILE,
  GROK_GEN_SINGLE,
  GROK_GEN_TAIL,
} from "./provider-codegen.js";
import { entrypointFileURL } from "./entrypoint-url.js";

/**
 * Slice 3: structured warning entries attached to tool responses.
 * Distinct from review-integrity warnings (which are text-appended to
 * the user-visible response). These are programmatic signals for caller
 * agents to react to.
 */
export interface WarningEntry {
  /** Stable machine-readable code, e.g. "cache_ttl_expiring_soon". */
  code: string;
  /** Optional human-readable message for surfaces that render text. */
  message?: string;
  /** Code-specific payload — left open for future warning types. */
  ttlRemainingMs?: number;
  [key: string]: unknown;
}

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
  /** Slice 3: structured warnings (e.g. cache_ttl_expiring_soon). */
  warnings?: WarningEntry[];
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

function startWindowsBootstrapperSelfHeal(): void {
  if (process.platform !== "win32") return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;

  const installDir = join(localAppData, "Programs", "llm-cli-gateway");
  const exePath = join(installDir, "llm-cli-gateway.exe");
  const pendingPath = `${exePath}.new`;
  if (!existsSync(pendingPath)) return;

  let attempts = 0;
  const maxAttempts = 120;
  const timer = setInterval(() => {
    attempts += 1;
    try {
      if (!existsSync(pendingPath)) {
        clearInterval(timer);
        return;
      }
      if (existsSync(exePath)) {
        unlinkSync(exePath);
      }
      renameSync(pendingPath, exePath);
      clearInterval(timer);
      logger.info(`Completed pending Windows bootstrapper replacement at ${exePath}`);
    } catch (error) {
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        logger.warn(`Pending Windows bootstrapper replacement did not complete: ${error}`);
      }
    }
  }, 500);
  timer.unref();
}

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

function packageVersion(): string {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      return parsed.version || "unknown";
    } catch {
      // Try next candidate.
    }
  }
  return "unknown";
}

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
// Built per-server so the advertised tool list matches what is actually
// registered: with persistence.backend = "none" the async/job tools are not
// registered, and a static inventory would point clients at "tool not found".
export function buildServerInstructions(
  asyncJobsEnabled: boolean,
  grokApiToolsEnabled = false
): string {
  const asyncToolsNote = asyncJobsEnabled ? " | *_request_async (async)" : "";
  const apiToolsNote = grokApiToolsEnabled ? ", grok_api_request" : "";
  const jobsLine = asyncJobsEnabled ? "Jobs: llm_job_status, llm_job_result, llm_job_cancel\n" : "";
  const deferralLine = asyncJobsEnabled
    ? `- Sync auto-defers at ${SYNC_DEADLINE_MS}ms. Poll deferred jobs via llm_job_status/llm_job_result.`
    : '- Async jobs are DISABLED (persistence.backend = "none"): *_request_async and llm_job_* tools are not registered, and sync requests run to completion (no auto-deferral).';
  return `llm-cli-gateway: Multi-LLM orchestration via MCP.

Tools: claude_request, codex_request, gemini_request, grok_request, mistral_request${apiToolsNote} (sync)${asyncToolsNote} | codex_fork_session (fork a Codex session into a new branch)
Validation: validate_with_models, second_opinion, compare_answers, red_team_review, consensus_check, ask_model, synthesize_validation, list_available_models | job_status/job_result (validation jobs)
${jobsLine}Sessions: session_create, session_list, session_set_active, session_get, session_delete, session_clear_all
Other: list_models, cli_versions, upstream_contracts, provider_subcommands_* (read-only subcommand contract/drift introspection), cli_upgrade, approval_list, llm_process_health, llm_request_result (read back any persisted request — sync or async — by correlationId)

Key behaviors:
${deferralLine}
- Sessions: Claude --continue, Gemini (Antigravity) --conversation <id>/--continue, Grok --resume/--continue, Mistral --resume/--continue (current Vibe defaults session logging on; doctor flags explicit session_logging.enabled=false), Codex \`exec resume <ID>\` / \`exec resume --last\` (all real CLI continuity). For Codex, sessionId must be a real Codex UUID (from ~/.codex/sessions/); gateway-generated gw-* IDs are rejected.
- Approval gates: opt-in via approvalStrategy:"mcp_managed".
- Upstream drift detection: After upgrading any provider CLI (especially grok), use upstream_contracts with probeInstalled:true and provider_subcommand_drift for declared subcommand help surfaces. Probes are safe, read-only --help checks.
- Idle timeout kills stuck processes (default 10min, configurable via idleTimeoutMs).

Skills (full docs via MCP resources):
${loadedSkills.map(s => `- skills://${s.name} — ${s.description}`).join("\n")}`;
}

function newGatewayMcpServer(asyncJobsEnabled = true, grokApiToolsEnabled = false): McpServer {
  return new McpServer(
    { name: "llm-cli-gateway", version: packageVersion() },
    { instructions: buildServerInstructions(asyncJobsEnabled, grokApiToolsEnabled) }
  );
}

// Global state (initialized asynchronously)
let sessionManager: ISessionManager;
let db: DatabaseConnection | null = null;
const performanceMetrics = new PerformanceMetrics();
let resourceProvider: ResourceProvider;
let flightRecorder: FlightRecorderLike | null = null;

// Resolved persistence config — single source of truth for the async-job backend.
// Driven by ~/.llm-cli-gateway/config.toml (+ deprecated env-var overrides).
// When backend = "none", the JobStore is null AND *_request_async tools are not
// registered (see createGatewayServer), making silent in-memory loss
// structurally impossible.
let persistenceConfig: PersistenceConfig | null = null;
let cacheAwarenessConfig: CacheAwarenessConfig | null = null;
let providersConfig: ProvidersConfig | null = null;
let jobStore: JobStore | null = null;
let jobStoreInitialized = false;
let asyncJobManager: AsyncJobManager | null = null;
let approvalManager: ApprovalManager | null = null;

function getFlightRecorder(runtimeLogger: GatewayLogger = logger): FlightRecorderLike {
  flightRecorder ??= createFlightRecorder(runtimeLogger);
  return flightRecorder;
}

function getPersistenceConfig(runtimeLogger: GatewayLogger = logger): PersistenceConfig {
  persistenceConfig ??= loadPersistenceConfig(runtimeLogger);
  return persistenceConfig;
}

function getCacheAwarenessConfig(runtimeLogger: GatewayLogger = logger): CacheAwarenessConfig {
  cacheAwarenessConfig ??= loadCacheAwarenessConfig(runtimeLogger);
  return cacheAwarenessConfig;
}

function getProvidersConfig(runtimeLogger: GatewayLogger = logger): ProvidersConfig {
  providersConfig ??= loadProvidersConfig(runtimeLogger);
  return providersConfig;
}

function getJobStore(runtimeLogger: GatewayLogger = logger): JobStore | null {
  if (jobStoreInitialized) return jobStore;
  jobStoreInitialized = true;
  try {
    jobStore = createJobStore(getPersistenceConfig(runtimeLogger), runtimeLogger);
  } catch (err) {
    runtimeLogger.error("Failed to open durable job store; async tools will be unavailable", err);
    jobStore = null;
  }
  return jobStore;
}

function newAsyncJobManager(
  metrics: PerformanceMetrics,
  runtimeLogger: GatewayLogger,
  store: JobStore | null = getJobStore(runtimeLogger),
  fr: FlightRecorderLike = getFlightRecorder(runtimeLogger)
): AsyncJobManager {
  return new AsyncJobManager(
    runtimeLogger,
    (cli, durationMs, success) => {
      metrics.recordRequest(cli, durationMs, success);
    },
    store,
    fr
  );
}

function getAsyncJobManager(runtimeLogger: GatewayLogger = logger): AsyncJobManager {
  asyncJobManager ??= newAsyncJobManager(performanceMetrics, runtimeLogger);
  return asyncJobManager;
}

function getApprovalManager(runtimeLogger: GatewayLogger = logger): ApprovalManager {
  approvalManager ??= new ApprovalManager(undefined, runtimeLogger);
  return approvalManager;
}

const MCP_SERVER_ENUM = z.enum(CLAUDE_MCP_SERVER_NAMES);
const CLI_TYPE_ENUM = z.enum(CLI_TYPES);

/**
 * Phase 4 slice δ — shared Zod fragments for `maxTurns` / `maxPrice`.
 *
 * Both flags reach the upstream CLIs as decimal-formatted argv strings via
 * `String(N)`. `z.number().int().positive()` alone lets values past
 * `Number.MAX_SAFE_INTEGER` through, after which `String(1e21)` emits
 * scientific notation that Grok and Vibe both reject. The bounds below
 * (safe-integer cap + 10000 ceiling for turns; finite + 10000 USD ceiling
 * for price) guarantee a lossless decimal stringification AND a sane
 * upper bound — no plausible single agent loop exceeds 10k turns or 10k USD.
 */
export const MAX_TURNS_SCHEMA = z.number().int().positive().safe().max(10_000);

/**
 * grok_request input fields derived from the grok contract + generation table
 * (see src/provider-codegen.ts). Replaces 30 hand-written covered-flag field
 * definitions in the tool registration; proven byte-identical (describe +
 * validation) to the prior hand-written fields by grok-schema-golden.test.ts.
 * The remaining grok_request fields (prompt, model, session, approval, agents,
 * promptJson, nativeWorktree, …) stay hand-written — they need bespoke schemas.
 */
type GrokGeneratedField =
  | "outputFormat"
  | "effort"
  | "reasoningEffort"
  | "allowedTools"
  | "disallowedTools"
  | "maxTurns"
  | "workingDir"
  | "sandbox"
  | "rules"
  | "systemPromptOverride"
  | "allow"
  | "deny"
  | "compactionMode"
  | "compactionDetail"
  | "agent"
  | "bestOfN"
  | "check"
  | "disableWebSearch"
  | "todoGate"
  | "verbatim"
  | "promptFile"
  | "single"
  | "experimentalMemory"
  | "noAltScreen"
  | "noMemory"
  | "noPlan"
  | "noSubagents"
  | "oauth"
  | "restoreCode"
  | "leaderSocket";
// Typed with the covered key union (values as ZodTypeAny) so the spread keeps
// these keys present for the tool callback's destructure; the runtime values
// come from the contract-derived shape (proven equivalent by the schema golden).
const GROK_GENERATED_SHAPE = deriveZodShapeFromGeneration(
  UPSTREAM_CLI_CONTRACTS.grok,
  GROK_FLAG_GENERATION
) as unknown as Record<GrokGeneratedField, z.ZodTypeAny>;
// Token budgets can legitimately exceed the agent-turn cap by orders of
// magnitude. Keep a finite operational guardrail while avoiding the 10k turn
// ceiling that would make large-context Vibe sessions unusable.
export const MAX_TOKENS_SCHEMA = z.number().int().positive().safe().max(100_000_000);
// `.min(1e-6)` keeps the value in JS's decimal-stringify range:
// String(1e-6) === "0.000001" but String(1e-7) === "1e-7", which both
// upstream CLIs would reject. 1µUSD per request is fine-grained enough
// for any plausible budget-cap use.
export const MAX_PRICE_SCHEMA = z.number().positive().finite().min(1e-6).max(10_000);

/**
 * Slice λ: shared worktree directive for all 10 `*_request` / `*_request_async`
 * tools. `true` creates a fresh worktree under `<repoRoot>/.worktrees/<uuid>`
 * branched from HEAD. `{ name?, ref? }` lets the caller supply a sanitized
 * name and/or git ref (default ref: HEAD).
 *
 * Lifecycle is gateway-owned: the gateway pre-creates the worktree via
 * `git worktree add`, then spawns the child CLI with `cwd: <worktree-path>`.
 * No `-w` / `--worktree` flag is ever emitted to the underlying CLI. When
 * the request carries a sessionId and the session already has a worktree,
 * that worktree is reused. On session_delete or TTL eviction the gateway
 * runs `git worktree remove --force`.
 *
 * Tool response: when a worktree was used, the successful response stdout
 * is prefixed with `[gateway] worktree=<absolute-path>\n` so callers can
 * parse/use the path without a schema change (slice λ §1.d).
 *
 * NOTE: callers should `.gitignore` the `.worktrees/` directory in their
 * repo (the gateway does NOT auto-gitignore — see slice λ spec Q4).
 */
export const WORKTREE_SCHEMA = z
  .union([
    z.boolean(),
    z
      .object({
        name: z.string().min(1).max(64).optional(),
        ref: z.string().min(1).max(255).optional(),
      })
      .strict(),
  ])
  .describe(
    "Slice λ: run this request inside a dedicated git worktree owned by " +
      "the gateway. `true` creates a fresh worktree at " +
      "`<repoRoot>/.worktrees/<uuid>` branched from HEAD. " +
      "`{ name?, ref? }` lets the caller supply a sanitized name and/or a " +
      "git ref (default: HEAD). When the request carries a sessionId and " +
      "the session already has a worktree, that worktree is reused. The " +
      "gateway spawns the child CLI with `cwd: <worktree-path>` — no " +
      "`-w`/`--worktree` flag is ever emitted to the underlying CLI. On " +
      "session_delete or TTL eviction the gateway runs `git worktree " +
      "remove --force`. Successful responses are prefixed with " +
      "`[gateway] worktree=<absolute-path>\\n` so callers can use the " +
      "path. NOTE: callers should `.gitignore` the `.worktrees/` " +
      "directory in their repo (the gateway does NOT auto-gitignore — " +
      "see slice λ spec Q4)."
  );

export const WORKSPACE_ALIAS_SCHEMA = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
  .describe("Registered workspace alias. Remote clients use aliases, not absolute paths.");

// Session-provider enum includes spawnable CLIs plus API-backed providers.
// Keep CLI-only surfaces (contracts, status, updater) on CLI_TYPES.
export const SESSION_PROVIDER_VALUES = PROVIDER_TYPES;
export const SESSION_PROVIDER_ENUM = z.enum(SESSION_PROVIDER_VALUES);
export type SessionProvider = ProviderType;
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
  cacheAwareness?: CacheAwarenessConfig;
  providers?: ProvidersConfig;
  workspaces?: WorkspaceRegistry;
}

export interface GatewayServerRuntime {
  sessionManager: ISessionManager;
  resourceProvider: ResourceProvider;
  db: DatabaseConnection | null;
  performanceMetrics: PerformanceMetrics;
  asyncJobManager: AsyncJobManager;
  approvalManager: ApprovalManager;
  flightRecorder: FlightRecorderLike;
  logger: GatewayLogger;
  persistence: PersistenceConfig;
  cacheAwareness: CacheAwarenessConfig;
  providers: ProvidersConfig;
  workspaces: WorkspaceRegistry;
}

export function resolveGatewayServerRuntime(
  deps: GatewayServerDeps = {},
  options: { isolateState?: boolean } = {}
): GatewayServerRuntime {
  const runtimeLogger = deps.logger ?? logger;
  const runtimeSessionManager = deps.sessionManager ?? sessionManager;
  const runtimePerformanceMetrics =
    deps.performanceMetrics ??
    (options.isolateState ? new PerformanceMetrics() : performanceMetrics);
  // Resolve flight recorder BEFORE async manager so isolateState managers
  // can be wired with the same recorder instance the runtime exposes.
  const runtimeFlightRecorder = deps.flightRecorder ?? getFlightRecorder(runtimeLogger);
  const runtimeAsyncJobManager =
    deps.asyncJobManager ??
    (options.isolateState
      ? // Factory-created test/HTTP session servers must not mark another instance's
        // durable jobs orphaned. Stdio startup injects the process-global manager.
        newAsyncJobManager(runtimePerformanceMetrics, runtimeLogger, null, runtimeFlightRecorder)
      : getAsyncJobManager(runtimeLogger));
  const runtimeApprovalManager =
    deps.approvalManager ??
    (options.isolateState
      ? new ApprovalManager(undefined, runtimeLogger)
      : getApprovalManager(runtimeLogger));
  return {
    sessionManager: runtimeSessionManager,
    resourceProvider:
      deps.resourceProvider ??
      (options.isolateState
        ? new ResourceProvider(
            runtimeSessionManager,
            runtimePerformanceMetrics,
            runtimeFlightRecorder,
            deps.cacheAwareness ?? getCacheAwarenessConfig(runtimeLogger)
          )
        : resourceProvider),
    db: "db" in deps ? (deps.db ?? null) : db,
    performanceMetrics: runtimePerformanceMetrics,
    asyncJobManager: runtimeAsyncJobManager,
    approvalManager: runtimeApprovalManager,
    flightRecorder: runtimeFlightRecorder,
    logger: runtimeLogger,
    persistence: deps.persistence ?? getPersistenceConfig(runtimeLogger),
    cacheAwareness: deps.cacheAwareness ?? getCacheAwarenessConfig(runtimeLogger),
    providers: deps.providers ?? getProvidersConfig(runtimeLogger),
    workspaces: deps.workspaces ?? loadWorkspaceRegistry(runtimeLogger),
  };
}

export function shouldRegisterGrokApiTools(providers: ProvidersConfig): boolean {
  return isXaiProviderEnabled(providers);
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
  onComplete?: () => void,
  /**
   * Slice 1.5: when the sync handler has already written a logStart row
   * keyed on `corrId`, pass these so the manager can write logComplete
   * (with usage extraction) when the underlying async job terminates —
   * even if the sync handler returned a deferred response.
   * `writeFlightStart` is NEVER true on this path: the sync handler is
   * always the upstream logStart writer.
   */
  flightRecorderEntry?: AsyncJobFlightRecorderEntry,
  extractUsage?: AsyncJobUsageExtractor,
  /**
   * Slice κ: optional stdin payload piped to the child CLI. Currently
   * only Claude's `--input-format stream-json` path sets this. Threaded
   * through both the direct-execute fallback (SYNC_DEADLINE_MS===0) and
   * the AsyncJobManager spawn path, and participates in the dedup key.
   */
  stdin?: string,
  /**
   * Slice λ: optional working directory for the spawned child process,
   * derived from a gateway-owned git worktree. Threaded to both the
   * direct-execute fallback (`executeCli({ cwd })`) and the
   * AsyncJobManager dedup-aware spawn path
   * (`startJobWithDedup({ cwd })`). `cwd` also participates in the
   * dedup key (see async-job-manager.buildRequestKey) so two requests
   * with identical argv in different worktrees do not collide.
   */
  cwd?: string
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

  // Deferral must use the SAME derived gate as tool registration and the
  // server instructions (backend, asyncJobsEnabled, AND hasStore()): if the
  // llm_job_* polling tools are not registered, handing the client a deferred
  // jobId would be a dead end — run to completion instead. A null-store
  // manager would otherwise still accept in-memory jobs (safeStoreCall
  // tolerates store === null), making the mismatch reachable.
  const deferralAvailable =
    runtime.persistence.backend !== "none" &&
    runtime.persistence.asyncJobsEnabled &&
    runtime.asyncJobManager.hasStore();
  if (SYNC_DEADLINE_MS === 0 || !deferralAvailable) {
    // Deferral disabled — SYNC_DEADLINE_MS=0 is the explicit opt-out; the
    // derived gate covers backend=none and storeless runtimes.
    // Note: direct execution bypasses dedup. forceRefresh is implied.
    const command = providerCommandName(cli);
    try {
      return await executeCli(command, args, {
        idleTimeout: idleTimeoutMs,
        logger: runtime.logger,
        env: env ? ({ ...process.env, ...env } as NodeJS.ProcessEnv) : undefined,
        stdin,
        cwd,
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
      cwd,
      idleTimeoutMs,
      outputFormat,
      forceRefresh,
      env,
      stdin,
      onComplete,
      // Sync-deferred path: the upstream sync handler already wrote
      // logStart for this corrId, so writeFlightStart stays false. The
      // manager still writes logComplete on terminal state (which UPDATEs
      // the sync handler's row), closing the previously-orphaned
      // sync-deferred case.
      flightRecorderEntry,
      extractUsage,
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

  // Deadline exceeded — return deferral.
  // R2 Codex-Unit-B F1: hand FR-complete ownership to the manager. Until
  // this call, the manager skips writeFlightComplete on terminal so the
  // sync handler's safeFlightComplete (with rich approvalDecision /
  // optimizationApplied metadata) wins for sync-inline completions. From
  // here on the sync handler returns deferred and will NOT write
  // safeFlightComplete, so the manager must.
  runtime.asyncJobManager.armFlightCompleteForDeferral(job.id);
  runtime.logger.info(
    `[${corrId}] ${cli} sync deadline exceeded (${SYNC_DEADLINE_MS}ms), deferring to async job ${job.id}`
  );
  return {
    deferred: true,
    jobId: job.id,
    cli,
    correlationId: corrId,
    message: `Execution exceeded sync deadline (${SYNC_DEADLINE_MS}ms). Poll with llm_job_status, collect with llm_job_result.`,
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
            collectWith: "llm_job_result",
            cancelWith: "llm_job_cancel",
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Slice λ: shape returned by `resolveWorktreeForRequest`. `cwd` is what
 * the spawn helpers (`executeCli`, `startJobWithDedup`) consume;
 * `worktreePath` is what the tool handler embeds in the response prefix
 * so callers can discover the path.
 */
export interface ResolvedWorktree {
  cwd?: string;
  worktreePath?: string;
  workspaceAlias?: string;
  workspaceRoot?: string;
}

/**
 * Slice λ: resolve a request's worktree directive into a spawn cwd.
 *
 * - `worktreeOpt` is the Zod-validated input value (boolean |
 *   `{ name?, ref? }` | undefined).
 * - When the request has a session AND the session already has a
 *   `metadata.worktreePath`, that path is reused (resume semantics).
 *   The reused path is returned without touching git; if the directory
 *   was externally removed between requests, the next CLI invocation
 *   will surface the error naturally.
 * - When no reusable worktree exists, `createWorktree` runs; on success
 *   the new path is written to `session.metadata` (only when a session
 *   exists — request-scoped worktrees do NOT persist).
 * - Returns `{}` when `worktreeOpt` is undefined/false (preserves
 *   pre-λ behaviour at non-worktree call sites).
 * - Errors propagate as `WorktreeError`/`Error`; the caller wraps them
 *   in a `createErrorResponse` envelope. Do NOT swallow.
 *
 * Spec: docs/plans/slice-lambda.spec.md §"Implementation surface to
 * verify" §5.
 */
export async function resolveWorktreeForRequest(
  worktreeOpt: boolean | { name?: string; ref?: string } | undefined,
  sessionId: string | undefined,
  runtime: GatewayServerRuntime,
  options: { repoRoot?: string; workspaceAlias?: string; workspaceRoot?: string } = {}
): Promise<ResolvedWorktree> {
  if (!worktreeOpt) return {};
  const sessionManager = runtime.sessionManager;
  if (sessionId) {
    const session = await Promise.resolve(sessionManager.getSession(sessionId));
    const existingPath = session?.metadata?.worktreePath;
    if (typeof existingPath === "string" && existingPath.length > 0) {
      return {
        cwd: existingPath,
        worktreePath: existingPath,
        workspaceAlias:
          typeof session?.metadata?.workspaceAlias === "string"
            ? session.metadata.workspaceAlias
            : options.workspaceAlias,
        workspaceRoot:
          typeof session?.metadata?.workspaceRoot === "string"
            ? session.metadata.workspaceRoot
            : options.workspaceRoot,
      };
    }
  }
  const name = worktreeOpt === true ? undefined : worktreeOpt.name;
  const ref = worktreeOpt === true ? undefined : worktreeOpt.ref;
  const repoRoot = options.repoRoot ?? process.cwd();
  const handle: WorktreeHandle = await createWorktree({
    repoRoot,
    name,
    ref,
    logger: runtime.logger,
  });
  if (sessionId) {
    await Promise.resolve(
      sessionManager.updateSessionMetadata(sessionId, {
        worktreePath: handle.path,
        worktreeName: handle.name,
        ...(options.workspaceAlias ? { workspaceAlias: options.workspaceAlias } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      })
    );
  }
  return {
    cwd: handle.path,
    worktreePath: handle.path,
    workspaceAlias: options.workspaceAlias,
    workspaceRoot: options.workspaceRoot,
  };
}

function isGatewayAppDirCwd(): boolean {
  return process.cwd() === join(homedir(), ".llm-cli-gateway");
}

async function resolveWorkspaceAndWorktreeForRequest(args: {
  provider: CliType;
  workspace?: string;
  worktree?: boolean | { name?: string; ref?: string };
  sessionId?: string;
  runtime: GatewayServerRuntime;
  workingDir?: string;
  addDir?: string[];
}): Promise<{ cwd?: string; worktreePath?: string; workspace?: EffectiveWorkspace }> {
  const session = args.sessionId
    ? await Promise.resolve(args.runtime.sessionManager.getSession(args.sessionId))
    : null;
  let workspace: EffectiveWorkspace | undefined;
  if (
    args.workspace ||
    args.runtime.workspaces.defaultAlias ||
    typeof session?.metadata?.workspaceAlias === "string"
  ) {
    workspace = resolveWorkspaceForProvider(
      args.runtime.workspaces,
      args.provider,
      args.workspace,
      session?.metadata
    );
  } else if (isGatewayAppDirCwd()) {
    throw new Error(
      "No workspace selected. Configure [workspaces].default or pass a registered workspace alias."
    );
  }

  if (!workspace && getRequestContext()?.authKind === "oauth") {
    throw new Error(
      "Remote OAuth provider requests require a registered workspace alias or [workspaces].default."
    );
  }

  if (
    !workspace &&
    (args.workingDir || (args.addDir?.length ?? 0) > 0) &&
    !args.runtime.workspaces.allowUnregisteredWorkingDir
  ) {
    throw new Error(
      "workingDir/addDir require a registered workspace alias unless [workspaces].allow_unregistered_working_dir is explicitly enabled."
    );
  }

  if (workspace) {
    if (args.workingDir) {
      validatePathInsideWorkspace(workspace, args.workingDir, "workingDir");
    }
    for (const dir of args.addDir ?? []) {
      validatePathInsideWorkspace(workspace, dir, "addDir");
    }
  }

  if (args.worktree) {
    if (workspace && !workspace.repo.allowWorktree) {
      throw new Error(`Workspace "${workspace.alias}" does not allow worktree requests`);
    }
    const resolved = await resolveWorktreeForRequest(args.worktree, args.sessionId, args.runtime, {
      repoRoot: workspace?.root,
      workspaceAlias: workspace?.alias,
      workspaceRoot: workspace?.root,
    });
    return { cwd: resolved.cwd, worktreePath: resolved.worktreePath, workspace };
  }
  if (workspace && args.sessionId) {
    await Promise.resolve(
      args.runtime.sessionManager.updateSessionMetadata(args.sessionId, {
        workspaceAlias: workspace.alias,
        workspaceRoot: workspace.root,
      })
    );
  }
  return { cwd: workspace?.cwd, workspace };
}

/**
 * Slice λ §1.d: response-envelope shape decision for `worktreePath`.
 *
 * We surface the worktree path inline as a stdout prefix
 * (`[gateway] worktree=<absolute-path>\n`) rather than as a
 * structuredContent field or JSON wrapper. Rationale:
 *   - zero schema change across all 10 tools and their downstream parsers
 *   - matches how other slice features (session warnings, cache_state
 *     aggregates) surface side-channel metadata today
 *   - callers that want the path can split on the first newline; callers
 *     that don't care see a single ignorable header line
 *
 * Use `formatWorktreePrefix(resolution.worktreePath)` once per tool, at
 * the moment a successful response is constructed.
 */
export function formatWorktreePrefix(worktreePath?: string): string {
  return worktreePath ? `[gateway] worktree=${worktreePath}\n` : "";
}

function workspaceAdminEnabled(): boolean {
  const scopes = getRequestContext()?.authScopes ?? [];
  return process.env.LLM_GATEWAY_WORKSPACE_ADMIN === "1" && scopes.includes("workspace:admin");
}

function registerWorkspaceTools(server: McpServer, runtime: GatewayServerRuntime): void {
  server.tool(
    "workspace_list",
    "List registered workspace aliases and summary metadata. Does not browse files.",
    {},
    {
      title: "List workspaces",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      const registry = loadWorkspaceRegistry(runtime.logger);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                enabled: registry.enabled,
                default: registry.defaultAlias,
                workspaces: registry.repos.map(describeWorkspace),
                allowed_roots: registry.allowedRoots.map(root => ({
                  alias: root.alias,
                  path: root.path,
                  allow_register_existing_git_repos: root.allowRegisterExistingGitRepos,
                  allow_create_directories: root.allowCreateDirectories,
                  allow_init_git_repos: root.allowInitGitRepos,
                  max_create_depth: root.maxCreateDepth,
                })),
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
    "workspace_get",
    "Inspect a registered workspace alias. Does not list files.",
    { alias: WORKSPACE_ALIAS_SCHEMA },
    {
      title: "Get workspace",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ alias }) => {
      try {
        const registry = loadWorkspaceRegistry(runtime.logger);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, workspace: describeWorkspace(getWorkspace(registry, alias)) },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return createErrorResponse("workspace_get", 1, "", undefined, error as Error);
      }
    }
  );

  server.tool(
    "workspace_create",
    "Create a new local folder or git repo under a configured allowed root. Requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin.",
    {
      alias: WORKSPACE_ALIAS_SCHEMA,
      root: WORKSPACE_ALIAS_SCHEMA.describe("Allowed-root alias from workspace_list."),
      slug: z.string().min(1).max(255).describe("Safe relative path under the allowed root."),
      kind: z.enum(["folder", "git"]).default("git"),
      setDefault: z.boolean().default(false),
    },
    {
      title: "Create workspace",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ alias, root, slug, kind, setDefault }) => {
      try {
        if (!workspaceAdminEnabled()) {
          throw new Error(
            "workspace_create requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin"
          );
        }
        const repo = createWorkspace({
          alias,
          rootAlias: root,
          slug,
          kind,
          setDefault,
          logger: runtime.logger,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, workspace: describeWorkspace(repo) }, null, 2),
            },
          ],
        };
      } catch (error) {
        return createErrorResponse("workspace_create", 1, "", undefined, error as Error);
      }
    }
  );

  server.tool(
    "workspace_register_existing_repo",
    "Register an existing local Git repo under an allowed root. Requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin.",
    {
      alias: WORKSPACE_ALIAS_SCHEMA,
      path: z
        .string()
        .min(1)
        .describe("Absolute path to an existing Git repo under an allowed root."),
      setDefault: z.boolean().default(false),
    },
    {
      title: "Register workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ alias, path, setDefault }) => {
      try {
        if (!workspaceAdminEnabled()) {
          throw new Error(
            "workspace_register_existing_repo requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin"
          );
        }
        const repo = registerExistingWorkspace({
          alias,
          repoPath: path,
          setDefault,
          logger: runtime.logger,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, workspace: describeWorkspace(repo) }, null, 2),
            },
          ],
        };
      } catch (error) {
        return createErrorResponse(
          "workspace_register_existing_repo",
          1,
          "",
          undefined,
          error as Error
        );
      }
    }
  );
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
      // Issue #1: mirror the error text (see buildCliResponse rationale) so a
      // structuredContent-preferring client still surfaces the failure detail.
      response: errorMessage,
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

export function extractUsageAndCost(
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
  output: string,
  outputFormat?: string,
  /**
   * Optional context for off-stdout telemetry sources. Today only Mistral
   * uses this — its meta.json lives on disk keyed by sessionId. Threading
   * this in keeps the closure built by `buildAsyncFlightRecorderHandoff`
   * primitives-only (no `params`/`prep` retention on AsyncJobRecord).
   */
  ctx?: { sessionId?: string; home?: string }
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
  if (cli === "gemini" && (outputFormat === "json" || outputFormat === "stream-json")) {
    const parsed =
      outputFormat === "stream-json" ? parseGeminiStreamJson(output) : parseGeminiJson(output);
    if (!parsed || !parsed.usage) {
      return {};
    }
    return {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadTokens: parsed.usage.cache_read_tokens,
    };
  }
  // Mistral/Vibe: usage/cost live on disk in `~/.vibe/logs/session/<id>/meta.json`
  // (Phase 4 slice β). Best-effort: if we don't know the sessionId (fresh
  // session whose Vibe-assigned UUID we never observed) or the file is
  // missing/malformed, the parser returns `{}` and the FR row simply lacks
  // usage data — matching pre-slice behaviour. No stdout fallback exists.
  if (cli === "mistral") {
    return parseVibeMetaJson(ctx?.home ?? homedir(), ctx?.sessionId);
  }
  return {};
}

/**
 * Slice 1.5: build the async-job-manager's FR payload from a prep object
 * (which every prepare*Request returns), plus the bound CLI and output
 * format primitives needed by extractUsageAndCost. Returning the closure
 * separately means it captures `cliName` and `fmt` ONLY — never `params`
 * or `prep` — so retention on AsyncJobRecord is O(constant).
 */
function buildAsyncFlightRecorderHandoff(
  cliName: "claude" | "codex" | "gemini" | "grok" | "mistral",
  prep: {
    effectivePrompt: string;
    resolvedModel?: string;
    stablePrefixHash?: string | null;
    stablePrefixTokens?: number | null;
    cacheControlBlocks?: number;
    cacheControlTtlSeconds?: number;
  },
  sessionId: string | undefined,
  outputFormat: string | undefined
): {
  flightRecorderEntry: AsyncJobFlightRecorderEntry;
  extractUsage: AsyncJobUsageExtractor;
} {
  // Extract primitives BEFORE building the closure — capturing `prep` or
  // `params` directly would pin large attachments / promptParts on the
  // AsyncJobRecord for JOB_TTL_MS. Phase 4 slice β: `sid` and `home` are
  // primitives too, threaded through so the Mistral branch of
  // extractUsageAndCost can read `~/.vibe/logs/session/<id>/meta.json`.
  const cli = cliName;
  const fmt = outputFormat;
  const sid = sessionId;
  const home = homedir();
  return {
    flightRecorderEntry: {
      model: prep.resolvedModel || "default",
      prompt: prep.effectivePrompt,
      sessionId,
      stablePrefixHash: prep.stablePrefixHash ?? undefined,
      stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
      cacheControlBlocks: prep.cacheControlBlocks,
      cacheControlTtlSeconds: prep.cacheControlTtlSeconds,
    },
    extractUsage: (stdout: string) =>
      extractUsageAndCost(cli, stdout, fmt, { sessionId: sid, home }),
  };
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

  // Cache-state resources (slice 2). Static URI for global, templated for
  // session/{id} and prefix/{hash}. All three return tokens/hashes/aggregates
  // ONLY — never raw prompt or response text. The structural guarantee is in
  // the SessionCacheStats / PrefixCacheStats / GlobalCacheStats types
  // themselves: those shapes have no prompt/response/system/task fields.
  server.registerResource(
    "cache-state-global",
    "cache-state://global",
    {
      title: "💾 Cache State (Global)",
      description:
        "Aggregate cache hit/miss/savings across all CLIs in the flight recorder. Tokens/hashes only — no prompt text.",
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading cache-state://global resource");
      const stats = runtime.resourceProvider.readCacheStateGlobal({
        lastNHours: 24,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "cache-state-session",
    new ResourceTemplate("cache-state://session/{sessionId}", { list: undefined }),
    {
      title: "💾 Cache State (Session)",
      description: "Per-session cache hit/miss/savings. Tokens/hashes only — no prompt text.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const sessionId = Array.isArray(variables.sessionId)
        ? variables.sessionId[0]
        : variables.sessionId;
      runtime.logger.debug(`Reading cache-state://session/${sessionId}`);
      const stats = runtime.resourceProvider.readCacheStateSession(String(sessionId));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "cache-state-prefix",
    new ResourceTemplate("cache-state://prefix/{hash}", { list: undefined }),
    {
      title: "💾 Cache State (Prefix)",
      description:
        "Per-stable-prefix-hash cache hit/miss/savings, with CLI breakdown. Tokens/hashes only — no prompt text.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const hash = Array.isArray(variables.hash) ? variables.hash[0] : variables.hash;
      runtime.logger.debug(`Reading cache-state://prefix/${hash}`);
      const stats = runtime.resourceProvider.readCacheStateForPrefix(String(hash));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "provider-subcommands-catalog",
    "provider-subcommands://catalog",
    {
      title: "Provider Subcommands Catalog",
      description: "Compact read-only catalog of declared provider CLI subcommands",
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading provider-subcommands://catalog resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );

  server.registerResource(
    "provider-subcommand-contract",
    new ResourceTemplate("provider-subcommands://{provider}/{+commandPath}", { list: undefined }),
    {
      title: "Provider Subcommand Contract",
      description: "Detailed read-only contract for one declared provider CLI subcommand",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const provider = Array.isArray(variables.provider)
        ? variables.provider[0]
        : variables.provider;
      const commandPath = Array.isArray(variables.commandPath)
        ? variables.commandPath[0]
        : variables.commandPath;
      runtime.logger.debug(`Reading provider-subcommands://${provider}/${commandPath}`);
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );

  server.registerResource(
    "provider-tools-catalog",
    "provider-tools://catalog",
    {
      title: "Provider Tool Capabilities Catalog",
      description: "Read-only catalog of gateway tool controls and discovered provider skills",
      mimeType: "application/json",
    },
    async uri => {
      runtime.logger.debug("Reading provider-tools://catalog resource");
      const contents = await runtime.resourceProvider.readResource(uri.href);
      return { contents: contents ? [contents] : [] };
    }
  );

  server.registerResource(
    "provider-tools",
    new ResourceTemplate("provider-tools://{provider}", { list: undefined }),
    {
      title: "Provider Tool Capabilities",
      description:
        "Read-only gateway tool controls and discovered local skills for one provider CLI",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const provider = Array.isArray(variables.provider)
        ? variables.provider[0]
        : variables.provider;
      runtime.logger.debug(`Reading provider-tools://${provider}`);
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
  /**
   * Sha256 of the assembled prompt's stable prefix bytes when the caller
   * supplied `promptParts`. Null when the legacy `prompt` field was used.
   * Populated by `resolvePromptOrPartsForPrep` and threaded into the
   * flight-recorder row by the caller's safeFlightStart entry.
   */
  stablePrefixHash: string | null;
  /** Heuristic token count (bytes/4) of the same stable prefix. */
  stablePrefixTokens: number | null;
  /**
   * Slice κ (Claude only): JSON stream-json payload to feed on stdin
   * when the gateway emits `-p --input-format stream-json`. Undefined
   * when the caller did not opt into Anthropic `cache_control`
   * breakpoints. Non-κ providers always leave this undefined.
   */
  stdinPayload?: string;
  /**
   * Slice κ (Claude only): number of caller-supplied content blocks
   * that carry an explicit `cache_control` marker. Threaded into the
   * flight recorder so `cache_state` aggregates can distinguish
   * κ-explicit breakpoints from implicit prefix-cache hits.
   */
  cacheControlBlocks?: number;
  /** TTL seconds actually emitted on those cache_control markers. */
  cacheControlTtlSeconds?: number;
  /**
   * Rec #4: structured warnings produced during prep (e.g. cacheable
   * stable prefix without cacheControl). Handlers merge these with any
   * other warnings (cache_ttl_expiring_soon, etc.) before returning to
   * the caller.
   */
  warnings?: WarningEntry[];
}

/**
 * Slice 1: validate the prompt / promptParts mutex at the prep boundary and
 * return either an error response or the resolved input. The exact error
 * messages are part of the public contract — tests assert them verbatim.
 */
function resolvePromptOrPartsForPrep(args: {
  prompt: string | undefined;
  promptParts: PromptParts | undefined;
  operation: string;
  correlationId: string | undefined;
}):
  | {
      ok: true;
      assembledPrompt: string;
      stablePrefixHash: string | null;
      stablePrefixTokens: number | null;
    }
  | { ok: false; error: ExtendedToolResponse } {
  const hasPrompt = typeof args.prompt === "string" && args.prompt.length > 0;
  const hasParts = args.promptParts !== undefined;
  if (hasPrompt && hasParts) {
    return {
      ok: false,
      error: createErrorResponse(
        args.operation,
        1,
        "",
        args.correlationId,
        new Error("provide exactly one of `prompt` or `promptParts`")
      ) as ExtendedToolResponse,
    };
  }
  if (!hasPrompt && !hasParts) {
    return {
      ok: false,
      error: createErrorResponse(
        args.operation,
        1,
        "",
        args.correlationId,
        new Error("one of `prompt` or `promptParts` is required")
      ) as ExtendedToolResponse,
    };
  }
  const resolved = resolvePromptInput({
    prompt: args.prompt,
    promptParts: args.promptParts,
  });
  return {
    ok: true,
    assembledPrompt: resolved.assembledPrompt,
    stablePrefixHash: resolved.stablePrefixHash,
    stablePrefixTokens: resolved.stablePrefixTokens,
  };
}

export function prepareClaudeRequest(
  params: {
    prompt?: string;
    promptParts?: PromptParts;
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
    // Phase 4 slice η — Claude reliability + structured-output parity
    fallbackModel?: string;
    jsonSchema?: string | Record<string, unknown>;
    // Phase 4 slice ζ — Claude additional-workspace-dirs parity
    addDir?: string[];
    // Claude session/settings/tools surface (2.x)
    noSessionPersistence?: boolean;
    settingSources?: string;
    settings?: string;
    tools?: string[];
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("claude", params.model, cliInfo);

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: params.operation,
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;
  const assembledPrompt = inputResolution.assembledPrompt;
  const stablePrefixHash = inputResolution.stablePrefixHash;
  const stablePrefixTokens = inputResolution.stablePrefixTokens;

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: assembledPrompt,
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

  // Rec #5 (slice κ): refuse the optimizePrompt + cacheControl combo
  // before running optimization. Optimization rewrites the assembled
  // prompt text the flight-recorder logs, but the κ stdin payload is
  // built from raw `promptParts` content blocks — letting both run
  // produces a FR row whose `prompt` no longer matches what Claude
  // actually received, AND any optimisation-driven text change would
  // silently break Anthropic prefix-cache reuse on the next call.
  const ccEarly = params.promptParts?.cacheControl;
  const cacheControlRequestedEarly = !!(
    ccEarly &&
    (ccEarly.system || ccEarly.tools || ccEarly.context)
  );
  const explicitCacheControlBlockCount =
    params.promptParts && ccEarly
      ? (ccEarly.system && params.promptParts.system && params.promptParts.system.length > 0
          ? 1
          : 0) +
        (ccEarly.tools && params.promptParts.tools && params.promptParts.tools.length > 0 ? 1 : 0) +
        (ccEarly.context && params.promptParts.context && params.promptParts.context.length > 0
          ? 1
          : 0)
      : 0;
  const effectiveExplicitCacheControl = explicitCacheControlBlockCount > 0;
  const cacheControlNoop = cacheControlRequestedEarly && !effectiveExplicitCacheControl;

  if (params.optimizePrompt && effectiveExplicitCacheControl) {
    return createErrorResponse(
      params.operation,
      1,
      "",
      corrId,
      new Error(
        "optimizePrompt is incompatible with promptParts.cacheControl (slice κ): optimization rewrites the assembled prompt text the flight recorder logs, while the cache_control payload is built from raw promptParts; the two would desync and break Anthropic prefix-cache reuse. Disable optimizePrompt when opting into cacheControl."
      )
    ) as ExtendedToolResponse;
  }

  let effectivePrompt = assembledPrompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = params.mcpServers ? [...new Set(params.mcpServers)] : [];
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
      prompt: assembledPrompt, // Use raw assembled prompt for review-context detection, not optimized
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

  // Rec #2 (slice κ): auto-emit `cache_control` when the caller passes
  // `promptParts` whose stable prefix exceeds the per-model minimum,
  // the caller has NOT explicitly set `cacheControl`, the gateway
  // config has opted in (`[cache_awareness].emit_anthropic_cache_control`),
  // and outputFormat is stream-json. Auto-emit marks the LAST non-empty
  // stable block (context → tools → system priority — the rightmost
  // stable block covers the widest prefix). Skipped when optimizePrompt
  // is on (same rec #5 desync risk).
  //
  // The 1h ttl is forced regardless of `anthropic_ttl_seconds`: 5m
  // breakpoints from caller content are rejected by Anthropic once
  // Claude Code's own 1h-marked session-wrap blocks land ahead of them.
  let autoEmittedCacheControlBlock: "system" | "tools" | "context" | null = null;
  if (
    !effectiveExplicitCacheControl &&
    runtime.cacheAwareness.emitAnthropicCacheControl &&
    !params.optimizePrompt &&
    params.outputFormat === "stream-json" &&
    params.promptParts &&
    stablePrefixTokens !== null
  ) {
    const threshold = minStableTokensForModel(runtime.cacheAwareness, resolvedModel ?? "default");
    if (stablePrefixTokens >= threshold) {
      const pp = params.promptParts;
      // Rightmost non-empty stable block — its cache_control breakpoint
      // covers everything above it in the message (the API matches
      // breakpoints in order).
      if (pp.context && pp.context.length > 0) autoEmittedCacheControlBlock = "context";
      else if (pp.tools && pp.tools.length > 0) autoEmittedCacheControlBlock = "tools";
      else if (pp.system && pp.system.length > 0) autoEmittedCacheControlBlock = "system";

      if (autoEmittedCacheControlBlock !== null) {
        runtime.logger.info(
          `[${corrId}] auto-emitting cache_control on '${autoEmittedCacheControlBlock}' (stablePrefixTokens=${stablePrefixTokens} >= ${threshold} for model='${resolvedModel ?? "default"}')`
        );
        if (runtime.cacheAwareness.anthropicTtlSeconds !== 3600) {
          runtime.logger.warn(
            `[${corrId}] [cache_awareness].anthropic_ttl_seconds=${runtime.cacheAwareness.anthropicTtlSeconds} ignored for Claude CLI path — Anthropic rejects 5m blocks after Claude Code's 1h-marked session-wrap content; using ttl='1h'.`
          );
        }
      }
    }
  }

  // Rec #4: warn when promptParts has a cacheable stable prefix but no
  // cache_control breakpoint is being emitted (neither explicit nor
  // auto). Either the caller forgot to set `cacheControl` or
  // `[cache_awareness].emit_anthropic_cache_control` is off — both
  // leave the stable prefix bytes unreused across calls, defeating the
  // point of using `promptParts`.
  const warnings: WarningEntry[] = [];
  if (cacheControlNoop) {
    warnings.push({
      code: "cache_control_noop",
      message:
        "promptParts.cacheControl only marked empty or omitted stable parts; no cache_control breakpoint will be emitted from the explicit marker.",
      reason: "cacheControl marker did not match a non-empty stable block",
    });
  }
  if (
    !effectiveExplicitCacheControl &&
    autoEmittedCacheControlBlock === null &&
    params.promptParts &&
    stablePrefixTokens !== null
  ) {
    const threshold = minStableTokensForModel(runtime.cacheAwareness, resolvedModel ?? "default");
    if (stablePrefixTokens >= threshold) {
      const reason =
        params.outputFormat !== "stream-json"
          ? "outputFormat is not 'stream-json'"
          : !runtime.cacheAwareness.emitAnthropicCacheControl
            ? "[cache_awareness].emit_anthropic_cache_control is false"
            : "no eligible non-empty stable block";
      warnings.push({
        code: "cacheable_prefix_uncached",
        message: `Stable prefix is cacheable (${stablePrefixTokens} tokens >= ${threshold} for model='${resolvedModel ?? "default"}') but no cache_control breakpoint will be emitted (${reason}). Set promptParts.cacheControl explicitly, switch outputFormat to 'stream-json', or enable [cache_awareness].emit_anthropic_cache_control.`,
        stablePrefixTokens,
        threshold,
        reason,
      });
    }
  }

  // Slice κ: switch from the legacy positional `-p <prompt>` emission
  // to `claude -p --input-format stream-json` and feed a JSON
  // content-blocks payload via stdin. Non-κ callers (no cacheControl,
  // or cacheControl with all flags false) take the existing positional
  // path bit-for-bit. The κ path activates on EITHER an explicit caller
  // opt-in with at least one effective non-empty marker
  // (`effectiveExplicitCacheControl`) OR a gateway-driven auto-emit
  // (`autoEmittedCacheControlBlock`). A marker on an empty part is a
  // no-op warning and leaves the request on the normal path unless auto
  // emission chooses an eligible stable block.
  const cacheControlRequested =
    effectiveExplicitCacheControl || autoEmittedCacheControlBlock !== null;
  let stdinPayload: string | undefined;
  let cacheControlBlocks: number | undefined;
  let cacheControlTtlSeconds: number | undefined;

  if (cacheControlRequested) {
    if (params.outputFormat !== "stream-json") {
      return createErrorResponse(
        params.operation,
        1,
        "",
        corrId,
        new Error(
          "promptParts.cacheControl requires outputFormat: 'stream-json' (slice κ pipes the cache_control blocks over --input-format stream-json; text/json output formats cannot carry the required NDJSON usage events)."
        )
      ) as ExtendedToolResponse;
    }
    // promptParts is non-null whenever cacheControlRequested is true
    // (explicit opt-in lives in PromptParts; auto-emit guard requires
    // promptParts to be defined).
    const effectiveParts: PromptParts =
      autoEmittedCacheControlBlock !== null
        ? {
            ...params.promptParts!,
            cacheControl: {
              ...(params.promptParts!.cacheControl ?? {}),
              [autoEmittedCacheControlBlock]: true,
            },
          }
        : params.promptParts!;
    const built = assembleClaudeCacheBlocks(effectiveParts);
    stdinPayload = `${JSON.stringify(built.payload)}\n`;
    cacheControlBlocks = built.markedBlockCount;
    cacheControlTtlSeconds = built.markedBlockCount > 0 ? 3600 : undefined;
  }

  const args: string[] = cacheControlRequested
    ? [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
      ]
    : ["-p", effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (!cacheControlRequested) {
    if (params.outputFormat === "json") {
      args.push("--output-format", "json");
    } else if (params.outputFormat === "stream-json") {
      // Claude CLI 2.x rejects `--print --output-format stream-json` without
      // `--verbose`: "When using --print, --output-format=stream-json requires
      // --verbose". --verbose only affects what claude logs to stderr; the
      // stream-json stdout payload is unchanged, so the gateway's NDJSON
      // parser is unaffected.
      args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
    }
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
      fallbackModel: params.fallbackModel,
      jsonSchema: params.jsonSchema,
      addDir: params.addDir,
      noSessionPersistence: params.noSessionPersistence,
      settingSources: params.settingSources,
      settings: params.settings,
      tools: params.tools,
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
    stablePrefixHash,
    stablePrefixTokens,
    stdinPayload,
    cacheControlBlocks,
    cacheControlTtlSeconds,
    warnings: warnings.length > 0 ? warnings : undefined,
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
    prompt?: string;
    promptParts?: PromptParts;
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
    // Phase 4 slice ζ — Codex working-dir + add-dir parity. Both flags are in
    // CODEX_RESUME_FILTERED_FLAGS (resume inherits the original session's cwd
    // and writable dirs), so we emit them on NEW sessions only.
    workingDir?: string;
    addDir?: string[];
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CodexRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("codex", params.model, cliInfo);

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: params.operation,
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;
  const assembledPrompt = inputResolution.assembledPrompt;
  const stablePrefixHash = inputResolution.stablePrefixHash;
  const stablePrefixTokens = inputResolution.stablePrefixTokens;

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({ prompt: assembledPrompt });
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

  let effectivePrompt = assembledPrompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = params.mcpServers ? [...new Set(params.mcpServers)] : [];

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = runtime.approvalManager.decide({
      cli: "codex",
      operation: params.operation,
      prompt: assembledPrompt, // Use raw assembled prompt for review-context detection, not optimized
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
  // Note: `codex exec resume` does NOT accept sandbox policy flags; the original
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
  const sandboxFlags = resolveCodexSandboxFlags({
    sandboxMode: params.sandboxMode,
    askForApproval: params.askForApproval,
    fullAuto: params.fullAuto,
    useLegacyFullAutoFlag: params.useLegacyFullAutoFlag,
  });
  if (sandboxFlags.warning) {
    runtime.logger.warn(`[${corrId}] ${sandboxFlags.warning}`);
  }
  if (sessionPlan.mode === "new") {
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

  // U26: High-impact feature flags. `--search` is retained as a compatibility
  // input but current `codex exec` no longer accepts it, so the helper warns
  // and emits no argv. `--profile` is accepted for new sessions only. The other
  // flags here are accepted on resume per `codex exec resume --help` and are
  // emitted in both branches.
  let highImpactCleanup: (() => void) | undefined;
  if (sessionPlan.mode === "new") {
    // Phase 4 slice ζ: emit working-dir and add-dir on new sessions only.
    // Both flags are listed in CODEX_RESUME_FILTERED_FLAGS — resume inherits
    // the original session's cwd and writable-dir policy, so emitting them
    // on resume would be silently stripped (wasteful + misleading on argv
    // logs). Gating here mirrors `--search` / `--sandbox`.
    if (params.workingDir) {
      args.push("-C", params.workingDir);
    }
    if (params.addDir && params.addDir.length > 0) {
      for (const dir of params.addDir) {
        args.push("--add-dir", dir);
      }
    }
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
    if (high.warning) {
      runtime.logger.warn(`[${corrId}] ${high.warning}`);
    }
    args.push(...high.args);
    highImpactCleanup = high.cleanup;
  } else {
    if (params.profile) {
      runtime.logger.warn(
        `[${corrId}] profile is ignored on Codex resume because current codex exec resume does not accept --profile.`
      );
    }
    const high = prepareCodexHighImpactFlags({
      outputSchema: params.outputSchema,
      search: params.search,
      profile: undefined,
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
    if (high.warning) {
      runtime.logger.warn(`[${corrId}] ${high.warning}`);
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
    stablePrefixHash,
    stablePrefixTokens,
  };
}

export function prepareGeminiRequest(
  params: {
    prompt?: string;
    promptParts?: PromptParts;
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
     * U23 + Phase 4 slice ε: output format. `json` emits `-o json` (single
     * JSON object with usageMetadata). `stream-json` emits `-o stream-json`
     * (NDJSON event stream — `init` / `message` / `result` lines). Both
     * route through `extractUsageAndCost` so usage tokens reach the flight
     * recorder. Defaults to "text".
     */
    outputFormat?: "text" | "json" | "stream-json";
    // U27: high-impact features (all optional)
    sandbox?: boolean;
    policyFiles?: string[];
    adminPolicyFiles?: string[];
    attachments?: string[];
    /**
     * Phase 4 slice γ: emit `--skip-trust` so first-run workspaces don't
     * block headless invocations on the interactive trust prompt. Default
     * is undefined (preserves current prompt behaviour for legacy callers).
     */
    skipTrust?: boolean;
    /**
     * Emit `--yolo` (auto-approve all actions). Equivalent in effect to
     * `approvalMode: "yolo"`; provided for CLI ergonomic parity. Routed
     * through the same approval gate (sets `bypassRequested`), and never
     * emitted alongside `--approval-mode yolo` so there is a single
     * auto-approve path. Default undefined.
     */
    yolo?: boolean;
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("gemini", params.model, cliInfo);

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: params.operation,
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;
  const assembledPrompt = inputResolution.assembledPrompt;
  const stablePrefixHash = inputResolution.stablePrefixHash;
  const stablePrefixTokens = inputResolution.stablePrefixTokens;

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: assembledPrompt,
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

  let effectivePrompt = assembledPrompt;
  if (params.optimizePrompt) {
    const optimized = optimizePromptText(effectivePrompt);
    logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
    effectivePrompt = optimized;
  }

  const requestedMcpServers = params.mcpServers ? [...new Set(params.mcpServers)] : [];

  let approvalDecision: ApprovalRecord | null = null;
  if (params.approvalStrategy === "mcp_managed") {
    approvalDecision = runtime.approvalManager.decide({
      cli: "gemini",
      operation: params.operation,
      prompt: assembledPrompt, // Use raw assembled prompt for review-context detection, not optimized
      bypassRequested: params.approvalMode === "yolo" || params.yolo === true,
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

  const unsupported = (field: string, detail: string): ExtendedToolResponse =>
    createErrorResponse(
      params.operation,
      1,
      "",
      corrId,
      new Error(`${field} is not supported by Antigravity CLI (agy): ${detail}`)
    );

  if (
    effectiveApprovalMode &&
    effectiveApprovalMode !== "default" &&
    effectiveApprovalMode !== "yolo"
  ) {
    return unsupported(
      "approvalMode",
      "use 'default' for prompted execution or 'yolo'/yolo=true for --dangerously-skip-permissions"
    );
  }
  if (params.allowedTools && params.allowedTools.length > 0) {
    return unsupported("allowedTools", "agy has no non-interactive allowed-tools flag");
  }
  if (requestedMcpServers.length > 0) {
    return unsupported(
      "mcpServers",
      "agy has no non-interactive allowed MCP server allowlist flag"
    );
  }
  if (params.outputFormat && params.outputFormat !== "text") {
    return unsupported("outputFormat", "agy print mode currently emits text only");
  }
  if (params.policyFiles && params.policyFiles.length > 0) {
    return unsupported("policyFiles", "agy has no --policy flag");
  }
  if (params.adminPolicyFiles && params.adminPolicyFiles.length > 0) {
    return unsupported("adminPolicyFiles", "agy has no --admin-policy flag");
  }
  if (params.attachments && params.attachments.length > 0) {
    return unsupported("attachments", "agy has no documented @path attachment-token contract");
  }
  if (params.skipTrust) {
    return unsupported("skipTrust", "agy has no --skip-trust flag");
  }

  const args = ["--print", effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  if (params.includeDirs && params.includeDirs.length > 0) {
    sanitizeCliArgValues(params.includeDirs, "includeDirs");
    params.includeDirs.forEach(dir => args.push("--add-dir", dir));
  }
  if (params.sandbox) {
    args.push("--sandbox");
  }
  if (params.yolo || effectiveApprovalMode === "yolo") {
    args.push("--dangerously-skip-permissions");
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    approvalDecision,
    reviewIntegrity,
    args,
    stablePrefixHash,
    stablePrefixTokens,
  };
}

export function prepareGrokRequest(
  params: {
    prompt?: string;
    promptParts?: PromptParts;
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
    /**
     * Phase 4 slice δ: emit `--max-turns N` so callers can cap agent-loop
     * iterations for cost / latency control. Mirrors Claude's wiring.
     */
    maxTurns?: number;
    /**
     * Phase 4 slice ζ: emit `--cwd <DIR>` so headless callers can set Grok's
     * working directory without depending on the gateway process's cwd.
     */
    workingDir?: string;
    /**
     * Phase 4 slice θ — Grok HIGH parity. All five are passthrough flags:
     *
     * - `sandbox` → `--sandbox <PROFILE>` (freeform; Grok 0.1.210 --help
     *   shows no enum constraint, unlike --effort / --permission-mode /
     *   --output-format which all show `[possible values: …]`).
     * - `rules` → `--rules <RULES>`. Supports `@file` prefix; gateway
     *   passes the value verbatim and lets Grok parse it.
     * - `systemPromptOverride` → `--system-prompt-override <PROMPT>`.
     *   Distinct from Claude's --system-prompt / --append-system-prompt
     *   (Grok has only one override flag).
     * - `allow` / `deny` → repeatable `--allow <RULE>` / `--deny <RULE>`
     *   per --help ("Repeat to add multiple rules"). One argv pair per
     *   entry — NOT comma-joined like --tools / --disallowed-tools.
     */
    sandbox?: string;
    rules?: string;
    systemPromptOverride?: string;
    allow?: string[];
    deny?: string[];
    /**
     * Grok 0.2.x context/compaction controls (both enum passthrough flags):
     * - `compactionMode` → `--compaction-mode <summary|transcript|segments>`
     *   (default summary; sets GROK_COMPACTION_MODE).
     * - `compactionDetail` → `--compaction-detail <none|minimal|balanced|verbose>`
     *   (default verbose; only affects `--compaction-mode segments`; sets
     *   GROK_COMPACTION_DETAIL).
     */
    compactionMode?: string;
    compactionDetail?: string;
    /** Grok 0.2.x: `--agent <NAME>` agent name or definition file path. */
    agent?: string;
    /** Grok 0.2.x: `--best-of-n <N>` parallel headless attempts (pick best). */
    bestOfN?: number;
    /** Grok 0.2.x: `--check` append self-verification loop (headless only). */
    check?: boolean;
    /** Grok 0.2.x: `--disable-web-search` disable web search and remote retrieval tools. */
    disableWebSearch?: boolean;
    /** Grok 0.2.x: `--todo-gate` enable runtime turn-end TodoGate for this session. */
    todoGate?: boolean;
    /** Grok 0.2.x: `--verbatim` send prompt exactly as given (skips gateway optimization). */
    verbatim?: boolean;
    /** Grok 0.2.x: `--agents <JSON>` inline subagent definitions (object or JSON string). */
    agents?: string | Record<string, unknown>;
    /** Grok 0.2.x: `--prompt-file <PATH>` single-turn prompt from a file. */
    promptFile?: string;
    /** Grok 0.2.x: `--prompt-json <JSON>` single-turn prompt JSON blocks (object or string). */
    promptJson?: string | unknown;
    /** Grok 0.2.x: `--single <PROMPT>` single-turn prompt (distinct from gateway `-p`). */
    single?: string;
    /** Grok 0.2.x: `--experimental-memory` enable cross-session memory. */
    experimentalMemory?: boolean;
    /** Grok 0.2.x: `--no-alt-screen` run inline without alt screen. */
    noAltScreen?: boolean;
    /** Grok 0.2.x: `--no-memory` disable cross-session memory. */
    noMemory?: boolean;
    /** Grok 0.2.x: `--no-plan` disable plan mode. */
    noPlan?: boolean;
    /** Grok 0.2.x: `--no-subagents` disable subagent spawning. */
    noSubagents?: boolean;
    /** Grok 0.2.x: `--oauth` use OAuth during authentication. */
    oauth?: boolean;
    /** Grok 0.2.x: `--restore-code` check out original session commit when resuming. */
    restoreCode?: boolean;
    /**
     * Grok 0.2.32+: `--leader-socket <PATH>` custom leader socket path (default
     * `~/.grok/leader.sock`). Lets the gateway target an isolated leader process
     * (e.g. a local/branch Grok build) without colliding with the default one.
     */
    leaderSocket?: string;
    /**
     * Grok 0.2.x: native `-w`/`--worktree` CLI flag (NOT gateway slice λ worktree).
     * `true` → bare `--worktree`; string → `--worktree <name>`.
     */
    nativeWorktree?: boolean | string;
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): CliRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("grok", params.model, cliInfo);

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: params.operation,
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;
  const assembledPrompt = inputResolution.assembledPrompt;
  const stablePrefixHash = inputResolution.stablePrefixHash;
  const stablePrefixTokens = inputResolution.stablePrefixTokens;

  // Review integrity check on raw prompt (before optimization)
  const reviewIntegrity = checkReviewIntegrity({
    prompt: assembledPrompt,
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

  let effectivePrompt = assembledPrompt;
  const skipPromptOptimization = Boolean(params.verbatim);
  if (params.optimizePrompt && !skipPromptOptimization) {
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
      prompt: assembledPrompt, // Use raw assembled prompt for review-context detection, not optimized
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

  // Contract-driven argv assembly. The covered request-level flags are emitted
  // by `buildArgvFromGeneration` from the grok contract + generation runs (see
  // src/provider-codegen.ts). The runs are interleaved with the five special
  // flags (`--model`, permission, `--agents`, `--prompt-json`, `--worktree`)
  // at their exact original positions, so output is byte-identical to the prior
  // hand-written block (locked by grok-argv-golden.test.ts). Adding a clean
  // request flag is now a single generation-table row, not a hand-edited
  // conditional here.
  const grokContract = UPSTREAM_CLI_CONTRACTS.grok;
  const genParams = params as Record<string, unknown>;
  const args = ["-p", effectivePrompt];
  if (resolvedModel) args.push("--model", resolvedModel);
  args.push(...buildArgvFromGeneration(grokContract, GROK_GEN_OUTPUT_FORMAT, genParams));
  if (effectiveAlwaysApprove) {
    args.push("--always-approve");
  } else if (params.permissionMode) {
    args.push("--permission-mode", params.permissionMode);
  }
  args.push(...buildArgvFromGeneration(grokContract, GROK_GEN_MAIN, genParams));
  if (params.agents !== undefined) {
    if (typeof params.agents === "string") {
      if (!params.agents.trim()) {
        return createErrorResponse(
          params.operation,
          1,
          "",
          corrId,
          new Error("agents: must be a non-empty JSON string or object map")
        ) as ExtendedToolResponse;
      }
      args.push("--agents", params.agents);
    } else if (Object.keys(params.agents).length > 0) {
      const agentsResult = validateClaudeAgentsMap(params.agents);
      if (!agentsResult.ok) {
        return createErrorResponse(
          params.operation,
          1,
          "",
          corrId,
          new Error(agentsResult.message)
        ) as ExtendedToolResponse;
      }
      args.push("--agents", JSON.stringify(agentsResult.value));
    }
  }
  args.push(...buildArgvFromGeneration(grokContract, GROK_GEN_PROMPT_FILE, genParams));
  if (params.promptJson !== undefined) {
    const promptJsonValue =
      typeof params.promptJson === "string" ? params.promptJson : JSON.stringify(params.promptJson);
    if (!promptJsonValue.trim()) {
      return createErrorResponse(
        params.operation,
        1,
        "",
        corrId,
        new Error("promptJson: must be a non-empty JSON string or serializable value")
      ) as ExtendedToolResponse;
    }
    args.push("--prompt-json", promptJsonValue);
  }
  args.push(...buildArgvFromGeneration(grokContract, GROK_GEN_SINGLE, genParams));
  args.push(...buildArgvFromGeneration(grokContract, GROK_GEN_TAIL, genParams));
  if (params.nativeWorktree === true) {
    args.push("--worktree");
  } else if (typeof params.nativeWorktree === "string" && params.nativeWorktree.length > 0) {
    args.push("--worktree", params.nativeWorktree);
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    requestedMcpServers,
    approvalDecision,
    reviewIntegrity,
    args,
    stablePrefixHash,
    stablePrefixTokens,
  };
}

export function prepareMistralRequest(
  params: {
    prompt?: string;
    promptParts?: PromptParts;
    model?: string;
    outputFormat?: string;
    permissionMode?: MistralAgentMode;
    allowedTools?: string[];
    disallowedTools?: string[];
    approvalStrategy: "legacy" | "mcp_managed";
    approvalPolicy?: string;
    mcpServers?: ClaudeMcpServerName[];
    correlationId?: string;
    optimizePrompt: boolean;
    operation: string;
    /**
     * Phase 4 slice γ: emit `--trust` to bypass Vibe's interactive trust
     * prompt for this invocation only (not persisted). Default undefined.
     */
    trust?: boolean;
    /** Phase 4 slice δ: Vibe `--max-turns N` cap on agent-loop iterations. */
    maxTurns?: number;
    /** Phase 4 slice δ: Vibe `--max-price DOLLARS` cumulative-cost cap. */
    maxPrice?: number;
    /** Vibe 2.x: `--max-tokens N` cumulative prompt + completion token cap. */
    maxTokens?: number;
    /** Phase 4 slice ζ: Vibe `--workdir <DIR>` working-directory parity. */
    workingDir?: string;
    /** Phase 4 slice ζ: Vibe `--add-dir <DIR>` repeatable add-dir parity. */
    addDir?: string[];
  },
  runtime: GatewayServerRuntime = resolveGatewayServerRuntime()
): (CliRequestPrep & { mistralEnv: Record<string, string> }) | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  const cliInfo = getCliInfo();
  const resolvedModel = resolveModelAlias("mistral", params.model, cliInfo);

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: params.operation,
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;
  const assembledPrompt = inputResolution.assembledPrompt;
  const stablePrefixHash = inputResolution.stablePrefixHash;
  const stablePrefixTokens = inputResolution.stablePrefixTokens;

  const reviewIntegrity = checkReviewIntegrity({
    prompt: assembledPrompt,
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

  let effectivePrompt = assembledPrompt;
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
      prompt: assembledPrompt,
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
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
    trust: params.trust,
    maxTurns: params.maxTurns,
    maxPrice: params.maxPrice,
    maxTokens: params.maxTokens,
    workingDir: params.workingDir,
    addDir: params.addDir,
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
    stablePrefixHash,
    stablePrefixTokens,
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

/**
 * Phase 4 slice δ post-review: pure helper extracted from
 * `handleMistralRequest` so the retry-path arg-preservation invariants
 * (trust + maxTurns + maxPrice from slices γ/δ) are unit-testable
 * without mocking awaitJobOrDefer. Any param the wrapper threads into
 * the FIRST `buildMistralCliInvocation` call MUST also be threaded
 * through here, or a fresh-workspace / budgeted run can degrade on
 * the second attempt.
 */
export function buildMistralRetryPrep(
  params: Pick<
    MistralRequestParams,
    | "outputFormat"
    | "permissionMode"
    | "allowedTools"
    | "disallowedTools"
    | "approvalStrategy"
    | "trust"
    | "maxTurns"
    | "maxPrice"
    | "maxTokens"
    | "workingDir"
    | "addDir"
  > & { effectivePrompt: string },
  recoveryModel: string
): { args: string[]; env: Record<string, string>; ignoredDisallowedTools: boolean } {
  return buildMistralCliInvocation({
    prompt: params.effectivePrompt,
    resolvedModel: recoveryModel,
    outputFormat: params.outputFormat,
    permissionMode:
      params.approvalStrategy === "mcp_managed"
        ? "auto-approve"
        : (params.permissionMode ?? "auto-approve"),
    allowedTools: params.allowedTools,
    disallowedTools: params.disallowedTools,
    trust: params.trust,
    maxTurns: params.maxTurns,
    maxPrice: params.maxPrice,
    maxTokens: params.maxTokens,
    workingDir: params.workingDir,
    addDir: params.addDir,
  });
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
  outputFormat?: string,
  warnings?: WarningEntry[]
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
      // Issue #1: mirror the model reply into structuredContent. These tools
      // emit structuredContent without declaring an MCP outputSchema, so a
      // spec-conformant client may treat structuredContent as authoritative and
      // never surface content[0].text. Carrying the reply here keeps the model
      // output visible to structuredContent-preferring clients. Holds the same
      // text as content[0].text (any worktree banner prepended downstream is a
      // gateway annotation, not model output, and is intentionally not mirrored).
      response: finalStdout,
      model: prep.resolvedModel || "default",
      cli,
      correlationId: corrId,
      sessionId: sessionId || null,
      durationMs,
      // Phase 4 slice β: thread sessionId + home so the Mistral branch of
      // extractUsageAndCost can read `~/.vibe/logs/session/<dir>/meta.json`.
      // Other CLIs ignore the ctx (their usage source is stdout).
      ...extractUsageAndCost(cli, stdout, outputFormat, { sessionId, home: homedir() }),
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
  if (warnings && warnings.length > 0) {
    response.warnings = warnings;
  }
  return response;
}

export interface GrokApiRequestParams {
  prompt?: string;
  promptParts?: PromptParts;
  model?: string;
  sessionId?: string;
  createNewSession?: boolean;
  correlationId?: string;
  optimizePrompt: boolean;
  optimizeResponse?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: XaiReasoningEffort;
  timeoutMs?: number;
}

interface GrokApiRequestPrep {
  corrId: string;
  effectivePrompt: string;
  resolvedModel: string;
  input: string | XaiResponsesInputMessage[];
  instructions?: string;
  stablePrefixHash: string | null;
  stablePrefixTokens: number | null;
}

function buildXaiPromptPartsUserContent(promptParts: PromptParts): string {
  const userSections: string[] = [];
  if (promptParts.tools && promptParts.tools.length > 0) {
    userSections.push(`<tools>\n${promptParts.tools}\n</tools>`);
  }
  if (promptParts.context && promptParts.context.length > 0) {
    userSections.push(`<context>\n${promptParts.context}\n</context>`);
  }
  if (promptParts.task && promptParts.task.length > 0) {
    userSections.push(promptParts.task);
  }

  return userSections.join("\n\n");
}

function buildXaiPromptPartsEffectivePrompt(
  instructions: string | undefined,
  userContent: string
): string {
  return instructions && instructions.length > 0
    ? `${instructions}\n\n${userContent}`
    : userContent;
}

function prepareGrokApiRequest(
  params: GrokApiRequestParams,
  providers: ProvidersConfig
): GrokApiRequestPrep | ExtendedToolResponse {
  const corrId = params.correlationId || randomUUID();
  if (!providers.xai) {
    return createErrorResponse(
      "grok_api_request",
      1,
      "",
      corrId,
      new Error("[providers.xai] is not configured")
    ) as ExtendedToolResponse;
  }

  const inputResolution = resolvePromptOrPartsForPrep({
    prompt: params.prompt,
    promptParts: params.promptParts,
    operation: "grok_api_request",
    correlationId: corrId,
  });
  if (!inputResolution.ok) return inputResolution.error;

  const instructions =
    params.promptParts?.system && params.promptParts.system.length > 0
      ? params.promptParts.system
      : undefined;
  let effectivePrompt = inputResolution.assembledPrompt;
  let input: string | XaiResponsesInputMessage[];
  if (params.promptParts) {
    let userContent = buildXaiPromptPartsUserContent(params.promptParts);
    if (params.optimizePrompt) {
      const optimized = optimizePromptText(userContent);
      logOptimizationTokens("prompt", corrId, userContent, optimized);
      userContent = optimized;
    }
    effectivePrompt = buildXaiPromptPartsEffectivePrompt(instructions, userContent);
    input = [{ role: "user", content: userContent }];
  } else {
    if (params.optimizePrompt) {
      const optimized = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimized);
      effectivePrompt = optimized;
    }
    input = effectivePrompt;
  }

  const resolvedModel = params.model ?? providers.xai.defaultModel;
  if (params.reasoningEffort && !/^grok-4\.3(?:$|[-.])/.test(resolvedModel)) {
    return createErrorResponse(
      "grok_api_request",
      1,
      "",
      corrId,
      new Error("reasoningEffort is currently supported only for xAI model grok-4.3")
    ) as ExtendedToolResponse;
  }

  return {
    corrId,
    effectivePrompt,
    resolvedModel,
    instructions,
    input,
    stablePrefixHash: inputResolution.stablePrefixHash,
    stablePrefixTokens: inputResolution.stablePrefixTokens,
  };
}

function usageFromXaiResult(result: XaiResponsesResult): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
} {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    costUsd: result.usage.costUsd,
  };
}

async function getExistingSessionForProvider(
  sessionManager: ISessionManager,
  sessionId: string | undefined,
  provider: ProviderType
): Promise<Session | null> {
  if (!sessionId) return null;
  const existing = await sessionManager.getSession(sessionId);
  if (existing && existing.cli !== provider) {
    throw new Error(
      `Session ${sessionId} belongs to provider '${existing.cli}', not '${provider}'`
    );
  }
  return existing;
}

function asXaiApiError(error: unknown): XaiApiError | null {
  if (error instanceof XaiApiError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof XaiApiError ? cause : null;
}

function buildGrokApiToolResponse(args: {
  result: XaiResponsesResult;
  prep: GrokApiRequestPrep;
  corrId: string;
  durationMs: number;
  sessionId?: string;
  previousResponseId?: string;
  stalePreviousResponseCleared: boolean;
  optimizeResponse: boolean;
}): ExtendedToolResponse {
  let text = args.result.text;
  if (args.optimizeResponse) {
    const optimized = optimizeResponseText(text);
    logOptimizationTokens("response", args.corrId, text, optimized);
    text = optimized;
  }

  const response: ExtendedToolResponse = {
    content: [{ type: "text", text }],
    structuredContent: {
      // Issue #1: mirror the model reply (see buildCliResponse rationale).
      response: text,
      provider: "grok-api",
      cli: "grok-api",
      model: args.result.model || args.prep.resolvedModel,
      correlationId: args.corrId,
      sessionId: args.sessionId || null,
      responseId: args.result.responseId,
      previousResponseId: args.previousResponseId || null,
      stalePreviousResponseCleared: args.stalePreviousResponseCleared,
      status: args.result.status,
      httpStatus: args.result.httpStatus,
      durationMs: args.durationMs,
      ...usageFromXaiResult(args.result),
      exitCode: 0,
      retryCount: 0,
    },
  };
  if (args.sessionId) response.sessionId = args.sessionId;
  return response;
}

async function resolveGrokApiSession(
  params: Pick<GrokApiRequestParams, "sessionId" | "createNewSession">,
  runtime: GatewayServerRuntime
): Promise<{ sessionId: string; previousResponseId?: string }> {
  if (params.sessionId) {
    const existing = await getExistingSessionForProvider(
      runtime.sessionManager,
      params.sessionId,
      "grok-api"
    );
    const session =
      existing ??
      (await runtime.sessionManager.createSession(
        "grok-api",
        "Grok API Session",
        params.sessionId
      ));
    const previous =
      !params.createNewSession && typeof session.metadata?.xaiPreviousResponseId === "string"
        ? session.metadata.xaiPreviousResponseId
        : undefined;
    return { sessionId: session.id, previousResponseId: previous };
  }

  if (!params.createNewSession) {
    const active = await runtime.sessionManager.getActiveSession("grok-api");
    if (active) {
      const previous =
        typeof active.metadata?.xaiPreviousResponseId === "string"
          ? active.metadata.xaiPreviousResponseId
          : undefined;
      return { sessionId: active.id, previousResponseId: previous };
    }
  }

  const session = await runtime.sessionManager.createSession(
    "grok-api",
    "Grok API Session",
    `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
  );
  return { sessionId: session.id };
}

export async function handleGrokApiRequest(
  deps: HandlerDeps,
  params: GrokApiRequestParams
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  const startTime = Date.now();
  const prep = prepareGrokApiRequest(params, runtime.providers);
  if ("content" in prep) return prep;
  const { corrId } = prep;
  const xaiConfig = runtime.providers.xai;
  let durationMs = 0;
  let wasSuccessful = false;

  try {
    await getExistingSessionForProvider(runtime.sessionManager, params.sessionId, "grok-api");
  } catch (err) {
    return createErrorResponse("grok_api_request", 1, "", corrId, err as Error);
  }

  if (!xaiConfig) {
    return createErrorResponse(
      "grok_api_request",
      1,
      "",
      corrId,
      new Error("[providers.xai] is not configured")
    );
  }

  const apiKey = process.env[xaiConfig.apiKeyEnv]?.trim();
  if (!apiKey) {
    return createErrorResponse(
      "grok_api_request",
      1,
      "",
      corrId,
      new Error(`xAI API key env var ${xaiConfig.apiKeyEnv} is not set`)
    );
  }

  safeFlightStart(
    {
      correlationId: corrId,
      cli: "grok-api",
      model: prep.resolvedModel,
      prompt: prep.effectivePrompt,
      sessionId: params.sessionId,
      stablePrefixHash: prep.stablePrefixHash ?? undefined,
      stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
    },
    runtime
  );

  let sessionId: string | undefined;
  let previousResponseId: string | undefined;
  let stalePreviousResponseCleared = false;

  try {
    const session = await resolveGrokApiSession(params, runtime);
    sessionId = session.sessionId;
    previousResponseId = session.previousResponseId;

    const call = (prev: string | undefined) =>
      createXaiResponse(
        {
          baseUrl: xaiConfig.baseUrl,
          apiKey,
          model: prep.resolvedModel,
          input: prep.input,
          instructions: prep.instructions,
          previousResponseId: prev,
          maxOutputTokens: params.maxOutputTokens,
          temperature: params.temperature,
          topP: params.topP,
          reasoningEffort: params.reasoningEffort,
          timeoutMs: params.timeoutMs,
        },
        runtime.logger
      );

    let result: XaiResponsesResult;
    try {
      result = await call(previousResponseId);
    } catch (error) {
      const xaiError = asXaiApiError(error);
      if (xaiError?.status === 404 && previousResponseId) {
        runtime.logger.warn(
          `[${corrId}] xAI previous_response_id was rejected; clearing stale session metadata and retrying fresh`
        );
        await runtime.sessionManager.updateSessionMetadata(sessionId, {
          xaiPreviousResponseId: null,
          xaiResponseCreatedAt: null,
        });
        stalePreviousResponseCleared = true;
        previousResponseId = undefined;
        result = await call(undefined);
      } else {
        throw error;
      }
    }

    durationMs = Math.max(0, Date.now() - startTime);
    wasSuccessful = true;

    await runtime.sessionManager.updateSessionMetadata(sessionId, {
      xaiPreviousResponseId: result.responseId,
      xaiResponseCreatedAt: new Date().toISOString(),
      xaiModel: result.model || prep.resolvedModel,
    });
    await runtime.sessionManager.updateSessionUsage(sessionId);

    safeFlightComplete(
      corrId,
      {
        response: result.text,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: params.optimizePrompt || (params.optimizeResponse ?? false),
        exitCode: 0,
        status: "completed",
        ...usageFromXaiResult(result),
      },
      runtime
    );

    return buildGrokApiToolResponse({
      result,
      prep,
      corrId,
      durationMs,
      sessionId,
      previousResponseId,
      stalePreviousResponseCleared,
      optimizeResponse: params.optimizeResponse ?? false,
    });
  } catch (error) {
    durationMs = Math.max(0, Date.now() - startTime);
    const err = error as Error;
    const xaiError = asXaiApiError(error);
    runtime.logger.error(`[${corrId}] grok_api_request failed`, err.message);
    safeFlightComplete(
      corrId,
      {
        response: xaiError?.responseText ?? "",
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 1,
        errorMessage: err.message,
        status: "failed",
      },
      runtime
    );
    return createErrorResponse("grok_api_request", 1, "", corrId, err);
  } finally {
    runtime.performanceMetrics.recordRequest(
      "grok-api",
      durationMs || Math.max(0, Date.now() - startTime),
      wasSuccessful
    );
  }
}

/**
 * Slice 3 helper: compute the cache_ttl_expiring_soon warning for a
 * claude session, if the feature is enabled, the session has prior cache
 * writes, and ttlRemainingMs is below the threshold (30s by default).
 * Returns null when no warning applies.
 */
function maybeBuildCacheTtlWarning(args: {
  runtime: GatewayServerRuntime;
  sessionId: string | undefined;
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral";
  thresholdMs?: number;
}): WarningEntry | null {
  if (args.cli !== "claude") return null;
  if (!args.sessionId) return null;
  if (!args.runtime.cacheAwareness?.warnOnTtlExpiry) return null;
  const stats = computeSessionCacheStats(args.runtime.flightRecorder, args.sessionId);
  if (stats.requestCount === 0 || !stats.lastRequestAt) return null;
  const ttl = computeTtlRemaining(stats, args.cli, {
    anthropicTtlSeconds: args.runtime.cacheAwareness.anthropicTtlSeconds,
  });
  if (ttl === null) return null;
  const threshold = args.thresholdMs ?? 30_000;
  if (ttl >= threshold) return null;
  return {
    code: "cache_ttl_expiring_soon",
    ttlRemainingMs: ttl,
    message: `Anthropic cache breakpoint for session ${args.sessionId} expires in ${ttl}ms (< ${threshold}ms). Subsequent requests may miss the cache.`,
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Exported Handler Functions (for DI-based testing)
//──────────────────────────────────────────────────────────────────────────────

export interface GeminiRequestParams {
  prompt?: string;
  promptParts?: PromptParts;
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
  /**
   * U23 + Phase 4 slice ε: "json" emits `-o json`; "stream-json" emits
   * `-o stream-json` (NDJSON event stream). Both are usage-extracted.
   */
  outputFormat?: "text" | "json" | "stream-json";
  // U27: high-impact features
  sandbox?: boolean;
  policyFiles?: string[];
  adminPolicyFiles?: string[];
  attachments?: string[];
  /** Phase 4 slice γ: emit `--skip-trust` for fresh-workspace headless runs. */
  skipTrust?: boolean;
  /** Emit `--yolo` (auto-approve all). Equivalent to approvalMode "yolo"; gated identically. */
  yolo?: boolean;
  workspace?: string;
  /** Slice λ: run this request inside a gateway-owned git worktree. */
  worktree?: boolean | { name?: string; ref?: string };
}

export interface HandlerDeps {
  sessionManager: ISessionManager;
  logger: {
    info: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
  workspaces?: WorkspaceRegistry;
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
    workspaces: deps.workspaces,
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
      promptParts: params.promptParts,
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
      skipTrust: params.skipTrust,
      yolo: params.yolo,
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
      prompt: prep.effectivePrompt,
      sessionId: params.sessionId,
      stablePrefixHash: prep.stablePrefixHash ?? undefined,
      stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] gemini_request invoked with model=${prep.resolvedModel || "default"}, approvalMode=${params.approvalMode}, prompt length=${prep.effectivePrompt.length}`
  );

  try {
    // Antigravity CLI supports `--conversation`, but not a supported fresh
    // session-id flag. Fresh sessions emit no session flag.
    const sessionPlan = resolveGeminiSessionPlan({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    const userProvidedSession = sessionPlan.resumed;
    const effectiveSessionIdHint = sessionPlan.resumed ? params.sessionId : undefined;
    if (effectiveSessionIdHint) {
      await getExistingSessionForProvider(deps.sessionManager, effectiveSessionIdHint, "gemini");
    }
    args.push(...sessionPlan.args);

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "gemini",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: effectiveSessionIdHint,
        runtime,
        addDir: params.includeDirs,
      });
    } catch (err) {
      return createErrorResponse("gemini_request", 1, "", corrId, err as Error);
    }

    const geminiFrHandoff = buildAsyncFlightRecorderHandoff(
      "gemini",
      prep,
      params.sessionId,
      params.outputFormat
    );
    const result = await awaitJobOrDefer(
      "gemini",
      args,
      corrId,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime,
      undefined,
      undefined,
      geminiFrHandoff.flightRecorderEntry,
      geminiFrHandoff.extractUsage,
      undefined,
      worktreeResolution.cwd
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

    // Post-success session I/O for explicit conversation-resume flows. Fresh
    // Antigravity sessions are owned by the CLI because it has no supported
    // fresh session-id flag the gateway can inject.
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
    if (worktreeResolution.worktreePath) {
      const first = response.content[0];
      if (first && first.type === "text") {
        first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
      }
    }
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
      promptParts: params.promptParts,
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
      skipTrust: params.skipTrust,
      yolo: params.yolo,
    },
    runtime
  );
  if (!("args" in prep)) return prep;

  const { corrId, args, requestedMcpServers, approvalDecision } = prep;

  try {
    // Antigravity CLI supports `--conversation`, but fresh sessions emit no session flag.
    const sessionPlan = resolveGeminiSessionPlan({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });

    // Pre-start session I/O (async handlers: prevent orphaned jobs)
    let effectiveSessionId = sessionPlan.resumed ? params.sessionId : undefined;
    const existingSession = await getExistingSessionForProvider(
      deps.sessionManager,
      effectiveSessionId,
      "gemini"
    );
    args.push(...sessionPlan.args);
    if (effectiveSessionId) {
      if (!existingSession) {
        try {
          await deps.sessionManager.createSession("gemini", "Gemini Session", effectiveSessionId);
        } catch {
          const rechecked = await deps.sessionManager.getSession(effectiveSessionId);
          if (!rechecked) throw new Error(`Failed to create or find session ${effectiveSessionId}`);
        }
      }
      await deps.sessionManager.updateSessionUsage(effectiveSessionId);
    }

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "gemini",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: effectiveSessionId,
        runtime,
        addDir: params.includeDirs,
      });
    } catch (err) {
      return createErrorResponse("gemini_request_async", 1, "", corrId, err as Error);
    }

    // Start job only after all session I/O succeeds. U23: forward outputFormat
    // so AsyncJobManager records it in the durable store (the manager also
    // surfaces it in the snapshot).
    assertUpstreamCliArgs("gemini", args);
    assertUpstreamCliEnv("gemini", undefined);
    // Slice 1.5: pure async path — no upstream safeFlightStart, so the
    // manager owns both logStart and logComplete for this corrId.
    const geminiAsyncFrHandoff = buildAsyncFlightRecorderHandoff(
      "gemini",
      prep,
      effectiveSessionId,
      params.outputFormat
    );
    const job = deps.asyncJobManager.startJob(
      "gemini",
      args,
      corrId,
      worktreeResolution.cwd,
      resolveIdleTimeout("gemini", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      undefined,
      undefined,
      geminiAsyncFrHandoff.flightRecorderEntry,
      geminiAsyncFrHandoff.extractUsage,
      true
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
    if (worktreeResolution.worktreePath) {
      asyncResponse.worktreePath = worktreeResolution.worktreePath;
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
  prompt?: string;
  promptParts?: PromptParts;
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
  /** Phase 4 slice δ: cap agent-loop iterations via `--max-turns N`. */
  maxTurns?: number;
  /** Phase 4 slice ζ: emit `--cwd <DIR>` so the CLI uses the specified working directory. */
  workingDir?: string;
  /** Phase 4 slice θ: Grok `--sandbox <PROFILE>` (freeform passthrough). */
  sandbox?: string;
  /** Phase 4 slice θ: Grok `--rules <RULES>` (supports `@file` prefix; verbatim passthrough). */
  rules?: string;
  /** Phase 4 slice θ: Grok `--system-prompt-override <PROMPT>`. */
  systemPromptOverride?: string;
  /** Phase 4 slice θ: Grok `--allow <RULE>` (repeatable; one entry per --allow instance). */
  allow?: string[];
  /** Phase 4 slice θ: Grok `--deny <RULE>` (repeatable; one entry per --deny instance). */
  deny?: string[];
  /** Grok 0.2.x: `--compaction-mode <summary|transcript|segments>` context control. */
  compactionMode?: string;
  /** Grok 0.2.x: `--compaction-detail <none|minimal|balanced|verbose>`; only affects segments mode. */
  compactionDetail?: string;
  /** Grok 0.2.x: `--agent <NAME>` agent name or definition file path. */
  agent?: string;
  /** Grok 0.2.x: `--best-of-n <N>` parallel headless attempts. */
  bestOfN?: number;
  /** Grok 0.2.x: `--check` self-verification loop (headless only). */
  check?: boolean;
  /** Grok 0.2.x: `--disable-web-search`. */
  disableWebSearch?: boolean;
  /** Grok 0.2.x: `--todo-gate` runtime turn-end TodoGate. */
  todoGate?: boolean;
  /** Grok 0.2.x: `--verbatim` (also skips gateway prompt optimization). */
  verbatim?: boolean;
  agents?: string | Record<string, unknown>;
  promptFile?: string;
  promptJson?: string | unknown;
  single?: string;
  experimentalMemory?: boolean;
  noAltScreen?: boolean;
  noMemory?: boolean;
  noPlan?: boolean;
  noSubagents?: boolean;
  oauth?: boolean;
  restoreCode?: boolean;
  /** Grok 0.2.32+: `--leader-socket <PATH>` custom leader socket path. */
  leaderSocket?: string;
  /** Grok CLI `--worktree` (not gateway slice λ `worktree`). */
  nativeWorktree?: boolean | string;
  workspace?: string;
  /** Slice λ: run this request inside a gateway-owned git worktree. */
  worktree?: boolean | { name?: string; ref?: string };
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
      promptParts: params.promptParts,
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
      maxTurns: params.maxTurns,
      workingDir: params.workingDir,
      sandbox: params.sandbox,
      rules: params.rules,
      systemPromptOverride: params.systemPromptOverride,
      allow: params.allow,
      deny: params.deny,
      compactionMode: params.compactionMode,
      compactionDetail: params.compactionDetail,
      agent: params.agent,
      bestOfN: params.bestOfN,
      check: params.check,
      disableWebSearch: params.disableWebSearch,
      todoGate: params.todoGate,
      verbatim: params.verbatim,
      agents: params.agents,
      promptFile: params.promptFile,
      promptJson: params.promptJson,
      single: params.single,
      experimentalMemory: params.experimentalMemory,
      noAltScreen: params.noAltScreen,
      noMemory: params.noMemory,
      noPlan: params.noPlan,
      noSubagents: params.noSubagents,
      oauth: params.oauth,
      restoreCode: params.restoreCode,
      leaderSocket: params.leaderSocket,
      nativeWorktree: params.nativeWorktree,
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
      prompt: prep.effectivePrompt,
      sessionId: params.sessionId,
      stablePrefixHash: prep.stablePrefixHash ?? undefined,
      stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] grok_request invoked with model=${prep.resolvedModel || "default"}, permissionMode=${params.permissionMode}, prompt length=${prep.effectivePrompt.length}`
  );

  try {
    // Session arg planning (pure, no I/O)
    const sessionResult = resolveGrokSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    if (sessionResult.userProvidedSession) {
      await getExistingSessionForProvider(
        deps.sessionManager,
        sessionResult.effectiveSessionId,
        "grok"
      );
    }
    args.push(...sessionResult.resumeArgs);

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "grok",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: sessionResult.effectiveSessionId,
        runtime,
        workingDir: params.workingDir,
      });
    } catch (err) {
      return createErrorResponse("grok_request", 1, "", corrId, err as Error);
    }

    const grokFrHandoff = buildAsyncFlightRecorderHandoff(
      "grok",
      prep,
      params.sessionId,
      params.outputFormat
    );
    const result = await awaitJobOrDefer(
      "grok",
      args,
      corrId,
      resolveIdleTimeout("grok", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime,
      undefined,
      undefined,
      grokFrHandoff.flightRecorderEntry,
      grokFrHandoff.extractUsage,
      undefined,
      worktreeResolution.cwd
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
    if (worktreeResolution.worktreePath) {
      const first = response.content[0];
      if (first && first.type === "text") {
        first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
      }
    }
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
      promptParts: params.promptParts,
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
      maxTurns: params.maxTurns,
      workingDir: params.workingDir,
      sandbox: params.sandbox,
      rules: params.rules,
      systemPromptOverride: params.systemPromptOverride,
      allow: params.allow,
      deny: params.deny,
      compactionMode: params.compactionMode,
      compactionDetail: params.compactionDetail,
      agent: params.agent,
      bestOfN: params.bestOfN,
      check: params.check,
      disableWebSearch: params.disableWebSearch,
      todoGate: params.todoGate,
      verbatim: params.verbatim,
      agents: params.agents,
      promptFile: params.promptFile,
      promptJson: params.promptJson,
      single: params.single,
      experimentalMemory: params.experimentalMemory,
      noAltScreen: params.noAltScreen,
      noMemory: params.noMemory,
      noPlan: params.noPlan,
      noSubagents: params.noSubagents,
      oauth: params.oauth,
      restoreCode: params.restoreCode,
      leaderSocket: params.leaderSocket,
      nativeWorktree: params.nativeWorktree,
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
    if (sessionResult.userProvidedSession) {
      await getExistingSessionForProvider(
        deps.sessionManager,
        sessionResult.effectiveSessionId,
        "grok"
      );
    }
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

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "grok",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: effectiveSessionId,
        runtime,
        workingDir: params.workingDir,
      });
    } catch (err) {
      return createErrorResponse("grok_request_async", 1, "", corrId, err as Error);
    }

    // Start job only after all session I/O succeeds
    assertUpstreamCliArgs("grok", args);
    assertUpstreamCliEnv("grok", undefined);
    const grokAsyncFrHandoff = buildAsyncFlightRecorderHandoff(
      "grok",
      prep,
      effectiveSessionId,
      params.outputFormat
    );
    const job = deps.asyncJobManager.startJob(
      "grok",
      args,
      corrId,
      worktreeResolution.cwd,
      resolveIdleTimeout("grok", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      undefined,
      undefined,
      grokAsyncFrHandoff.flightRecorderEntry,
      grokAsyncFrHandoff.extractUsage,
      true
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
    if (worktreeResolution.worktreePath) {
      asyncResponse.worktreePath = worktreeResolution.worktreePath;
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
  prompt?: string;
  promptParts?: PromptParts;
  model?: string;
  outputFormat?: string;
  sessionId?: string;
  resumeLatest: boolean;
  createNewSession: boolean;
  permissionMode?: MistralAgentMode;
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
  /** Phase 4 slice γ: emit `--trust` for fresh-workspace headless runs. */
  trust?: boolean;
  /** Phase 4 slice δ: Vibe `--max-turns N` cap on agent-loop iterations. */
  maxTurns?: number;
  /** Phase 4 slice δ: Vibe `--max-price DOLLARS` cumulative-cost cap. */
  maxPrice?: number;
  /** Vibe 2.x: `--max-tokens N` cumulative prompt + completion token cap. */
  maxTokens?: number;
  /** Phase 4 slice ζ: Vibe `--workdir <DIR>` working-directory parity. */
  workingDir?: string;
  /** Phase 4 slice ζ: Vibe `--add-dir <DIR>` repeatable add-dir parity. */
  addDir?: string[];
  workspace?: string;
  /** Slice λ: run this request inside a gateway-owned git worktree. */
  worktree?: boolean | { name?: string; ref?: string };
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
      promptParts: params.promptParts,
      model: params.model,
      outputFormat: params.outputFormat,
      permissionMode: params.permissionMode,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "mistral_request",
      trust: params.trust,
      maxTurns: params.maxTurns,
      maxPrice: params.maxPrice,
      maxTokens: params.maxTokens,
      workingDir: params.workingDir,
      addDir: params.addDir,
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
      prompt: prep.effectivePrompt,
      sessionId: params.sessionId,
      stablePrefixHash: prep.stablePrefixHash ?? undefined,
      stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
    },
    runtime
  );
  deps.logger.info(
    `[${corrId}] mistral_request invoked with model=${prep.resolvedModel || "default"}, permissionMode=${params.permissionMode || "auto-approve"}, prompt length=${prep.effectivePrompt.length}`
  );

  try {
    const sessionResult = resolveMistralSessionArgs({
      sessionId: params.sessionId,
      resumeLatest: params.resumeLatest,
      createNewSession: params.createNewSession,
    });
    if (sessionResult.userProvidedSession) {
      await getExistingSessionForProvider(
        deps.sessionManager,
        sessionResult.effectiveSessionId,
        "mistral"
      );
    }
    args.push(...sessionResult.resumeArgs);

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "mistral",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: sessionResult.effectiveSessionId,
        runtime,
        workingDir: params.workingDir,
        addDir: params.addDir,
      });
    } catch (err) {
      return createErrorResponse("mistral_request", 1, "", corrId, err as Error);
    }

    const mistralFrHandoff = buildAsyncFlightRecorderHandoff(
      "mistral",
      prep,
      params.sessionId,
      params.outputFormat
    );
    let result = await awaitJobOrDefer(
      "mistral",
      args,
      corrId,
      resolveIdleTimeout("mistral", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      runtime,
      mistralEnv,
      undefined,
      mistralFrHandoff.flightRecorderEntry,
      mistralFrHandoff.extractUsage,
      undefined,
      worktreeResolution.cwd
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
        const retryPrep = buildMistralRetryPrep(
          { ...params, effectivePrompt: prep.effectivePrompt },
          recoveryModel
        );
        const retryArgs = [...retryPrep.args, ...sessionResult.resumeArgs];
        // Reuse the FR handoff built above — the retry preserves corrId,
        // so the manager's logComplete still updates the original row.
        result = await awaitJobOrDefer(
          "mistral",
          retryArgs,
          corrId,
          resolveIdleTimeout("mistral", params.idleTimeoutMs),
          params.outputFormat,
          true,
          runtime,
          retryPrep.env,
          undefined,
          mistralFrHandoff.flightRecorderEntry,
          mistralFrHandoff.extractUsage,
          undefined,
          worktreeResolution.cwd
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
    if (worktreeResolution.worktreePath) {
      const first = response.content[0];
      if (first && first.type === "text") {
        first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
      }
    }
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
      promptParts: params.promptParts,
      model: params.model,
      outputFormat: params.outputFormat,
      permissionMode: params.permissionMode,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      mcpServers: params.mcpServers,
      correlationId: params.correlationId,
      optimizePrompt: params.optimizePrompt,
      operation: "mistral_request_async",
      trust: params.trust,
      maxTurns: params.maxTurns,
      maxPrice: params.maxPrice,
      maxTokens: params.maxTokens,
      workingDir: params.workingDir,
      addDir: params.addDir,
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

    let effectiveSessionId = sessionResult.effectiveSessionId;
    const existingSession = await getExistingSessionForProvider(
      deps.sessionManager,
      sessionResult.userProvidedSession ? effectiveSessionId : undefined,
      "mistral"
    );
    args.push(...sessionResult.resumeArgs);
    if (sessionResult.userProvidedSession && effectiveSessionId) {
      if (!existingSession) {
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

    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "mistral",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: effectiveSessionId,
        runtime,
        workingDir: params.workingDir,
        addDir: params.addDir,
      });
    } catch (err) {
      return createErrorResponse("mistral_request_async", 1, "", corrId, err as Error);
    }

    assertUpstreamCliArgs("mistral", args);
    assertUpstreamCliEnv("mistral", mistralEnv);
    const mistralAsyncFrHandoff = buildAsyncFlightRecorderHandoff(
      "mistral",
      prep,
      effectiveSessionId,
      params.outputFormat
    );
    const job = deps.asyncJobManager.startJob(
      "mistral",
      args,
      corrId,
      worktreeResolution.cwd,
      resolveIdleTimeout("mistral", params.idleTimeoutMs),
      params.outputFormat,
      params.forceRefresh,
      mistralEnv,
      undefined,
      mistralAsyncFrHandoff.flightRecorderEntry,
      mistralAsyncFrHandoff.extractUsage,
      true
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
    if (worktreeResolution.worktreePath) {
      asyncResponse.worktreePath = worktreeResolution.worktreePath;
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
    prompt?: string;
    promptParts?: PromptParts;
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
    // Phase 4 slice ζ — Codex working-dir + add-dir parity.
    workingDir?: string;
    addDir?: string[];
    workspace?: string;
    /** Slice λ: run this request inside a gateway-owned git worktree. */
    worktree?: boolean | { name?: string; ref?: string };
  }
): Promise<ExtendedToolResponse> {
  const runtime = resolveHandlerRuntime(deps);
  try {
    await getExistingSessionForProvider(deps.sessionManager, params.sessionId, "codex");
  } catch (err) {
    return createErrorResponse("codex_request_async", 1, "", params.correlationId, err as Error);
  }
  const prep = prepareCodexRequest(
    {
      prompt: params.prompt,
      promptParts: params.promptParts,
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
      workingDir: params.workingDir,
      addDir: params.addDir,
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
        const newSession = await deps.sessionManager.createSession(
          "codex",
          "Codex Session",
          `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
        );
        effectiveSessionId = newSession.id;
      }
    } else if (params.sessionId) {
      await deps.sessionManager.updateSessionUsage(params.sessionId);
    } else if (params.createNewSession) {
      const newSession = await deps.sessionManager.createSession(
        "codex",
        "Codex Session",
        `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
      );
      effectiveSessionId = newSession.id;
    }

    // Slice λ: resolve worktree directive after session I/O so resume reuse
    // can read metadata.worktreePath. A pre-startJob failure here means
    // prepCleanup is still owned locally; run it before returning.
    let worktreeResolution: ResolvedWorktree = {};
    try {
      worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
        provider: "codex",
        workspace: params.workspace,
        worktree: params.worktree,
        sessionId: effectiveSessionId,
        runtime,
        workingDir: params.workingDir,
        addDir: params.addDir,
      });
    } catch (err) {
      runPrepCleanupLocally();
      return createErrorResponse("codex_request_async", 1, "", corrId, err as Error);
    }

    // Start job only after all session I/O succeeds. If startJob throws before
    // registering the record, ownership stays here and we run it in the catch.
    assertUpstreamCliArgs("codex", args);
    assertUpstreamCliEnv("codex", undefined);
    const codexAsyncFrHandoff = buildAsyncFlightRecorderHandoff(
      "codex",
      prep,
      effectiveSessionId,
      params.outputFormat
    );
    let job;
    try {
      job = deps.asyncJobManager.startJob(
        "codex",
        args,
        corrId,
        worktreeResolution.cwd,
        resolveIdleTimeout("codex", params.idleTimeoutMs),
        params.outputFormat,
        params.forceRefresh,
        undefined,
        prepCleanup,
        codexAsyncFrHandoff.flightRecorderEntry,
        codexAsyncFrHandoff.extractUsage,
        true
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
    if (worktreeResolution.worktreePath) {
      asyncResponse.worktreePath = worktreeResolution.worktreePath;
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
    flightRecorder,
    cacheAwareness,
    providers,
  } = runtime;
  // `flightRecorder` is destructured into closure scope so the session_get
  // handler (see ~line 5590) has the FlightRecorderQuery read capability
  // available without re-resolving runtime. Slice 2 will populate the
  // `cacheState` field of session_get's response from this read surface.
  // `cacheAwareness` is the loaded [cache_awareness] block (config.ts).
  void flightRecorder;
  void cacheAwareness;
  const grokApiToolsEnabled = shouldRegisterGrokApiTools(providers);
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
  // Instructions must reflect the SAME gate as tool registration (incl.
  // hasStore()), or clients get advertised tools that return "tool not found".
  const server = newGatewayMcpServer(asyncJobsEnabled, grokApiToolsEnabled);
  registerBaseResources(server, runtime);
  registerValidationTools(server, { asyncJobManager });
  registerWorkspaceTools(server, runtime);

  if (grokApiToolsEnabled) {
    server.tool(
      "grok_api_request",
      "Run an xAI Grok API request synchronously through the Responses API. Requires exactly one of prompt or promptParts. Registered only when [providers.xai] is configured and its API-key env var is present.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for xAI Grok API (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. The stable prefix hash is logged for cache_state aggregates; xAI does not receive cache_control hints."
        ),
        model: z
          .string()
          .min(1)
          .optional()
          .describe("xAI model id; defaults to [providers.xai].default_model"),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Gateway grok-api session to continue. The gateway stores xAI previous_response_id in session metadata."
          ),
        createNewSession: z
          .boolean()
          .default(false)
          .describe(
            "Start a fresh xAI response chain. With sessionId, ignores any stored previous_response_id for this request."
          ),
        correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
        optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
        optimizeResponse: z.boolean().default(false).describe("Optimize response output"),
        maxOutputTokens: MAX_TOKENS_SCHEMA.optional().describe(
          "xAI Responses API max_output_tokens. Bounded to safe integers <= 100000000."
        ),
        temperature: z
          .number()
          .finite()
          .min(0)
          .max(2)
          .optional()
          .describe("Sampling temperature passed to xAI Responses API"),
        topP: z
          .number()
          .finite()
          .min(0)
          .max(1)
          .optional()
          .describe("Nucleus sampling top_p passed to xAI Responses API"),
        reasoningEffort: z
          .enum(["none", "low", "medium", "high"])
          .optional()
          .describe("xAI Responses API reasoning.effort"),
        timeoutMs: z
          .number()
          .int()
          .min(30_000)
          .max(3_600_000)
          .optional()
          .describe("HTTP request timeout in ms (min 30s, max 1h, default 10m)"),
      },
      {
        title: "Grok API request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
        model,
        sessionId,
        createNewSession,
        correlationId,
        optimizePrompt,
        optimizeResponse,
        maxOutputTokens,
        temperature,
        topP,
        reasoningEffort,
        timeoutMs,
      }) => {
        return handleGrokApiRequest(
          { sessionManager, logger, runtime },
          {
            prompt,
            promptParts,
            model,
            sessionId,
            createNewSession,
            correlationId,
            optimizePrompt,
            optimizeResponse,
            maxOutputTokens,
            temperature,
            topP,
            reasoningEffort,
            timeoutMs,
          }
        );
      }
    );
  }

  server.tool(
    "claude_request",
    "Run a Claude Code CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .optional()
        .describe("Prompt text for Claude (mutually exclusive with promptParts)"),
      promptParts: PromptPartsSchema.optional().describe(
        "Cache-aware structured prompt: { system?, tools?, context?, task, cacheControl? }. Use for repeated calls that share a stable prefix — `system`/`tools`/`context` are the stable head; `task` is the volatile tail (never marked). Set `cacheControl: { system?: boolean, tools?: boolean, context?: boolean }` to opt into explicit Anthropic prefix caching via `--input-format stream-json` (slice κ). Requires `outputFormat: 'stream-json'` and hard-codes `ttl='1h'` (Anthropic rejects 5m blocks after Claude Code's 1h-marked session-wrap content). Mutually exclusive with `prompt`. The stable prefix hash is logged to the flight recorder for cache_state aggregates."
      ),
      model: z
        .string()
        .optional()
        .describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
      outputFormat: z
        .enum(["text", "json", "stream-json"])
        .default("stream-json")
        .describe(
          "Output format (text|json|stream-json). DEFAULT: stream-json — the gateway parses NDJSON usage events to extract input/output/cache_read/cache_creation tokens + cost + model, persists them to the flight recorder for cache_state aggregates, and still returns the assistant text. Override to 'text' only when you truly want unparsed stdout (loses observability)."
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          "Gateway session record to associate (uses the active session if omitted). Claude continuity itself is via continueSession (--continue); this ID is gateway bookkeeping, not a Claude-native session."
        ),
      continueSession: z
        .boolean()
        .default(false)
        .describe(
          "Continue the most recent Claude conversation in this cwd (emits --continue; real CLI continuity)."
        ),
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
        .record(z.string(), z.record(z.string(), z.unknown()))
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
      // Phase 4 slice η — Claude reliability + structured-output parity
      fallbackModel: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Claude --fallback-model: model name to auto-fallback to when the default model is overloaded (effective only with --print, which the gateway always uses)."
        ),
      jsonSchema: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          "Claude --json-schema: JSON Schema literal (NOT a path) constraining structured output. Object values are JSON.stringify-d; string values are passed verbatim. Use with outputFormat='json'."
        ),
      // Phase 4 slice ζ — Claude additional-workspace-dirs parity
      addDir: z
        .array(z.string())
        .optional()
        .describe(
          "Claude --add-dir: additional directories the CLI is allowed to read/write beyond the process cwd. Each entry is emitted as its own --add-dir instance."
        ),
      // Claude session / settings / tools surface (2.x)
      noSessionPersistence: z
        .boolean()
        .optional()
        .describe(
          "Claude --no-session-persistence: do not write this session to disk (ephemeral one-shot runs; mirrors codex --ephemeral)."
        ),
      settingSources: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Claude --setting-sources: comma-separated setting sources to load (user|project|local) for reproducible/isolated headless runs."
        ),
      settings: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Claude --settings: path to a settings JSON file or a JSON literal of additional settings. Powerful: settings can define hooks/permissions/model; passed verbatim."
        ),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          'Claude --tools: restrict the available built-in tool set (distinct from allowedTools permission gating). Pass [""] to disable all tools.'
        ),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
      worktree: WORKTREE_SCHEMA.optional(),
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
    {
      title: "Claude Code request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      prompt,
      promptParts,
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
      fallbackModel,
      jsonSchema,
      addDir,
      noSessionPersistence,
      settingSources,
      settings,
      tools,
      workspace,
      worktree,
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
          promptParts,
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
          fallbackModel,
          jsonSchema,
          addDir,
          noSessionPersistence,
          settingSources,
          settings,
          tools,
        },
        runtime
      );
      if (!("args" in prep)) return prep;

      const { corrId, args } = prep;
      let durationMs = 0;
      let wasSuccessful = false;

      // Session resolution happens BEFORE safeFlightStart so that:
      //   (1) the TTL warning reads the PRIOR session's lastWriteAt
      //       rather than the row about to be inserted (codex-r1/F1).
      //   (2) the flight-recorder row is tagged with effectiveSessionId
      //       (the session the CLI will actually resume), not the raw
      //       user-provided sessionId.
      let effectiveSessionId = sessionId;
      let useContinue = continueSession;
      // Guard the active-session lookup: in some test harnesses the
      // sessionManager is undefined; the original try-catch wrapped this
      // block, so we replicate that tolerance here. Failure leaves
      // effectiveSessionId as the user-provided sessionId.
      let activeSession: Awaited<ReturnType<ISessionManager["getActiveSession"]>> | null = null;
      try {
        activeSession = await sessionManager.getActiveSession("claude");
      } catch (err) {
        logger.warn(
          `[${corrId}] sessionManager.getActiveSession failed (non-fatal): ${(err as Error).message}`
        );
      }

      if (!createNewSession && !continueSession && !sessionId && activeSession) {
        effectiveSessionId = activeSession.id;
        useContinue = true;
      }
      if (!useContinue && effectiveSessionId && activeSession?.id === effectiveSessionId) {
        useContinue = true;
      }

      try {
        await getExistingSessionForProvider(sessionManager, effectiveSessionId, "claude");
      } catch (err) {
        return createErrorResponse("claude_request", 1, "", corrId, err as Error);
      }

      // Slice 3: if the resolved session has a near-expiry Anthropic
      // cache breakpoint, attach a structured warning (NOT a hard error)
      // to the response. Computed BEFORE safeFlightStart so the current
      // row does not skew lastRequestAt.
      const ttlWarning = maybeBuildCacheTtlWarning({
        runtime,
        sessionId: effectiveSessionId,
        cli: "claude",
      });
      // Rec #4: include any prep-time warnings (e.g. cacheable_prefix_uncached).
      const warnings: WarningEntry[] = [
        ...(ttlWarning ? [ttlWarning] : []),
        ...(prep.warnings ?? []),
      ];

      safeFlightStart(
        {
          correlationId: corrId,
          cli: "claude",
          model: prep.resolvedModel || "default",
          prompt: prep.effectivePrompt,
          sessionId: effectiveSessionId,
          stablePrefixHash: prep.stablePrefixHash ?? undefined,
          stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
          cacheControlBlocks: prep.cacheControlBlocks,
          cacheControlTtlSeconds: prep.cacheControlTtlSeconds,
        },
        runtime
      );
      logger.info(
        `[${corrId}] claude_request invoked with model=${prep.resolvedModel || "default"}, outputFormat=${outputFormat}, prompt length=${prep.effectivePrompt.length}, sessionId=${effectiveSessionId}, cacheControlBlocks=${prep.cacheControlBlocks ?? 0}`
      );

      try {
        if (useContinue) {
          args.push("--continue");
        } else if (effectiveSessionId) {
          args.push("--session-id", effectiveSessionId);
          await sessionManager.updateSessionUsage(effectiveSessionId);
        }

        // Slice λ: resolve worktree directive into spawn cwd. Done after
        // session resolution so resume reuse can read metadata.worktreePath.
        let worktreeResolution: ResolvedWorktree = {};
        try {
          worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
            provider: "claude",
            workspace,
            worktree,
            sessionId: effectiveSessionId,
            runtime,
            addDir,
          });
        } catch (err) {
          return createErrorResponse("claude_request", 1, "", corrId, err as Error);
        }

        // Idle timeout only for stream-json (text/json produce no output until done)
        const effectiveIdleTimeout =
          outputFormat === "stream-json" ? resolveIdleTimeout("claude", idleTimeoutMs) : undefined;
        const claudeSyncFrHandoff = buildAsyncFlightRecorderHandoff(
          "claude",
          prep,
          effectiveSessionId,
          outputFormat
        );
        const result = await awaitJobOrDefer(
          "claude",
          args,
          corrId,
          effectiveIdleTimeout,
          outputFormat,
          forceRefresh,
          runtime,
          undefined,
          undefined,
          claudeSyncFrHandoff.flightRecorderEntry,
          claudeSyncFrHandoff.extractUsage,
          prep.stdinPayload,
          worktreeResolution.cwd
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
          // Slice 3: attach any computed warnings to the error response so
          // the caller still sees cache_ttl_expiring_soon when the CLI
          // happens to fail for an unrelated reason.
          const errResp = createErrorResponse("claude", code, stderr, corrId);
          if (warnings.length > 0) {
            (errResp as ExtendedToolResponse).warnings = warnings;
          }
          return errResp;
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
          const streamResponse = buildCliResponse(
            "claude",
            parsed.text,
            optimizeResponse,
            corrId,
            effectiveSessionId,
            prep,
            durationMs,
            undefined,
            outputFormat,
            warnings
          );
          if (worktreeResolution.worktreePath) {
            const first = streamResponse.content[0];
            if (first && first.type === "text") {
              first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
            }
          }
          return streamResponse;
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
        const nonStreamResponse = buildCliResponse(
          "claude",
          stdout,
          optimizeResponse,
          corrId,
          effectiveSessionId,
          prep,
          durationMs,
          undefined,
          outputFormat,
          warnings
        );
        if (worktreeResolution.worktreePath) {
          const first = nonStreamResponse.content[0];
          if (first && first.type === "text") {
            first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
          }
        }
        return nonStreamResponse;
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
    "Run an OpenAI Codex CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .optional()
        .describe("Prompt text for Codex (mutually exclusive with promptParts)"),
      promptParts: PromptPartsSchema.optional().describe(
        "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
      ),
      model: z.string().optional().describe("Model name or alias (e.g. gpt-5.4, latest)"),
      fullAuto: z
        .boolean()
        .default(false)
        .describe(
          "DEPRECATED: prefer `sandboxMode`. Expands to `--sandbox workspace-write`; current Codex no longer accepts approval-policy flags."
        ),
      sandboxMode: z
        .enum(CODEX_SANDBOX_MODES)
        .optional()
        .describe("Codex --sandbox: read-only|workspace-write|danger-full-access."),
      askForApproval: z
        .enum(CODEX_ASK_FOR_APPROVAL_MODES)
        .optional()
        .describe(
          "DEPRECATED compatibility input: accepted but ignored because current Codex no longer accepts --ask-for-approval."
        ),
      useLegacyFullAutoFlag: z
        .boolean()
        .default(false)
        .describe(
          "DEPRECATED compatibility input: accepted but ignored because current Codex no longer accepts --full-auto."
        ),
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
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          "Codex --output-schema. Pass a path (string) or an inline JSON Schema object; object is materialised to a 0o600 temp file under os.tmpdir() and deleted after the run."
        ),
      search: z
        .boolean()
        .optional()
        .describe(
          "DEPRECATED compatibility input: accepted but ignored because current Codex exec no longer accepts --search."
        ),
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
      // Phase 4 slice ζ — Codex working-dir + add-dir parity (new sessions only).
      workingDir: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Codex -C/--cd <DIR>: working root for this session. Emitted on new sessions only; resume inherits the original session's cwd via CODEX_RESUME_FILTERED_FLAGS."
        ),
      addDir: z
        .array(z.string())
        .optional()
        .describe(
          "Codex --add-dir <DIR>: additional writable workspace directories. Emitted once per entry on new sessions only; resume inherits the original session's writable-dir policy."
        ),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
      worktree: WORKTREE_SCHEMA.optional(),
    },
    {
      title: "Codex request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      prompt,
      promptParts,
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
      workingDir,
      addDir,
      workspace,
      worktree,
    }) => {
      const startTime = Date.now();
      const prep = prepareCodexRequest(
        {
          prompt,
          promptParts,
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
          workingDir,
          addDir,
        },
        runtime
      );
      if (!("args" in prep)) return prep;

      const { corrId, args } = prep;
      let durationMs = 0;
      let wasSuccessful = false;
      try {
        await getExistingSessionForProvider(sessionManager, sessionId, "codex");
      } catch (err) {
        return createErrorResponse("codex_request", 1, "", corrId, err as Error);
      }
      safeFlightStart(
        {
          correlationId: corrId,
          cli: "codex",
          model: prep.resolvedModel || "default",
          prompt: prep.effectivePrompt,
          sessionId,
          stablePrefixHash: prep.stablePrefixHash ?? undefined,
          stablePrefixTokens: prep.stablePrefixTokens ?? undefined,
        },
        runtime
      );
      logger.info(
        `[${corrId}] codex_request invoked with model=${prep.resolvedModel || "default"}, fullAuto=${fullAuto}, prompt length=${prep.effectivePrompt.length}`
      );

      // U26 fix: pass the outputSchema cleanup to awaitJobOrDefer, which
      // guarantees the cleanup runs exactly once — inline for direct
      // execution, on terminal status for the job-backed path (sync
      // completion or deferred). The outer finally MUST NOT clean again.
      const prepCleanup =
        "cleanup" in prep && typeof prep.cleanup === "function" ? prep.cleanup : undefined;

      // Slice λ: resolve worktree directive into spawn cwd. Codex has no
      // in-handler session resolution prior to spawn (session lookup is
      // lazy via `codex exec resume`), so the user-supplied sessionId is
      // the only reuse key.
      let worktreeResolution: ResolvedWorktree = {};
      try {
        worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
          provider: "codex",
          workspace,
          worktree,
          sessionId,
          runtime,
          workingDir,
          addDir,
        });
      } catch (err) {
        return createErrorResponse("codex_request", 1, "", corrId, err as Error);
      }

      try {
        const codexSyncFrHandoff = buildAsyncFlightRecorderHandoff(
          "codex",
          prep,
          sessionId,
          outputFormat
        );
        const result = await awaitJobOrDefer(
          "codex",
          args,
          corrId,
          resolveIdleTimeout("codex", idleTimeoutMs),
          outputFormat,
          forceRefresh,
          runtime,
          undefined,
          prepCleanup,
          codexSyncFrHandoff.flightRecorderEntry,
          codexSyncFrHandoff.extractUsage,
          undefined,
          worktreeResolution.cwd
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
            const newSession = await sessionManager.createSession(
              "codex",
              "Codex Session",
              `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
            );
            effectiveSessionId = newSession.id;
          }
        } else if (sessionId) {
          await sessionManager.updateSessionUsage(sessionId);
        } else if (createNewSession) {
          const newSession = await sessionManager.createSession(
            "codex",
            "Codex Session",
            `${GATEWAY_SESSION_PREFIX}${randomUUID()}`
          );
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
        const codexResponse = buildCliResponse(
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
        if (worktreeResolution.worktreePath) {
          const first = codexResponse.content[0];
          if (first && first.type === "text") {
            first.text = formatWorktreePrefix(worktreeResolution.worktreePath) + first.text;
          }
        }
        return codexResponse;
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
    "Fork an existing Codex session into a new branch (codex fork <ID|--last>) and run a prompt against the fork without mutating the original.",
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
        .describe(
          "DEPRECATED compatibility input: accepted but ignored because current Codex no longer accepts --ask-for-approval."
        ),
      correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
      idleTimeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(3_600_000)
        .optional()
        .describe("Idle timeout in ms (min 30s, max 1h, omit=CLI default)"),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
    },
    {
      title: "Fork Codex session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
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
      workspace,
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
      try {
        await getExistingSessionForProvider(sessionManager, sessionId, "codex");
      } catch (err) {
        return createErrorResponse("codex_fork_session", 1, "", corrId, err as Error);
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
        const worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
          provider: "codex",
          workspace,
          sessionId,
          runtime,
        });
        const result = await awaitJobOrDefer(
          "codex",
          finalArgs,
          corrId,
          resolveIdleTimeout("codex", idleTimeoutMs),
          undefined,
          false,
          runtime,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          worktreeResolution.cwd
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
    "Run a Google Antigravity CLI (`agy`) request through the Gemini-compatible gateway tool synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .optional()
        .describe("Prompt text for Antigravity CLI (mutually exclusive with promptParts)"),
      promptParts: PromptPartsSchema.optional().describe(
        "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
      ),
      model: z
        .string()
        .optional()
        .describe(
          "Model name or alias passed to agy --model (e.g. gemini-3-pro-preview, gemini-2.5-flash, pro, flash, latest)"
        ),
      sessionId: z
        .string()
        .optional()
        .describe("Antigravity conversation ID to resume (emits --conversation <id>)"),
      resumeLatest: z.boolean().default(false).describe("Continue the most recent conversation"),
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
        .default([])
        .describe("Unsupported for Antigravity CLI; non-empty values are rejected"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Unsupported for Antigravity CLI; non-empty values are rejected"),
      includeDirs: z
        .array(z.string())
        .optional()
        .describe("Additional workspace directories passed as --add-dir"),
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
      // remains text so existing callers see no behavior change. Phase 4 slice
      // ε adds `stream-json` (NDJSON event stream parsed by
      // parseGeminiStreamJson — `init`/`message`/`result` lines, idle-timeout
      // semantics covered by Gemini's existing real-time stdout streaming).
      outputFormat: z
        .enum(["text", "json", "stream-json"])
        .default("text")
        .describe(
          "Antigravity CLI currently supports text output only through the gateway; json and stream-json are rejected."
        ),
      sandbox: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.sandbox.describe(
        "Run Antigravity in sandbox mode (--sandbox)"
      ),
      policyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.policyFiles.describe(
        "Unsupported for Antigravity CLI; non-empty values are rejected."
      ),
      adminPolicyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.adminPolicyFiles.describe(
        "Unsupported for Antigravity CLI; non-empty values are rejected."
      ),
      attachments: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.attachments.describe(
        "Unsupported for Antigravity CLI; non-empty values are rejected."
      ),
      skipTrust: z
        .boolean()
        .default(false)
        .describe("Unsupported for Antigravity CLI; true is rejected."),
      yolo: z
        .boolean()
        .optional()
        .describe(
          "Emit `--dangerously-skip-permissions` to auto-approve all actions. Routed through the same approval gate. Under mcp_managed the gate still decides."
        ),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
      worktree: WORKTREE_SCHEMA.optional(),
    },
    {
      title: "Gemini request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      prompt,
      promptParts,
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
      skipTrust,
      yolo,
      workspace,
      worktree,
    }) => {
      return handleGeminiRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          promptParts,
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
          skipTrust,
          yolo,
          workspace,
          worktree,
        }
      );
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Grok Tool
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "grok_request",
    "Run an xAI Grok CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .optional()
        .describe("Prompt text for Grok (mutually exclusive with promptParts)"),
      promptParts: PromptPartsSchema.optional().describe(
        "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
      ),
      model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
      // Covered request flags (outputFormat, effort, sandbox, compaction, the
      // boolean toggles, …) are derived from the grok contract + generation
      // table — see GROK_GENERATED_SHAPE / src/provider-codegen.ts. They are
      // spread in here once instead of hand-listed; order is irrelevant to Zod.
      ...GROK_GENERATED_SHAPE,
      sessionId: z
        .string()
        .optional()
        .describe(
          "Provider-native session ID to resume (emits --resume <id>; use resumeLatest for --continue)"
        ),
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
      agents: z
        .union([z.string().min(1), z.record(z.string(), z.record(z.string(), z.unknown()))])
        .optional()
        .describe(
          "Grok --agents <JSON>: inline subagent definitions (JSON string or name → { description, prompt, … } map)."
        ),
      promptJson: z
        .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          "Grok --prompt-json <JSON>: single-turn prompt JSON blocks (string or serializable value)."
        ),
      nativeWorktree: z
        .union([z.boolean(), z.string().min(1)])
        .optional()
        .describe(
          "Grok -w/--worktree: native CLI worktree flag (`true` → bare `--worktree`, string → named). NOT gateway slice λ `worktree`."
        ),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
      worktree: WORKTREE_SCHEMA.optional(),
    },
    {
      title: "Grok request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      prompt,
      promptParts,
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
      maxTurns,
      workingDir,
      sandbox,
      rules,
      systemPromptOverride,
      allow,
      deny,
      compactionMode,
      compactionDetail,
      agent,
      bestOfN,
      check,
      disableWebSearch,
      todoGate,
      verbatim,
      agents,
      promptFile,
      promptJson,
      single,
      experimentalMemory,
      noAltScreen,
      noMemory,
      noPlan,
      noSubagents,
      oauth,
      restoreCode,
      leaderSocket,
      nativeWorktree,
      workspace,
      worktree,
    }) => {
      return handleGrokRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          promptParts,
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
          maxTurns,
          workingDir,
          sandbox,
          rules,
          systemPromptOverride,
          allow,
          deny,
          compactionMode,
          compactionDetail,
          agent,
          bestOfN,
          check,
          disableWebSearch,
          todoGate,
          verbatim,
          agents,
          promptFile,
          promptJson,
          single,
          experimentalMemory,
          noAltScreen,
          noMemory,
          noPlan,
          noSubagents,
          oauth,
          restoreCode,
          leaderSocket,
          nativeWorktree,
          workspace,
          worktree,
        }
      );
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Mistral Vibe Tool
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "mistral_request",
    "Run a Mistral Vibe CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.",
    {
      prompt: z
        .string()
        .min(1, "Prompt cannot be empty")
        .max(100000, "Prompt too long (max 100k chars)")
        .optional()
        .describe("Prompt text for Mistral Vibe (mutually exclusive with promptParts)"),
      promptParts: PromptPartsSchema.optional().describe(
        "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
      ),
      model: z
        .string()
        .optional()
        .describe(
          "Model alias (e.g. mistral-medium-3.5, latest). Resolved alias is injected via VIBE_ACTIVE_MODEL env var; Vibe has no --model flag."
        ),
      outputFormat: z
        .enum(["text", "plain", "json", "streaming", "stream-json"])
        .optional()
        .describe(
          "Output format for Vibe 2.x (text|json|streaming). Legacy aliases plain→text and stream-json→streaming are accepted."
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          "Session ID (user-provided CLI handle for --resume). Current Vibe defaults session logging on; doctor flags explicit [session_logging] enabled = false."
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
      trust: z
        .boolean()
        .default(false)
        .describe(
          "Emit `--trust` so Vibe trusts the cwd for this invocation only (not persisted to trusted_folders.toml) and skips the interactive trust prompt (Phase 4 slice γ)."
        ),
      maxTurns: MAX_TURNS_SCHEMA.optional().describe(
        "Vibe `--max-turns N`: cap the agent-loop iteration count (programmatic mode only, Phase 4 slice δ). Bounded to safe integers ≤ 10000."
      ),
      maxPrice: MAX_PRICE_SCHEMA.optional().describe(
        "Vibe `--max-price DOLLARS`: interrupt the session when cumulative cost crosses this cap (programmatic mode only, Phase 4 slice δ). Bounded to finite values ≤ 10000 USD."
      ),
      maxTokens: MAX_TOKENS_SCHEMA.optional().describe(
        "Vibe `--max-tokens N`: cap cumulative prompt + completion tokens for the session (programmatic mode only). Bounded to safe integers ≤ 100000000."
      ),
      // Phase 4 slice ζ — Vibe working-directory + additional-dirs parity.
      workingDir: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Vibe --workdir <DIR>: change to this directory before running. Single value (Vibe accepts one --workdir per invocation)."
        ),
      addDir: z
        .array(z.string())
        .optional()
        .describe(
          "Vibe --add-dir <DIR>: additional writable workspace directories. Each entry is emitted as its own --add-dir instance (Vibe states this flag may be specified multiple times)."
        ),
      workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
      worktree: WORKTREE_SCHEMA.optional(),
    },
    {
      title: "Mistral Vibe request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      prompt,
      promptParts,
      model,
      outputFormat,
      sessionId,
      resumeLatest,
      createNewSession,
      permissionMode,
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
      trust,
      maxTurns,
      maxPrice,
      maxTokens,
      workingDir,
      addDir,
      workspace,
      worktree,
    }) => {
      return handleMistralRequest(
        { sessionManager, logger, runtime },
        {
          prompt,
          promptParts,
          model,
          outputFormat,
          sessionId,
          resumeLatest,
          createNewSession,
          permissionMode,
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
          trust,
          maxTurns,
          maxPrice,
          maxTokens,
          workingDir,
          addDir,
          workspace,
          worktree,
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
      "Start a Claude Code CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for Claude (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task, cacheControl? }. Same semantics as claude_request: stable head (system/tools/context) + volatile tail (task). Set `cacheControl: { system?, tools?, context?: boolean }` to opt into explicit Anthropic prefix caching via `--input-format stream-json` (slice κ); requires `outputFormat: 'stream-json'` and hard-codes `ttl='1h'`. Mutually exclusive with `prompt`. Stable prefix hash logged to flight recorder."
        ),
        model: z
          .string()
          .optional()
          .describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
        outputFormat: z
          .enum(["text", "json", "stream-json"])
          .default("stream-json")
          .describe(
            "Output format (text|json|stream-json). DEFAULT: stream-json — same rationale as claude_request: keeps usage/cache/cost observable for cache_state aggregates. Override to 'text' only when raw stdout is required (loses observability)."
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Gateway session record to associate (uses the active session if omitted). Claude continuity itself is via continueSession (--continue); this ID is gateway bookkeeping, not a Claude-native session."
          ),
        continueSession: z
          .boolean()
          .default(false)
          .describe(
            "Continue the most recent Claude conversation in this cwd (emits --continue; real CLI continuity)."
          ),
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
          .record(z.string(), z.record(z.string(), z.unknown()))
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
        // Phase 4 slice η — Claude reliability + structured-output parity
        fallbackModel: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claude --fallback-model: model name to auto-fallback to when the default model is overloaded (effective only with --print, which the gateway always uses)."
          ),
        jsonSchema: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            "Claude --json-schema: JSON Schema literal (NOT a path) constraining structured output. Object values are JSON.stringify-d; string values are passed verbatim. Use with outputFormat='json'."
          ),
        // Phase 4 slice ζ — Claude additional-workspace-dirs parity
        addDir: z
          .array(z.string())
          .optional()
          .describe(
            "Claude --add-dir: additional directories the CLI is allowed to read/write beyond the process cwd. Each entry is emitted as its own --add-dir instance."
          ),
        // Claude session / settings / tools surface (2.x)
        noSessionPersistence: z
          .boolean()
          .optional()
          .describe(
            "Claude --no-session-persistence: do not write this session to disk (ephemeral one-shot runs; mirrors codex --ephemeral)."
          ),
        settingSources: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claude --setting-sources: comma-separated setting sources to load (user|project|local) for reproducible/isolated headless runs."
          ),
        settings: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Claude --settings: path to a settings JSON file or a JSON literal of additional settings. Powerful: settings can define hooks/permissions/model; passed verbatim."
          ),
        tools: z
          .array(z.string())
          .optional()
          .describe(
            'Claude --tools: restrict the available built-in tool set (distinct from allowedTools permission gating). Pass [""] to disable all tools.'
          ),
        workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
        worktree: WORKTREE_SCHEMA.optional(),
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
      {
        title: "Claude Code request (async job)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
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
        fallbackModel,
        jsonSchema,
        addDir,
        noSessionPersistence,
        settingSources,
        settings,
        tools,
        workspace,
        worktree,
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
            promptParts,
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
            fallbackModel,
            jsonSchema,
            addDir,
            noSessionPersistence,
            settingSources,
            settings,
            tools,
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
          const existingSession = await getExistingSessionForProvider(
            sessionManager,
            effectiveSessionId,
            "claude"
          );
          if (useContinue) {
            args.push("--continue");
          } else if (effectiveSessionId) {
            args.push("--session-id", effectiveSessionId);
            await sessionManager.updateSessionUsage(effectiveSessionId);
          }

          if (effectiveSessionId) {
            if (!existingSession) {
              await sessionManager.createSession("claude", "Claude Session", effectiveSessionId);
            }
          }

          // Slice 3: TTL warning on resume (async path too).
          const ttlWarning = maybeBuildCacheTtlWarning({
            runtime,
            sessionId: effectiveSessionId,
            cli: "claude",
          });

          // Slice λ: resolve worktree directive after session metadata is
          // settled so resume reuse can read metadata.worktreePath.
          let worktreeResolution: ResolvedWorktree = {};
          try {
            worktreeResolution = await resolveWorkspaceAndWorktreeForRequest({
              provider: "claude",
              workspace,
              worktree,
              sessionId: effectiveSessionId,
              runtime,
              addDir,
            });
          } catch (err) {
            return createErrorResponse("claude_request_async", 1, "", corrId, err as Error);
          }

          // Idle timeout only for stream-json (text/json produce no output until done)
          const effectiveIdleTimeout =
            outputFormat === "stream-json"
              ? resolveIdleTimeout("claude", idleTimeoutMs)
              : undefined;
          assertUpstreamCliArgs("claude", args);
          assertUpstreamCliEnv("claude", undefined);
          const claudeAsyncFrHandoff = buildAsyncFlightRecorderHandoff(
            "claude",
            prep,
            effectiveSessionId,
            outputFormat
          );
          const job = asyncJobManager.startJob(
            "claude",
            args,
            corrId,
            worktreeResolution.cwd,
            effectiveIdleTimeout,
            outputFormat,
            forceRefresh,
            undefined,
            undefined,
            claudeAsyncFrHandoff.flightRecorderEntry,
            claudeAsyncFrHandoff.extractUsage,
            true,
            prep.stdinPayload
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
          if (worktreeResolution.worktreePath) {
            asyncResponse.worktreePath = worktreeResolution.worktreePath;
          }
          // Rec #4: include any prep-time warnings (e.g.
          // cacheable_prefix_uncached) alongside ttlWarning.
          const mergedWarnings: WarningEntry[] = [
            ...(ttlWarning ? [ttlWarning] : []),
            ...(prep.warnings ?? []),
          ];
          if (mergedWarnings.length > 0) {
            asyncResponse.warnings = mergedWarnings;
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
      "Start an OpenAI Codex CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for Codex (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
        ),
        model: z.string().optional().describe("Model name or alias (e.g. gpt-5.4, latest)"),
        fullAuto: z
          .boolean()
          .default(false)
          .describe(
            "DEPRECATED: prefer `sandboxMode`. Expands to `--sandbox workspace-write`; current Codex no longer accepts approval-policy flags."
          ),
        sandboxMode: z
          .enum(CODEX_SANDBOX_MODES)
          .optional()
          .describe("Codex --sandbox: read-only|workspace-write|danger-full-access."),
        askForApproval: z
          .enum(CODEX_ASK_FOR_APPROVAL_MODES)
          .optional()
          .describe(
            "DEPRECATED compatibility input: accepted but ignored because current Codex no longer accepts --ask-for-approval."
          ),
        useLegacyFullAutoFlag: z
          .boolean()
          .default(false)
          .describe(
            "DEPRECATED compatibility input: accepted but ignored because current Codex no longer accepts --full-auto."
          ),
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
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Codex --output-schema. Pass a path (string) or an inline JSON Schema object."),
        search: z
          .boolean()
          .optional()
          .describe(
            "DEPRECATED compatibility input: accepted but ignored because current Codex exec no longer accepts --search."
          ),
        profile: z.string().optional().describe("Codex --profile <name>."),
        configOverrides: CODEX_CONFIG_OVERRIDES_SCHEMA.describe(
          "Codex -c key=value overrides. Keys: /^[a-zA-Z0-9._]+$/. Values: no CR/LF."
        ),
        ephemeral: z.boolean().optional().describe("Codex --ephemeral."),
        images: z.array(z.string()).optional().describe("Codex -i <path>: image attachments."),
        ignoreUserConfig: z.boolean().optional().describe("Codex --ignore-user-config."),
        ignoreRules: z.boolean().optional().describe("Codex --ignore-rules."),
        // Phase 4 slice ζ — Codex working-dir + add-dir parity (new sessions only).
        workingDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Codex -C/--cd <DIR>: working root for this session. New sessions only; resume inherits the original session's cwd."
          ),
        addDir: z
          .array(z.string())
          .optional()
          .describe(
            "Codex --add-dir <DIR>: additional writable workspace directories (repeat per entry). New sessions only."
          ),
        workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
        worktree: WORKTREE_SCHEMA.optional(),
      },
      {
        title: "Codex request (async job)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
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
        workingDir,
        addDir,
        workspace,
        worktree,
      }) => {
        return handleCodexRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            promptParts,
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
            workingDir,
            addDir,
            workspace,
            worktree,
          }
        );
      }
    );

    server.tool(
      "gemini_request_async",
      "Start a Google Antigravity CLI (`agy`) request as a durable background job through the Gemini-compatible gateway tool. Poll with llm_job_status, collect with llm_job_result.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for Antigravity CLI (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
        ),
        model: z
          .string()
          .optional()
          .describe(
            "Model name or alias passed to agy --model (e.g. gemini-3-pro-preview, gemini-2.5-flash, pro, flash, latest)"
          ),
        sessionId: z
          .string()
          .optional()
          .describe("Antigravity conversation ID to resume (emits --conversation <id>)"),
        resumeLatest: z.boolean().default(false).describe("Continue the most recent conversation"),
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
          .default([])
          .describe("Unsupported for Antigravity CLI; non-empty values are rejected"),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe("Unsupported for Antigravity CLI; non-empty values are rejected"),
        includeDirs: z
          .array(z.string())
          .optional()
          .describe("Additional workspace directories passed as --add-dir"),
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
        // remains text so existing callers see no behavior change. Phase 4 slice
        // ε adds `stream-json` (NDJSON event stream parsed by
        // parseGeminiStreamJson — `init`/`message`/`result` lines, idle-timeout
        // semantics covered by Gemini's existing real-time stdout streaming).
        outputFormat: z
          .enum(["text", "json", "stream-json"])
          .default("text")
          .describe(
            "Antigravity CLI currently supports text output only through the gateway; json and stream-json are rejected."
          ),
        sandbox: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.sandbox.describe(
          "Run Antigravity in sandbox mode (--sandbox)"
        ),
        policyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.policyFiles.describe(
          "Unsupported for Antigravity CLI; non-empty values are rejected."
        ),
        adminPolicyFiles: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.adminPolicyFiles.describe(
          "Unsupported for Antigravity CLI; non-empty values are rejected."
        ),
        attachments: GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.shape.attachments.describe(
          "Unsupported for Antigravity CLI; non-empty values are rejected."
        ),
        skipTrust: z
          .boolean()
          .default(false)
          .describe("Unsupported for Antigravity CLI; true is rejected."),
        yolo: z
          .boolean()
          .optional()
          .describe(
            "Emit `--dangerously-skip-permissions` to auto-approve all actions. Routed through the same approval gate. Under mcp_managed the gate still decides."
          ),
        workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
        worktree: WORKTREE_SCHEMA.optional(),
      },
      {
        title: "Gemini request (async job)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
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
        skipTrust,
        yolo,
        workspace,
        worktree,
      }) => {
        return handleGeminiRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            promptParts,
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
            skipTrust,
            yolo,
            workspace,
            worktree,
          }
        );
      }
    );

    server.tool(
      "grok_request_async",
      "Start an xAI Grok CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for Grok (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
        ),
        model: z.string().optional().describe("Model name or alias (e.g. grok-build, latest)"),
        outputFormat: z
          .enum(["plain", "json", "streaming-json"])
          .optional()
          .describe("Output format (plain|json|streaming-json). Grok default is plain."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Provider-native session ID to resume (emits --resume <id>; use resumeLatest for --continue)"
          ),
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
        maxTurns: MAX_TURNS_SCHEMA.optional().describe(
          "Grok `--max-turns N`: cap on agent-loop iterations for cost / latency control (Phase 4 slice δ). Bounded to safe integers ≤ 10000."
        ),
        // Phase 4 slice ζ — Grok working-directory parity.
        workingDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Grok --cwd <DIR>: working directory for this invocation. Lets headless callers run Grok against a directory other than the gateway process's cwd."
          ),
        // Phase 4 slice θ — Grok HIGH parity (sandbox, rules, system-prompt-override, allow, deny).
        sandbox: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Grok --sandbox <PROFILE>: sandbox profile for filesystem and network access. Freeform per `grok --help` (no enum constraint); also settable via GROK_SANDBOX env var."
          ),
        rules: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Grok --rules <RULES>: extra rules to append to the system prompt. Supports `@file` prefix; gateway passes the value verbatim."
          ),
        systemPromptOverride: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Grok --system-prompt-override <PROMPT>: replace the agent's system prompt entirely."
          ),
        allow: z
          .array(z.string())
          .optional()
          .describe(
            "Grok --allow <RULE>: permission allow rules. Each entry → its own --allow instance."
          ),
        deny: z
          .array(z.string())
          .optional()
          .describe(
            "Grok --deny <RULE>: permission deny rules. Each entry → its own --deny instance."
          ),
        compactionMode: z
          .enum(["summary", "transcript", "segments"])
          .optional()
          .describe(
            "Grok --compaction-mode: summary (default) | transcript | segments. Sets GROK_COMPACTION_MODE."
          ),
        compactionDetail: z
          .enum(["none", "minimal", "balanced", "verbose"])
          .optional()
          .describe(
            "Grok --compaction-detail: segment verbatim detail (none|minimal|balanced|verbose, default verbose). Only affects segments mode. Sets GROK_COMPACTION_DETAIL."
          ),
        agent: z
          .string()
          .min(1)
          .optional()
          .describe("Grok --agent <NAME>: agent name or definition file path."),
        bestOfN: MAX_TURNS_SCHEMA.optional().describe(
          "Grok --best-of-n <N>: run the task N ways in parallel and pick the best (headless only)."
        ),
        check: z
          .boolean()
          .optional()
          .describe("Grok --check: append a self-verification loop to the prompt (headless only)."),
        disableWebSearch: z
          .boolean()
          .optional()
          .describe("Grok --disable-web-search: disable web search and remote retrieval tools."),
        todoGate: z
          .boolean()
          .optional()
          .describe(
            "Grok --todo-gate: enable runtime turn-end TodoGate for this session (session-scoped, not persisted)."
          ),
        verbatim: z
          .boolean()
          .optional()
          .describe(
            "Grok --verbatim: send the prompt exactly as given. Also skips gateway optimizePrompt when true."
          ),
        agents: z
          .union([z.string().min(1), z.record(z.string(), z.record(z.string(), z.unknown()))])
          .optional()
          .describe(
            "Grok --agents <JSON>: inline subagent definitions (JSON string or name → { description, prompt, … } map)."
          ),
        promptFile: z
          .string()
          .min(1)
          .optional()
          .describe("Grok --prompt-file <PATH>: single-turn prompt loaded from a file."),
        promptJson: z
          .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            "Grok --prompt-json <JSON>: single-turn prompt JSON blocks (string or serializable value)."
          ),
        single: z
          .string()
          .min(1)
          .optional()
          .describe("Grok --single <PROMPT>: single-turn prompt (in addition to gateway -p)."),
        experimentalMemory: z
          .boolean()
          .optional()
          .describe("Grok --experimental-memory: enable cross-session memory."),
        noAltScreen: z
          .boolean()
          .optional()
          .describe("Grok --no-alt-screen: run inline without alt screen."),
        noMemory: z
          .boolean()
          .optional()
          .describe("Grok --no-memory: disable cross-session memory."),
        noPlan: z.boolean().optional().describe("Grok --no-plan: disable plan mode."),
        noSubagents: z
          .boolean()
          .optional()
          .describe("Grok --no-subagents: disable subagent spawning."),
        oauth: z.boolean().optional().describe("Grok --oauth: use OAuth during authentication."),
        restoreCode: z
          .boolean()
          .optional()
          .describe("Grok --restore-code: check out the original session commit when resuming."),
        leaderSocket: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Grok 0.2.32+ --leader-socket <PATH>: custom leader socket path (default ~/.grok/leader.sock). Targets an isolated leader process, e.g. a local/branch Grok build; name it ~/.grok/leader-*.sock to keep `grok leader list/kill` discovery working."
          ),
        nativeWorktree: z
          .union([z.boolean(), z.string().min(1)])
          .optional()
          .describe(
            "Grok -w/--worktree: native CLI worktree flag (`true` → bare `--worktree`, string → named). NOT gateway slice λ `worktree`."
          ),
        workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
        worktree: WORKTREE_SCHEMA.optional(),
      },
      {
        title: "Grok request (async job)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
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
        maxTurns,
        workingDir,
        sandbox,
        rules,
        systemPromptOverride,
        allow,
        deny,
        compactionMode,
        compactionDetail,
        agent,
        bestOfN,
        check,
        disableWebSearch,
        todoGate,
        verbatim,
        agents,
        promptFile,
        promptJson,
        single,
        experimentalMemory,
        noAltScreen,
        noMemory,
        noPlan,
        noSubagents,
        oauth,
        restoreCode,
        leaderSocket,
        nativeWorktree,
        workspace,
        worktree,
      }) => {
        return handleGrokRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            promptParts,
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
            maxTurns,
            workingDir,
            sandbox,
            rules,
            systemPromptOverride,
            allow,
            deny,
            compactionMode,
            compactionDetail,
            agent,
            bestOfN,
            check,
            disableWebSearch,
            todoGate,
            verbatim,
            agents,
            promptFile,
            promptJson,
            single,
            experimentalMemory,
            noAltScreen,
            noMemory,
            noPlan,
            noSubagents,
            oauth,
            restoreCode,
            leaderSocket,
            nativeWorktree,
            workspace,
            worktree,
          }
        );
      }
    );

    server.tool(
      "mistral_request_async",
      "Start a Mistral Vibe CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.",
      {
        prompt: z
          .string()
          .min(1, "Prompt cannot be empty")
          .max(100000, "Prompt too long (max 100k chars)")
          .optional()
          .describe("Prompt text for Mistral Vibe (mutually exclusive with promptParts)"),
        promptParts: PromptPartsSchema.optional().describe(
          "Cache-aware structured prompt: { system?, tools?, context?, task }. Mutually exclusive with prompt. Stable parts hash into cache_state for prefix-discipline tracking."
        ),
        model: z
          .string()
          .optional()
          .describe(
            "Model alias (resolved into VIBE_ACTIVE_MODEL env var — Vibe has no --model flag)"
          ),
        outputFormat: z
          .enum(["text", "plain", "json", "streaming", "stream-json"])
          .optional()
          .describe(
            "Output format for Vibe 2.x (text|json|streaming). Legacy aliases plain→text and stream-json→streaming are accepted."
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Session ID (user-provided CLI handle for --resume). Current Vibe defaults session logging on; doctor flags explicit [session_logging] enabled = false."
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
        trust: z
          .boolean()
          .default(false)
          .describe(
            "Emit `--trust` so Vibe trusts the cwd for this invocation only (not persisted to trusted_folders.toml) and skips the interactive trust prompt (Phase 4 slice γ)."
          ),
        maxTurns: MAX_TURNS_SCHEMA.optional().describe(
          "Vibe `--max-turns N`: cap the agent-loop iteration count (programmatic mode only, Phase 4 slice δ). Bounded to safe integers ≤ 10000."
        ),
        maxPrice: MAX_PRICE_SCHEMA.optional().describe(
          "Vibe `--max-price DOLLARS`: interrupt the session when cumulative cost crosses this cap (programmatic mode only, Phase 4 slice δ). Bounded to finite values ≤ 10000 USD."
        ),
        maxTokens: MAX_TOKENS_SCHEMA.optional().describe(
          "Vibe `--max-tokens N`: cap cumulative prompt + completion tokens for the session (programmatic mode only). Bounded to safe integers ≤ 100000000."
        ),
        // Phase 4 slice ζ — Vibe working-directory + additional-dirs parity.
        workingDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Vibe --workdir <DIR>: change to this directory before running. Single value per invocation."
          ),
        addDir: z
          .array(z.string())
          .optional()
          .describe(
            "Vibe --add-dir <DIR>: additional writable workspace directories. Each entry is emitted as its own --add-dir instance."
          ),
        workspace: WORKSPACE_ALIAS_SCHEMA.optional(),
        worktree: WORKTREE_SCHEMA.optional(),
      },
      {
        title: "Mistral Vibe request (async job)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        prompt,
        promptParts,
        model,
        outputFormat,
        sessionId,
        resumeLatest,
        createNewSession,
        permissionMode,
        approvalStrategy,
        approvalPolicy,
        mcpServers,
        allowedTools,
        disallowedTools,
        correlationId,
        optimizePrompt,
        idleTimeoutMs,
        forceRefresh,
        trust,
        maxTurns,
        maxPrice,
        maxTokens,
        workingDir,
        addDir,
        workspace,
        worktree,
      }) => {
        return handleMistralRequestAsync(
          { sessionManager, asyncJobManager, logger, runtime },
          {
            prompt,
            promptParts,
            model,
            outputFormat,
            sessionId,
            resumeLatest,
            createNewSession,
            permissionMode,
            approvalStrategy,
            approvalPolicy,
            mcpServers,
            allowedTools,
            disallowedTools,
            correlationId,
            optimizePrompt,
            idleTimeoutMs,
            forceRefresh,
            trust,
            maxTurns,
            maxPrice,
            maxTokens,
            workingDir,
            addDir,
            workspace,
            worktree,
          }
        );
      }
    );

    server.tool(
      "llm_job_status",
      "Check lifecycle status (running|completed|failed|canceled|orphaned) of a gateway async or deferred-sync job by jobId.",
      {
        jobId: z.string().describe("Async job ID from *_request_async"),
      },
      {
        title: "Async job status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      "Retrieve captured stdout/stderr for a gateway async or deferred-sync job by jobId.",
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
      {
        title: "Async job result",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      "Cancel a running gateway async or deferred-sync job by jobId.",
      {
        jobId: z.string().describe("Async job ID from *_request_async"),
      },
      {
        title: "Cancel async job",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
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

  // Read back any persisted request (sync OR async) by its correlation id.
  // Registered unconditionally — it reads the flight recorder, which is
  // independent of async-job persistence. Every sync/async response echoes
  // its id in `structuredContent.correlationId`; pass that id here to recover
  // the persisted prompt/response after the inline result is gone. With flight
  // recording disabled (LLM_GATEWAY_LOGS_DB=none → NoopFlightRecorder) the
  // query yields no rows and this returns the "not found" shape.
  server.tool(
    "llm_request_result",
    "Read back any persisted request (sync or async) from the flight recorder by correlationId, including prompt and response.",
    {
      correlationId: z
        .string()
        .min(1)
        .describe(
          "Correlation id from a prior request's structuredContent.correlationId (sync or async)"
        ),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(2000000)
        .default(PERSISTED_REQUEST_DEFAULT_MAX_CHARS)
        .describe("Max chars of the persisted response to return"),
      includePrompt: z
        .boolean()
        .default(false)
        .describe("Include the full persisted prompt text in the result"),
    },
    {
      title: "Persisted request lookup",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ correlationId, maxChars, includePrompt }) => {
      const record = readPersistedRequest(flightRecorder, correlationId, {
        maxChars,
        includePrompt,
      });
      if (!record) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "No persisted request found for this correlation id",
                  correlationId,
                  hint: "The id may be wrong, the row may have aged out of the flight recorder, or flight recording is disabled (LLM_GATEWAY_LOGS_DB=none).",
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
            text: JSON.stringify({ success: true, request: record }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "llm_process_health",
    "Report gateway process health: async-job manager state plus the resolved persistence configuration and paths.",
    {},
    {
      title: "Gateway process health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
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
      const outboundProviders = {
        xai: providers.xai
          ? {
              configured: true,
              enabled: isXaiProviderEnabled(providers),
              apiKeyEnv: providers.xai.apiKeyEnv,
              apiKeyPresent: isXaiProviderEnabled(providers),
              baseUrl: providers.xai.baseUrl,
              defaultModel: providers.xai.defaultModel,
              mode: isXaiProviderEnabled(providers) ? "sync" : "configured-missing-key",
            }
          : {
              configured: false,
              enabled: false,
              apiKeyEnv: null,
              apiKeyPresent: false,
              baseUrl: null,
              defaultModel: null,
              mode: "disabled",
            },
        sources: providers.sources,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: true, ...health, persistence: persistenceBlock, outboundProviders },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  //──────────────────────────────────────────────────────────────────────────────
  // Approval Audit Tools
  //──────────────────────────────────────────────────────────────────────────────

  server.tool(
    "approval_list",
    "List recent MCP-managed approval decisions recorded by the gateway (approvalStrategy: mcp_managed).",
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
    {
      title: "Approval decisions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
    "List models, aliases, and defaults for one provider CLI (claude|codex|gemini|grok|mistral).",
    {
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          z.enum(["claude", "codex", "gemini", "grok", "mistral"]).optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
    },
    {
      title: "Provider models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cli }) => {
      const cliInfo = getAvailableCliInfo();
      const result = cli ? { [cli]: cliInfo[cli] } : cliInfo;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "provider_tool_capabilities",
    "Report provider tool/feature capabilities and discovered local skill/tool integrations for claude|codex|gemini|grok|grok_api|mistral.",
    {
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          z.enum(["claude", "codex", "gemini", "grok", "grok_api", "mistral"]).optional()
        )
        .describe("Provider filter (claude|codex|gemini|grok|grok_api|mistral)"),
      includeSkills: z
        .boolean()
        .default(true)
        .describe("Include bounded local skill discovery results"),
      includeProviderTools: z
        .boolean()
        .default(true)
        .describe("Include provider-native tools extracted from local skills"),
      includeUnsupported: z
        .boolean()
        .default(true)
        .describe("Include explicit unsupported/degraded input records"),
      includePaths: z
        .boolean()
        .default(false)
        .describe("Include raw local filesystem paths in discovery output"),
      refresh: z.boolean().default(false).describe("Bypass the short-lived capability cache"),
    },
    {
      title: "Provider tool capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({
      cli,
      includeSkills,
      includeProviderTools,
      includeUnsupported,
      includePaths,
      refresh,
    }) => {
      const capabilities = getProviderToolCapabilities({
        cli,
        includeSkills,
        includeProviderTools,
        includeUnsupported,
        includePaths,
        refresh,
      });
      return { content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }] };
    }
  );

  server.tool(
    "cli_versions",
    "Report installed provider CLI versions, availability, and login status for all five providers or one.",
    {
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          z.enum(["claude", "codex", "gemini", "grok", "mistral"]).optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
    },
    {
      title: "Provider CLI versions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cli }) => {
      const versions = await getCliVersions(cli);
      return { content: [{ type: "text", text: JSON.stringify({ versions }, null, 2) }] };
    }
  );

  server.tool(
    "upstream_contracts",
    "Return the gateway's declared provider CLI contracts; with probeInstalled true, diff against installed --help surfaces to detect flag drift.",
    {
      cli: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          CLI_TYPE_ENUM.optional()
        )
        .describe("CLI filter (claude|codex|gemini|grok|mistral)"),
      probeInstalled: z
        .boolean()
        .default(false)
        .describe(
          "When true, run local --help probes and compare advertised flags against the declared contract. Strongly recommended after any provider CLI upgrade to detect drift."
        ),
    },
    {
      title: "Provider CLI contracts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cli, probeInstalled }) => {
      const report = buildUpstreamContractReport({ cli, probeInstalled });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  server.tool(
    "provider_subcommands_list",
    "Return a compact, filterable read-only catalog of declared provider CLI subcommands without flags or raw help.",
    {
      provider: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          CLI_TYPE_ENUM.optional()
        )
        .describe("Optional provider filter (claude|codex|gemini|grok|mistral)"),
      tier: z
        .enum(["catalog", "inspect", "execute_candidate", "diagnostic"])
        .optional()
        .describe("Optional subcommand tier filter"),
      risk: z
        .enum([
          "read_only",
          "writes_local_config",
          "auth",
          "network",
          "starts_server",
          "updates_binary",
          "destructive",
          "executes_agent",
        ])
        .optional()
        .describe("Optional risk classification filter"),
      exposure: z
        .enum(["tracked_only", "mcp_readonly", "mcp_requires_approval", "not_exposed"])
        .optional()
        .describe("Optional MCP exposure filter"),
      commandPathPrefix: z
        .array(z.string().min(1))
        .optional()
        .describe("Optional command path prefix filter, e.g. ['agent']"),
    },
    {
      title: "Provider subcommands catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ provider, tier, risk, exposure, commandPathPrefix }) => {
      const catalog = buildProviderSubcommandsCompactCatalog({
        provider,
        tier,
        risk,
        exposure,
        commandPathPrefix,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...catalog, total: catalog.rows.length }),
          },
        ],
      };
    }
  );

  server.tool(
    "provider_subcommand_contract",
    "Return the detailed read-only contract for exactly one declared provider CLI subcommand.",
    {
      provider: CLI_TYPE_ENUM.describe("Provider (claude|codex|gemini|grok|mistral)"),
      commandPath: z.array(z.string().min(1)).min(1).describe("Command path segments"),
    },
    {
      title: "Provider subcommand contract",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ provider, commandPath }) => {
      const contract = getCliSubcommandContract(provider, commandPath);
      const payload = contract
        ? {
            schemaVersion: "provider-subcommand-contract.v1",
            contract: serializeCliSubcommandContract(provider, contract),
          }
        : {
            schemaVersion: "provider-subcommand-contract.v1",
            error: `No declared ${provider} subcommand contract for ${commandPath.join(" ")}`,
          };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  server.tool(
    "provider_subcommand_drift",
    "Probe declared provider subcommand --help surfaces and return compact drift rows without raw help output.",
    {
      provider: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          CLI_TYPE_ENUM.optional()
        )
        .describe("Optional provider filter (claude|codex|gemini|grok|mistral)"),
      includeClean: z
        .boolean()
        .default(false)
        .describe("When false, return only unavailable or drifted command paths"),
    },
    {
      title: "Provider subcommand drift",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ provider, includeClean }) => {
      const providers = provider ? [provider] : CLI_TYPES;
      const rows = providers.flatMap(cli => {
        const probe = probeInstalledCliContract(cli);
        return Object.values(probe.subcommands).flatMap(sub => {
          const drifted =
            !sub.available || sub.extraFlags.length > 0 || sub.missingFlags.length > 0;
          if (!includeClean && !drifted) return [];
          return [
            {
              provider: cli,
              commandPath: sub.commandPath,
              driftStatus: drifted ? "drift" : "clean",
              available: sub.available,
              extraVsContract: sub.extraFlags,
              missingFromBinary: sub.missingFlags,
              helpHash: sub.helpHash ?? null,
              risk: sub.risk,
              exposure: sub.exposure,
              tier: sub.tier,
              summary: sub.summary,
              warnings: sub.warnings,
            },
          ];
        });
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schemaVersion: "provider-subcommand-drift.v1",
              total: rows.length,
              rows,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "cli_upgrade",
    "Plan (dryRun, default true) or execute an upgrade for one provider CLI using its native update mechanism.",
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
    {
      title: "Upgrade provider CLI",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
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
    "Create a gateway session record for a provider. NOTE: this is gateway bookkeeping (gw-* ID), not a provider-native session — Codex resume needs a real Codex UUID.",
    {
      cli: SESSION_PROVIDER_ENUM.describe(
        "Provider type (claude|codex|gemini|grok|mistral|grok-api)"
      ),
      description: z.string().optional().describe("Session description"),
      setAsActive: z.boolean().default(true).describe("Set as active session"),
    },
    {
      title: "Create session record",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
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
    "List gateway session records and the active session per provider, optionally filtered by provider.",
    {
      cli: SESSION_PROVIDER_ENUM.optional().describe(
        "Provider filter (claude|codex|gemini|grok|mistral|grok-api)"
      ),
    },
    {
      title: "List sessions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cli }) => {
      try {
        const sessions = await sessionManager.listSessions(cli);
        const activeSessions = Object.fromEntries(
          await Promise.all(
            SESSION_PROVIDER_VALUES.map(async provider => [
              provider,
              await sessionManager.getActiveSession(provider),
            ])
          )
        ) as Record<SessionProvider, Awaited<ReturnType<ISessionManager["getActiveSession"]>>>;

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
                  activeSessions: Object.fromEntries(
                    SESSION_PROVIDER_VALUES.map(provider => [
                      provider,
                      activeSessions[provider]?.id || null,
                    ])
                  ),
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
    "Set or clear the active session for a provider; the active session is used when a request omits sessionId.",
    {
      cli: SESSION_PROVIDER_ENUM.describe(
        "Provider type (claude|codex|gemini|grok|mistral|grok-api)"
      ),
      sessionId: z.string().nullable().describe("Session ID (null to clear)"),
    },
    {
      title: "Set active session",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
                    error: "Session not found or does not belong to the specified provider",
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
    "Delete a gateway session record by ID (also removes any gateway-owned worktree attached to it).",
    {
      sessionId: z.string().describe("Session ID"),
    },
    {
      title: "Delete session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
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
    "Get one gateway session record by session ID, including recent request history when available.",
    {
      sessionId: z.string().describe("Session ID"),
    },
    {
      title: "Get session",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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

        // Slice 2: project a compact cacheState view from the flight
        // recorder at read time. NOT persisted on the Session interface
        // (sessions.json stays content-free per the project invariant).
        // The field is OMITTED entirely (not null, not empty object) when
        // the session has zero rows in the flight recorder so the response
        // stays compact for fresh sessions.
        //
        // Slice 3: include ttlRemainingMs derived from the gateway's
        // configured TTL policy. Null for non-claude sessions.
        let cacheState:
          | {
              cli: string | null;
              prefixDistinct: number;
              totalCacheReadTokens: number;
              totalCacheCreationTokens: number;
              requestCount: number;
              hitCount: number;
              hitRate: number;
              estimatedSavingsUsd: number;
              ttlRemainingMs: number | null;
            }
          | undefined;
        try {
          const stats = computeSessionCacheStats(flightRecorder, session.id);
          if (stats.requestCount > 0) {
            const ttlRemainingMs = computeTtlRemaining(stats, stats.cli, {
              anthropicTtlSeconds: cacheAwareness?.anthropicTtlSeconds ?? 300,
            });
            cacheState = {
              cli: stats.cli,
              prefixDistinct: stats.distinctPrefixCount,
              totalCacheReadTokens: stats.totalCacheReadTokens,
              totalCacheCreationTokens: stats.totalCacheCreationTokens,
              requestCount: stats.requestCount,
              hitCount: stats.hitCount,
              hitRate: stats.hitRate,
              estimatedSavingsUsd: stats.estimatedSavingsUsd,
              ttlRemainingMs,
            };
          }
        } catch (err) {
          logger.warn?.(`[session_get] cache-stats lookup failed (non-fatal)`, err as Error);
        }

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
                    ...(cacheState ? { cacheState } : {}),
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
    "Delete all gateway session records, optionally scoped to one provider.",
    {
      cli: SESSION_PROVIDER_ENUM.optional().describe(
        "Provider filter (claude|codex|gemini|grok|mistral|grok-api)"
      ),
    },
    {
      title: "Clear sessions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
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
  // Slice λ: file-backed sessions get a cleanup hook that tears down any
  // git worktrees recorded on session.metadata.worktreePath. PG-backed
  // sessions skip the hook (multi-tenant deployments don't necessarily
  // own a single filesystem); revisit if/when worktree support extends
  // there.
  const worktreeCleanupHook = createWorktreeSessionCleanupHook(logger);

  if (config.database) {
    logger.info("Initializing PostgreSQL session manager");
    const { createDatabaseConnection } = await import("./db.js");
    db = await createDatabaseConnection(config, logger);
    sessionManager = await createSessionManager(config, db, logger);
    logger.info("PostgreSQL session manager initialized");
  } else {
    logger.info("Initializing file-based session manager");
    sessionManager = await createSessionManager(config, undefined, logger, {
      cleanupHook: worktreeCleanupHook,
    });
    logger.info("File-based session manager initialized");
  }

  resourceProvider = new ResourceProvider(
    sessionManager,
    performanceMetrics,
    getFlightRecorder(logger),
    getCacheAwarenessConfig(logger)
  );
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
      const health = getAsyncJobManager().getJobHealth();
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

    if (flightRecorder) {
      flightRecorder.close();
      logger.info("Flight recorder closed");
    }

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

function readMutableGatewayConfig(configPath = defaultGatewayConfigPath()): Record<string, any> {
  if (!existsSync(configPath)) return {};
  const require = createRequire(import.meta.url);
  const TOML = require("smol-toml");
  return TOML.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
}

function writeMutableGatewayConfig(
  data: Record<string, any>,
  configPath = defaultGatewayConfigPath()
): void {
  const require = createRequire(import.meta.url);
  const TOML = require("smol-toml");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, TOML.stringify(data), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function ensureOAuthTable(config: Record<string, any>): Record<string, any> {
  config.http ??= {};
  config.http.oauth ??= {};
  const oauth = config.http.oauth as Record<string, any>;
  oauth.enabled ??= true;
  oauth.issuer ??= "auto";
  oauth.require_pkce ??= true;
  oauth.registration_policy ??= "static_clients";
  oauth.allow_public_clients ??= false;
  oauth.token_ttl_seconds ??= 3600;
  oauth.clients ??= [];
  return oauth;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function requireArg(args: string[], name: string): string {
  const value = argValue(args, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function localBaseUrlForPrint(): string {
  const publicUrl = process.env.LLM_GATEWAY_PUBLIC_URL;
  if (publicUrl) {
    try {
      return new URL(publicUrl).origin;
    } catch {
      // fall through
    }
  }
  return `http://${process.env.LLM_GATEWAY_HTTP_HOST ?? "127.0.0.1"}:${process.env.LLM_GATEWAY_HTTP_PORT ?? "3333"}`;
}

function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function runOAuthCommand(args: string[]): void {
  const [scope, action] = args;
  const config = readMutableGatewayConfig();
  const oauth = ensureOAuthTable(config);
  if (scope === "client") {
    const clients = (Array.isArray(oauth.clients) ? oauth.clients : []) as Array<
      Record<string, any>
    >;
    oauth.clients = clients;
    if (action === "add") {
      const clientId = args[2];
      if (!clientId)
        throw new Error(
          "Usage: llm-cli-gateway oauth client add <client-id> --redirect-uri <uri> [--print-once]"
        );
      const redirectUri = requireArg(args, "--redirect-uri");
      const secret = generateSecret();
      clients.push({
        client_id: clientId,
        client_secret_hash: hashSecret(secret),
        allowed_redirect_uris: [redirectUri],
        scopes: ["mcp"],
      });
      writeMutableGatewayConfig(config);
      printJsonLine({
        ok: true,
        client_id: clientId,
        ...(args.includes("--print-once") ? { client_secret: secret } : {}),
        oauth: {
          issuer: localBaseUrlForPrint(),
          authorization_url: `${localBaseUrlForPrint()}/oauth/authorize`,
          token_url: `${localBaseUrlForPrint()}/oauth/token`,
        },
        note: args.includes("--print-once")
          ? "client_secret is shown once; it is stored only as a hash."
          : "client secret generated and stored only as a hash; rerun rotate --print-once if needed.",
      });
      return;
    }
    if (action === "list") {
      printJsonLine({
        ok: true,
        clients: clients.map(client => ({
          client_id: client.client_id,
          redirect_uris: client.allowed_redirect_uris ?? [],
          secret_configured: Boolean(client.client_secret_hash),
        })),
      });
      return;
    }
    if (action === "rotate") {
      const clientId = args[2];
      const client = clients.find(candidate => candidate.client_id === clientId);
      if (!client) throw new Error(`Unknown OAuth client ${clientId}`);
      const secret = generateSecret();
      client.client_secret_hash = hashSecret(secret);
      writeMutableGatewayConfig(config);
      printJsonLine({
        ok: true,
        client_id: clientId,
        ...(args.includes("--print-once") ? { client_secret: secret } : {}),
        note: "Future OAuth exchanges use the rotated secret; already-issued opaque access tokens expire by token TTL or server restart.",
      });
      return;
    }
    if (action === "revoke") {
      const clientId = args[2];
      oauth.clients = clients.filter(client => client.client_id !== clientId);
      writeMutableGatewayConfig(config);
      printJsonLine({
        ok: true,
        client_id: clientId,
        note: "Future OAuth exchanges are revoked; already-issued opaque access tokens expire by token TTL or server restart.",
      });
      return;
    }
  }
  if (scope === "shared-secret") {
    if (action === "set" || action === "rotate") {
      const secret = generateSecret();
      oauth.registration_policy = "shared_secret";
      oauth.shared_secret = {
        enabled: true,
        secret_hash: hashSecret(secret),
        prompt_label: "Gateway access code",
      };
      writeMutableGatewayConfig(config);
      printJsonLine({
        ok: true,
        shared_secret_enabled: true,
        ...(args.includes("--print-once") ? { shared_secret: secret } : {}),
        note: args.includes("--print-once")
          ? "shared_secret is shown once; it is stored only as a hash."
          : "shared secret generated and stored only as a hash.",
      });
      return;
    }
    if (action === "disable") {
      oauth.shared_secret = { enabled: false, prompt_label: "Gateway access code" };
      if (oauth.registration_policy === "shared_secret")
        oauth.registration_policy = "static_clients";
      writeMutableGatewayConfig(config);
      printJsonLine({ ok: true, shared_secret_enabled: false });
      return;
    }
  }
  throw new Error("Usage: llm-cli-gateway oauth client|shared-secret ...");
}

function runWorkspaceCommand(args: string[]): void {
  const [action] = args;
  if (action === "list") {
    const registry = loadWorkspaceRegistry(logger);
    printJsonLine({
      ok: true,
      default: registry.defaultAlias,
      workspaces: registry.repos.map(describeWorkspace),
      allowed_roots: registry.allowedRoots.map(root => ({
        alias: root.alias,
        path: root.path,
        allow_create_directories: root.allowCreateDirectories,
        allow_init_git_repos: root.allowInitGitRepos,
      })),
    });
    return;
  }
  if (action === "create") {
    const alias = args[1];
    if (!alias)
      throw new Error(
        "Usage: llm-cli-gateway workspace create <alias> --root <root> --slug <slug> --kind folder|git [--default]"
      );
    const repo = createWorkspace({
      alias,
      rootAlias: requireArg(args, "--root"),
      slug: requireArg(args, "--slug"),
      kind: (argValue(args, "--kind") ?? "git") as "folder" | "git",
      setDefault: args.includes("--default"),
      logger,
    });
    printJsonLine({ ok: true, workspace: describeWorkspace(repo) });
    return;
  }
  if (action === "add") {
    const alias = args[1];
    const repoPath = args[2];
    if (!alias || !repoPath)
      throw new Error("Usage: llm-cli-gateway workspace add <alias> <path> [--default]");
    const repo = registerExistingWorkspace({
      alias,
      repoPath,
      setDefault: args.includes("--default"),
      logger,
    });
    printJsonLine({ ok: true, workspace: describeWorkspace(repo) });
    return;
  }
  throw new Error("Usage: llm-cli-gateway workspace list|add|create ...");
}

async function main() {
  startWindowsBootstrapperSelfHeal();

  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-version" || args[0] === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (args[0] === "--help" || args[0] === "-help" || args[0] === "/?" || args[0] === "help") {
    process.stdout.write(
      [
        "llm-cli-gateway MCP server",
        "",
        "Usage:",
        "  llm-cli-gateway [doctor --json|contracts --json|--transport=http|--version]",
        "  llm-cli-gateway oauth client add <id> --redirect-uri <uri> [--print-once]",
        "  llm-cli-gateway workspace list|add|create",
        "",
        "Doctor:",
        "  doctor --json                     # environment, providers, declared contracts",
        "  doctor --json --probe-upstream    # + expensive installed --help probe for drift",
        "",
        "After upgrading provider CLIs (grok/claude/etc), use --probe-upstream or",
        "  llm-cli-gateway contracts --json --probe-installed",
        "to detect when installed binaries have drifted from the gateway contracts.",
        "",
      ].join("\n")
    );
    return;
  }
  if (args[0] === "doctor") {
    if (args.includes("--json")) {
      const probeUpstream = args.includes("--probe-upstream") || args.includes("--probe-installed");
      printDoctorJson({ probeUpstream });
      return;
    }
    process.stderr.write("Only doctor --json is supported in this layer.\n");
    process.exit(2);
  }
  if (args[0] === "oauth") {
    runOAuthCommand(args.slice(1));
    return;
  }
  if (args[0] === "workspace") {
    runWorkspaceCommand(args.slice(1));
    return;
  }
  if (args[0] === "contracts") {
    if (args.includes("--json")) {
      const cliArg = args.find(arg => arg.startsWith("--cli="))?.split("=")[1];
      const cli = CLI_TYPES.includes(cliArg as CliType) ? (cliArg as CliType) : undefined;
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
      [
        "Usage: llm-cli-gateway contracts --json [--cli=claude|codex|gemini|grok|mistral] [--probe-installed]",
        "",
        "After upgrading any provider CLI, use --probe-installed to detect drift between",
        "the installed binary's advertised flags and the gateway's declared contract.",
        "Example: llm-cli-gateway contracts --json --probe-installed --cli=grok",
      ].join("\n") + "\n"
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
    asyncJobManager: getAsyncJobManager(logger),
    approvalManager: getApprovalManager(logger),
    flightRecorder: getFlightRecorder(logger),
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
