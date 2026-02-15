#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { executeCli } from "./executor.js";
import { ISessionManager, createSessionManager } from "./session-manager.js";
import { ResourceProvider } from "./resources.js";
import { PerformanceMetrics } from "./metrics.js";
import { estimateTokens, optimizePrompt as optimizePromptText, optimizeResponse as optimizeResponseText } from "./optimizer.js";
import { loadConfig } from "./config.js";
import { DatabaseConnection } from "./db.js";
import { checkHealth } from "./health.js";
import { getCliInfo, resolveModelAlias } from "./model-registry.js";
import { AsyncJobManager } from "./async-job-manager.js";
import { ApprovalManager, ApprovalPolicy } from "./approval-manager.js";
import { buildClaudeMcpConfig, ClaudeMcpConfigResult, ClaudeMcpServerName } from "./claude-mcp-config.js";

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
  }
};

function logOptimizationTokens(kind: "prompt" | "response", correlationId: string, original: string, optimized: string) {
  const originalTokens = estimateTokens(original);
  const optimizedTokens = estimateTokens(optimized);
  const reduction = originalTokens === 0 ? 0 : ((originalTokens - optimizedTokens) / originalTokens) * 100;
  logger.info(
    `[${correlationId}] ${kind} tokens ${originalTokens} → ${optimizedTokens} (${reduction.toFixed(1)}% reduction)`
  );
}

const server = new McpServer({
  name: "llm-cli-gateway",
  version: "1.0.0"
});

// Global state (initialized asynchronously)
let sessionManager: ISessionManager;
let db: DatabaseConnection | null = null;
const performanceMetrics = new PerformanceMetrics();
let resourceProvider: ResourceProvider;
const asyncJobManager = new AsyncJobManager();
const approvalManager = new ApprovalManager();
const MCP_SERVER_ENUM = z.enum(["sqry", "exa", "ref_tools"]);

// Helper function for standardized error responses
function createErrorResponse(cli: string, code: number, stderr: string, correlationId?: string, error?: Error) {
  let errorMessage = `Error executing ${cli} CLI`;

  if (error) {
    // Command not found or spawn error
    errorMessage += `:\n${error.message}`;
    if (error.message.includes("ENOENT")) {
      errorMessage += `\n\nThe '${cli}' command was not found. Please ensure ${cli} CLI is installed and in your PATH.`;
    }
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI execution failed:`, error.message);
  } else if (code === 124) {
    // Timeout
    errorMessage += `: Command timed out\n${stderr}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI timed out`);
  } else if (code !== 0) {
    // Other non-zero exit code
    errorMessage += ` (exit code ${code}):\n${stderr}`;
    logger.error(`[${correlationId || "unknown"}] ${cli} CLI failed with exit code ${code}`);
  }

  return {
    content: [{ type: "text" as const, text: errorMessage }],
    isError: true
  };
}

function createApprovalDeniedResponse(operation: string, decision: ReturnType<ApprovalManager["decide"]>) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        error: `${operation} denied by MCP-managed approval policy`,
        approval: decision
      }, null, 2)
    }],
    isError: true
  };
}

function normalizeMcpServers(mcpServers?: ClaudeMcpServerName[]): ClaudeMcpServerName[] {
  if (!mcpServers || mcpServers.length === 0) {
    return ["sqry", "exa", "ref_tools"];
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
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        error: `${operation} failed to prepare Claude MCP config`,
        message,
        correlationId,
        mcpServers: {
          requested,
          missing
        }
      }, null, 2)
    }],
    isError: true
  };
}

function resolveClaudeMcpConfig(
  operation: string,
  correlationId: string,
  requestedMcpServers: ClaudeMcpServerName[],
  strictMcpConfig: boolean
): { config: ClaudeMcpConfigResult } | { errorResponse: ReturnType<typeof createMcpConfigErrorResponse> } {
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
      )
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
      )
    };
  }

  return { config: mcpConfig };
}

//──────────────────────────────────────────────────────────────────────────────
// MCP Resources
//──────────────────────────────────────────────────────────────────────────────

// Register all sessions resource
server.registerResource(
  "all-sessions",
  "sessions://all",
  {
    title: "📋 All Sessions",
    description: "List of all conversation sessions across all CLIs",
    mimeType: "application/json"
  },
  async (uri) => {
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
    description: "List of Claude conversation sessions",
    mimeType: "application/json"
  },
  async (uri) => {
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
    description: "List of Codex conversation sessions",
    mimeType: "application/json"
  },
  async (uri) => {
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
    description: "List of Gemini conversation sessions",
    mimeType: "application/json"
  },
  async (uri) => {
    logger.debug("Reading Gemini sessions resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

// Register Claude models resource
server.registerResource(
  "claude-models",
  "models://claude",
  {
    title: "🧠 Claude Models & Capabilities",
    description: "Available Claude models and their capabilities",
    mimeType: "application/json"
  },
  async (uri) => {
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
    title: "🔧 Codex Models & Capabilities",
    description: "Available Codex models and their capabilities",
    mimeType: "application/json"
  },
  async (uri) => {
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
    title: "🌟 Gemini Models & Capabilities",
    description: "Available Gemini models and their capabilities",
    mimeType: "application/json"
  },
  async (uri) => {
    logger.debug("Reading Gemini models resource");
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
    description: "Request counts, response times, and success/failure rates",
    mimeType: "application/json"
  },
  async (uri) => {
    logger.debug("Reading performance metrics resource");
    const contents = await resourceProvider.readResource(uri.href);
    return { contents: contents ? [contents] : [] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Claude Code Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "claude_request",
  {
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Claude"),
    model: z.string().optional().describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
    outputFormat: z.enum(["text", "json"]).default("text").describe("Output format (text|json)"),
    sessionId: z.string().optional().describe("Session ID (uses active if omitted)"),
    continueSession: z.boolean().default(false).describe("Continue active session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools (['Bash(git:*)','Edit','Write'])"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed tools"),
    dangerouslySkipPermissions: z.boolean().default(false).describe("Bypass permissions (sandbox only)"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("mcp_managed").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry", "exa", "ref_tools"]).describe("MCP servers exposed to Claude"),
    strictMcpConfig: z.boolean().default(true).describe("Restrict Claude to provided MCP config only"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, outputFormat, sessionId, continueSession, createNewSession, allowedTools, disallowedTools, dangerouslySkipPermissions, approvalStrategy, approvalPolicy, mcpServers, strictMcpConfig, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    const cliInfo = getCliInfo();
    const resolvedModel = resolveModelAlias("claude", model, cliInfo);
    logger.info(`[${corrId}] claude_request invoked with model=${resolvedModel || "default"}, prompt length=${prompt.length}, sessionId=${sessionId}, dangerouslySkipPermissions=${dangerouslySkipPermissions}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    const requestedMcpServers = normalizeMcpServers(mcpServers as ClaudeMcpServerName[]);
    const mcpConfigResolution = resolveClaudeMcpConfig("claude_request", corrId, requestedMcpServers, strictMcpConfig);
    if ("errorResponse" in mcpConfigResolution) {
      return mcpConfigResolution.errorResponse;
    }
    const mcpConfig = mcpConfigResolution.config;

    let approvalDecision: ReturnType<ApprovalManager["decide"]> | null = null;
    if (approvalStrategy === "mcp_managed") {
      approvalDecision = approvalManager.decide({
        cli: "claude",
        operation: "claude_request",
        prompt: effectivePrompt,
        bypassRequested: dangerouslySkipPermissions,
        fullAuto: false,
        requestedMcpServers: requestedMcpServers,
        allowedTools,
        disallowedTools,
        policy: approvalPolicy as ApprovalPolicy | undefined,
        metadata: {
          model: resolvedModel || "default",
          strictMcpConfig
        }
      });
      if (approvalDecision.status !== "approved") {
        return createApprovalDeniedResponse("claude_request", approvalDecision);
      }
    }

    try {
      const args = ["-p", effectivePrompt];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (outputFormat === "json") args.push("--output-format", "json");

      // Tool permissions
      if (allowedTools && allowedTools.length > 0) {
        args.push("--allowed-tools", ...allowedTools);
      }
      if (disallowedTools && disallowedTools.length > 0) {
        args.push("--disallowed-tools", ...disallowedTools);
      }
      if (approvalStrategy === "mcp_managed") {
        args.push("--permission-mode", "bypassPermissions");
      } else if (dangerouslySkipPermissions) {
        args.push("--permission-mode", "bypassPermissions");
      }

      if (strictMcpConfig || mcpConfig.enabled.length > 0) {
        args.push("--mcp-config", mcpConfig.path);
        if (strictMcpConfig) {
          args.push("--strict-mcp-config");
        }
      }

      // Session management
      let effectiveSessionId = sessionId;
      let useContinue = continueSession;
      const activeSession = await sessionManager.getActiveSession("claude");

      if (!createNewSession && !continueSession && !sessionId && activeSession) {
        // Prefer --continue for active sessions to avoid CLI-side session-id lock collisions.
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

      const { stdout, stderr, code } = await executeCli("claude", args);
      durationMs = Math.max(0, Date.now() - startTime);

      if (code !== 0) {
        logger.info(`[${corrId}] claude_request failed in ${durationMs}ms`);
        return createErrorResponse("claude", code, stderr, corrId);
      }
      wasSuccessful = true;

      let finalStdout = stdout;
      if (optimizeResponse) {
        const optimizedResponse = optimizeResponseText(finalStdout);
        logOptimizationTokens("response", corrId, finalStdout, optimizedResponse);
        finalStdout = optimizedResponse;
      }

      // If we used a session ID and it's not tracked yet, create a session record
      if (effectiveSessionId) {
        const existingSession = await sessionManager.getSession(effectiveSessionId);
        if (!existingSession) {
          await sessionManager.createSession("claude", "Claude Session", effectiveSessionId);
        }
      }

      logger.info(`[${corrId}] claude_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      // Include session info in response if using a session
      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }
      if (approvalDecision) {
        (response as any).approval = approvalDecision;
      }
      (response as any).mcpServers = {
        requested: requestedMcpServers,
        enabled: mcpConfig.enabled,
        missing: mcpConfig.missing
      };

      return response;
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      logger.info(`[${corrId}] claude_request threw exception after ${elapsedMs}ms`);
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
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Codex"),
    model: z.string().optional().describe("Model name or alias (e.g. gpt-5.2-codex, latest)"),
    fullAuto: z.boolean().default(false).describe("Full-auto mode (sandboxed execution)"),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().default(false).describe("Run Codex without approvals/sandbox"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("mcp_managed").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry", "exa", "ref_tools"]).describe("MCP servers expected for Codex"),
    sessionId: z.string().optional().describe("Session ID (Codex manages internally)"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, fullAuto, dangerouslyBypassApprovalsAndSandbox, approvalStrategy, approvalPolicy, mcpServers, sessionId, createNewSession, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    const cliInfo = getCliInfo();
    const resolvedModel = resolveModelAlias("codex", model, cliInfo);
    logger.info(`[${corrId}] codex_request invoked with model=${resolvedModel || "default"}, fullAuto=${fullAuto}, prompt length=${prompt.length}, sessionId=${sessionId}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    const requestedMcpServers = normalizeMcpServers(mcpServers as ClaudeMcpServerName[]);
    let approvalDecision: ReturnType<ApprovalManager["decide"]> | null = null;
    if (approvalStrategy === "mcp_managed") {
      approvalDecision = approvalManager.decide({
        cli: "codex",
        operation: "codex_request",
        prompt: effectivePrompt,
        bypassRequested: dangerouslyBypassApprovalsAndSandbox,
        fullAuto,
        requestedMcpServers: requestedMcpServers,
        policy: approvalPolicy as ApprovalPolicy | undefined,
        metadata: {
          model: resolvedModel || "default"
        }
      });
      if (approvalDecision.status !== "approved") {
        return createApprovalDeniedResponse("codex_request", approvalDecision);
      }
    }

    try {
      const args = ["exec"];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (fullAuto) args.push("--full-auto");
      if (dangerouslyBypassApprovalsAndSandbox) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
      args.push("--skip-git-repo-check", effectivePrompt);

      const { stdout, stderr, code } = await executeCli("codex", args);
      durationMs = Math.max(0, Date.now() - startTime);

      if (code !== 0) {
        logger.info(`[${corrId}] codex_request failed in ${durationMs}ms`);
        return createErrorResponse("codex", code, stderr, corrId);
      }
      wasSuccessful = true;

      let finalStdout = stdout;
      if (optimizeResponse) {
        const optimizedResponse = optimizeResponseText(finalStdout);
        logOptimizationTokens("response", corrId, finalStdout, optimizedResponse);
        finalStdout = optimizedResponse;
      }

      // Track session usage
      let effectiveSessionId = sessionId;
      if (!createNewSession && !sessionId) {
        const activeSession = await sessionManager.getActiveSession("codex");
        if (activeSession) {
          effectiveSessionId = activeSession.id;
        } else {
          // Create a new session for tracking
          const newSession = await sessionManager.createSession("codex", "Codex Session");
          effectiveSessionId = newSession.id;
        }
      } else if (sessionId) {
        await sessionManager.updateSessionUsage(sessionId);
      } else if (createNewSession) {
        const newSession = await sessionManager.createSession("codex", "Codex Session");
        effectiveSessionId = newSession.id;
      }

      logger.info(`[${corrId}] codex_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }
      if (approvalDecision) {
        (response as any).approval = approvalDecision;
      }
      (response as any).mcpServers = {
        requested: requestedMcpServers
      };

      return response;
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      logger.info(`[${corrId}] codex_request threw exception after ${elapsedMs}ms`);
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
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Gemini"),
    model: z.string().optional().describe("Model name or alias (e.g. gemini-3-pro-preview, gemini-2.5-flash, pro, flash, latest)"),
    sessionId: z.string().optional().describe("Session ID or 'latest'"),
    resumeLatest: z.boolean().default(false).describe("Resume latest session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    approvalMode: z.enum(["default", "auto_edit", "yolo"]).optional().describe("Approval: default|auto_edit|yolo"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("mcp_managed").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry", "exa", "ref_tools"]).describe("Allowed MCP server names"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools (['Write','Edit','Bash'])"),
    includeDirs: z.array(z.string()).optional().describe("Additional workspace directories"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, approvalStrategy, approvalPolicy, mcpServers, allowedTools, includeDirs, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    const cliInfo = getCliInfo();
    const resolvedModel = resolveModelAlias("gemini", model, cliInfo);
    logger.info(`[${corrId}] gemini_request invoked with model=${resolvedModel || "default"}, approvalMode=${approvalMode}, prompt length=${prompt.length}, sessionId=${sessionId}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    const requestedMcpServers = normalizeMcpServers(mcpServers as ClaudeMcpServerName[]);
    let approvalDecision: ReturnType<ApprovalManager["decide"]> | null = null;
    if (approvalStrategy === "mcp_managed") {
      approvalDecision = approvalManager.decide({
        cli: "gemini",
        operation: "gemini_request",
        prompt: effectivePrompt,
        bypassRequested: approvalMode === "yolo",
        fullAuto: false,
        requestedMcpServers: requestedMcpServers,
        allowedTools,
        policy: approvalPolicy as ApprovalPolicy | undefined,
        metadata: {
          model: resolvedModel || "default"
        }
      });
      if (approvalDecision.status !== "approved") {
        return createApprovalDeniedResponse("gemini_request", approvalDecision);
      }
    }

    try {
      const args = [effectivePrompt];
      if (resolvedModel) args.push("--model", resolvedModel);

      // Tool approval settings
      const effectiveApprovalMode = approvalStrategy === "mcp_managed" ? "yolo" : approvalMode;
      if (effectiveApprovalMode) args.push("--approval-mode", effectiveApprovalMode);
      if (allowedTools && allowedTools.length > 0) {
        allowedTools.forEach(tool => args.push("--allowed-tools", tool));
      }
      if (requestedMcpServers.length > 0) {
        requestedMcpServers.forEach(serverName => args.push("--allowed-mcp-server-names", serverName));
      }
      if (includeDirs && includeDirs.length > 0) {
        includeDirs.forEach(dir => args.push("--include-directories", dir));
      }

      // Session management (only resume when explicitly requested)
      let effectiveSessionId = sessionId;
      if (!createNewSession) {
        if (resumeLatest && !sessionId) {
          args.push("--resume", "latest");
        } else if (effectiveSessionId) {
          args.push("--resume", effectiveSessionId);
          await sessionManager.updateSessionUsage(effectiveSessionId);
        }
      }

      const { stdout, stderr, code } = await executeCli("gemini", args);
      durationMs = Math.max(0, Date.now() - startTime);

      if (code !== 0) {
        logger.info(`[${corrId}] gemini_request failed in ${durationMs}ms`);
        return createErrorResponse("gemini", code, stderr, corrId);
      }
      wasSuccessful = true;

      let finalStdout = stdout;
      if (optimizeResponse) {
        const optimizedResponse = optimizeResponseText(finalStdout);
        logOptimizationTokens("response", corrId, finalStdout, optimizedResponse);
        finalStdout = optimizedResponse;
      }

      // Track session
      if (!effectiveSessionId && !createNewSession) {
        const newSession = await sessionManager.createSession("gemini", "Gemini Session");
        effectiveSessionId = newSession.id;
      } else if (effectiveSessionId) {
        const existingSession = await sessionManager.getSession(effectiveSessionId);
        if (!existingSession) {
          await sessionManager.createSession("gemini", "Gemini Session", effectiveSessionId);
        }
      }

      logger.info(`[${corrId}] gemini_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }
      if (approvalDecision) {
        (response as any).approval = approvalDecision;
      }
      (response as any).mcpServers = {
        requested: requestedMcpServers
      };

      return response;
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startTime);
      logger.info(`[${corrId}] gemini_request threw exception after ${elapsedMs}ms`);
      return createErrorResponse("gemini", 1, "", corrId, error as Error);
    } finally {
      const finalizedDurationMs = Math.max(0, durationMs || Date.now() - startTime);
      performanceMetrics.recordRequest("gemini", finalizedDurationMs, wasSuccessful);
    }
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Async Long-Running Job Tools (No Time-Bound LLM Execution)
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "claude_request_async",
  {
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Claude"),
    model: z.string().optional().describe("Model name or alias (e.g. sonnet, claude-sonnet-4-5-20250929, latest)"),
    outputFormat: z.enum(["text", "json"]).default("text").describe("Output format (text|json)"),
    sessionId: z.string().optional().describe("Session ID (uses active if omitted)"),
    continueSession: z.boolean().default(false).describe("Continue active session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools (['Bash(git:*)','Edit','Write'])"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed tools"),
    dangerouslySkipPermissions: z.boolean().default(false).describe("Bypass permissions (sandbox only)"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("mcp_managed").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry", "exa", "ref_tools"]).describe("MCP servers exposed to Claude"),
    strictMcpConfig: z.boolean().default(true).describe("Restrict Claude to provided MCP config only"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution")
  },
  async ({ prompt, model, outputFormat, sessionId, continueSession, createNewSession, allowedTools, disallowedTools, dangerouslySkipPermissions, approvalStrategy, approvalPolicy, mcpServers, strictMcpConfig, correlationId, optimizePrompt }) => {
    const corrId = correlationId || randomUUID();
    let effectivePrompt = prompt;
    const cliInfo = getCliInfo();
    const resolvedModel = resolveModelAlias("claude", model, cliInfo);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    const requestedMcpServers = normalizeMcpServers(mcpServers as ClaudeMcpServerName[]);
    const mcpConfigResolution = resolveClaudeMcpConfig("claude_request_async", corrId, requestedMcpServers, strictMcpConfig);
    if ("errorResponse" in mcpConfigResolution) {
      return mcpConfigResolution.errorResponse;
    }
    const mcpConfig = mcpConfigResolution.config;
    let approvalDecision: ReturnType<ApprovalManager["decide"]> | null = null;
    if (approvalStrategy === "mcp_managed") {
      approvalDecision = approvalManager.decide({
        cli: "claude",
        operation: "claude_request_async",
        prompt: effectivePrompt,
        bypassRequested: dangerouslySkipPermissions,
        fullAuto: false,
        requestedMcpServers,
        allowedTools,
        disallowedTools,
        policy: approvalPolicy as ApprovalPolicy | undefined,
        metadata: {
          model: resolvedModel || "default",
          strictMcpConfig
        }
      });
      if (approvalDecision.status !== "approved") {
        return createApprovalDeniedResponse("claude_request_async", approvalDecision);
      }
    }

    try {
      const args = ["-p", effectivePrompt];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (outputFormat === "json") args.push("--output-format", "json");

      if (allowedTools && allowedTools.length > 0) {
        args.push("--allowed-tools", ...allowedTools);
      }
      if (disallowedTools && disallowedTools.length > 0) {
        args.push("--disallowed-tools", ...disallowedTools);
      }
      if (approvalStrategy === "mcp_managed") {
        args.push("--permission-mode", "bypassPermissions");
      } else if (dangerouslySkipPermissions) {
        args.push("--permission-mode", "bypassPermissions");
      }
      if (strictMcpConfig || mcpConfig.enabled.length > 0) {
        args.push("--mcp-config", mcpConfig.path);
        if (strictMcpConfig) {
          args.push("--strict-mcp-config");
        }
      }

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

      const job = asyncJobManager.startJob("claude", args, corrId);
      logger.info(`[${corrId}] claude_request_async started job ${job.id}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            job,
            sessionId: effectiveSessionId || activeSession?.id || null,
            approval: approvalDecision,
            mcpServers: {
              requested: requestedMcpServers,
              enabled: mcpConfig.enabled,
              missing: mcpConfig.missing
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("claude_request_async", 1, "", corrId, error as Error);
    }
  }
);

server.tool(
  "codex_request_async",
  {
    prompt: z.string().min(1, "Prompt cannot be empty").max(100000, "Prompt too long (max 100k chars)").describe("Prompt text for Codex"),
    model: z.string().optional().describe("Model name or alias (e.g. gpt-5.2-codex, latest)"),
    fullAuto: z.boolean().default(false).describe("Full-auto mode (sandboxed execution)"),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().default(false).describe("Run Codex without approvals/sandbox"),
    approvalStrategy: z.enum(["legacy", "mcp_managed"]).default("mcp_managed").describe("Approval strategy"),
    approvalPolicy: z.enum(["strict", "balanced", "permissive"]).optional().describe("Approval policy override"),
    mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry", "exa", "ref_tools"]).describe("MCP servers expected for Codex"),
    sessionId: z.string().optional().describe("Session ID (Codex manages internally)"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution")
  },
  async ({ prompt, model, fullAuto, dangerouslyBypassApprovalsAndSandbox, approvalStrategy, approvalPolicy, mcpServers, sessionId, createNewSession, correlationId, optimizePrompt }) => {
    const corrId = correlationId || randomUUID();
    let effectivePrompt = prompt;
    const cliInfo = getCliInfo();
    const resolvedModel = resolveModelAlias("codex", model, cliInfo);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    const requestedMcpServers = normalizeMcpServers(mcpServers as ClaudeMcpServerName[]);
    let approvalDecision: ReturnType<ApprovalManager["decide"]> | null = null;
    if (approvalStrategy === "mcp_managed") {
      approvalDecision = approvalManager.decide({
        cli: "codex",
        operation: "codex_request_async",
        prompt: effectivePrompt,
        bypassRequested: dangerouslyBypassApprovalsAndSandbox,
        fullAuto,
        requestedMcpServers,
        policy: approvalPolicy as ApprovalPolicy | undefined,
        metadata: {
          model: resolvedModel || "default"
        }
      });
      if (approvalDecision.status !== "approved") {
        return createApprovalDeniedResponse("codex_request_async", approvalDecision);
      }
    }

    try {
      const args = ["exec"];
      if (resolvedModel) args.push("--model", resolvedModel);
      if (fullAuto) args.push("--full-auto");
      if (dangerouslyBypassApprovalsAndSandbox) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
      args.push("--skip-git-repo-check", effectivePrompt);

      const job = asyncJobManager.startJob("codex", args, corrId);

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

      logger.info(`[${corrId}] codex_request_async started job ${job.id}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            job,
            sessionId: effectiveSessionId || null,
            approval: approvalDecision,
            mcpServers: {
              requested: requestedMcpServers
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("codex_request_async", 1, "", corrId, error as Error);
    }
  }
);

server.tool(
  "llm_job_status",
  {
    jobId: z.string().describe("Async job ID from *_request_async")
  },
  async ({ jobId }) => {
    const job = asyncJobManager.getJobSnapshot(jobId);
    if (!job) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Job not found",
            jobId
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          job
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "llm_job_result",
  {
    jobId: z.string().describe("Async job ID from *_request_async"),
    maxChars: z.number().int().min(1000).max(2000000).default(200000).describe("Max chars returned per stream")
  },
  async ({ jobId, maxChars }) => {
    const result = asyncJobManager.getJobResult(jobId, maxChars);
    if (!result) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Job not found",
            jobId
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          result
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "llm_job_cancel",
  {
    jobId: z.string().describe("Async job ID from *_request_async")
  },
  async ({ jobId }) => {
    const cancel = asyncJobManager.cancelJob(jobId);
    if (!cancel.canceled) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            jobId,
            reason: cancel.reason || "Unable to cancel"
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          jobId
        }, null, 2)
      }]
    };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Approval Audit Tools
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "approval_list",
  {
    limit: z.number().int().min(1).max(500).default(50).describe("Max number of approval records"),
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("Optional CLI filter")
  },
  async ({ limit, cli }) => {
    const approvals = approvalManager.list(limit, cli);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          count: approvals.length,
          approvals
        }, null, 2)
      }]
    };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// List Models Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "list_models",
  {
    cli: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.enum(["claude", "codex", "gemini"]).optional()
    ).describe("CLI filter (claude|codex|gemini)")
  },
  async ({ cli }) => {
    const cliInfo = getCliInfo();
    const result = cli ? { [cli]: cliInfo[cli] } : cliInfo;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
    setAsActive: z.boolean().default(true).describe("Set as active session")
  },
  async ({ cli, description, setAsActive }) => {
    try {
      const session = await sessionManager.createSession(cli, description);

      if (setAsActive) {
        await sessionManager.setActiveSession(cli, session.id);
      }

      logger.info(`Created new ${cli} session: ${session.id}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            session: {
              id: session.id,
              cli: session.cli,
              description: session.description,
              createdAt: session.createdAt,
              isActive: setAsActive
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("session_create", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_list",
  {
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("CLI filter (claude|codex|gemini)")
  },
  async ({ cli }) => {
    try {
      const sessions = await sessionManager.listSessions(cli);
      const activeSessions = {
        claude: await sessionManager.getActiveSession("claude"),
        codex: await sessionManager.getActiveSession("codex"),
        gemini: await sessionManager.getActiveSession("gemini")
      };

      const sessionList = sessions.map(s => ({
        id: s.id,
        cli: s.cli,
        description: s.description,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        isActive: activeSessions[s.cli]?.id === s.id
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: sessionList.length,
            sessions: sessionList,
            activeSessions: {
              claude: activeSessions.claude?.id || null,
              codex: activeSessions.codex?.id || null,
              gemini: activeSessions.gemini?.id || null
            }
          }, null, 2)
        }]
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
    sessionId: z.string().nullable().describe("Session ID (null to clear)")
  },
  async ({ cli, sessionId }) => {
    try {
      const success = await sessionManager.setActiveSession(cli, sessionId || null);

      if (!success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Session not found or does not belong to the specified CLI"
            }, null, 2)
          }],
          isError: true
        };
      }

      logger.info(`Set active ${cli} session to: ${sessionId}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            cli,
            activeSessionId: sessionId
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("session_set_active", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_delete",
  {
    sessionId: z.string().describe("Session ID")
  },
  async ({ sessionId }) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Session not found"
            }, null, 2)
          }],
          isError: true
        };
      }

      const success = await sessionManager.deleteSession(sessionId);
      logger.info(`Deleted session: ${sessionId}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success,
            deletedSession: {
              id: session.id,
              cli: session.cli,
              description: session.description
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("session_delete", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_get",
  {
    sessionId: z.string().describe("Session ID")
  },
  async ({ sessionId }) => {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Session not found"
            }, null, 2)
          }],
          isError: true
        };
      }

      const activeSession = await sessionManager.getActiveSession(session.cli);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            session: {
              ...session,
              isActive: activeSession?.id === session.id
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return createErrorResponse("session_get", 1, "", undefined, error as Error);
    }
  }
);

server.tool(
  "session_clear_all",
  {
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("CLI filter (claude|codex|gemini)")
  },
  async ({ cli }) => {
    try {
      const count = await sessionManager.clearAllSessions(cli);
      logger.info(`Cleared ${count} sessions${cli ? ` for ${cli}` : ''}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            deletedCount: count,
            cli: cli || "all"
          }, null, 2)
        }]
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

  if (config?.database && config?.redis) {
    logger.info("Initializing PostgreSQL + Redis session manager");
    const { createDatabaseConnection } = await import("./db.js");
    db = await createDatabaseConnection(config);
    // Pass existing db and logger to avoid creating duplicate connections
    sessionManager = await createSessionManager(config, db, logger);
    logger.info("PostgreSQL session manager initialized");
  } else {
    logger.info("Initializing file-based session manager");
    sessionManager = await createSessionManager(undefined, undefined, logger);
    logger.info("File-based session manager initialized");
  }

  resourceProvider = new ResourceProvider(sessionManager as any, performanceMetrics);
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
        description: "Database connectivity status and latency metrics",
        mimeType: "application/json"
      },
      async () => {
        const health = await checkHealth(db!);
        return {
          contents: [{
            uri: "health://status",
            text: JSON.stringify(health, null, 2),
            mimeType: "application/json"
          }]
        };
      }
    );
    logger.info("Health check resource registered");
  }
}

//──────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
//──────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await server.close();
    logger.info("MCP server closed");

    if (db) {
      await db.disconnect();
      logger.info("Database connections closed");
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

main().catch((error) => {
  logger.error("Fatal server error:", error);
  console.error("Server error:", error);
  process.exit(1);
});
