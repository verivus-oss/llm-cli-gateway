#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { executeCli } from "./executor.js";
import { SessionManager } from "./session-manager.js";
import { ResourceProvider } from "./resources.js";
import { PerformanceMetrics } from "./metrics.js";
import { estimateTokens, optimizePrompt as optimizePromptText, optimizeResponse as optimizeResponseText } from "./optimizer.js";

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

// Initialize session manager and resource provider
const sessionManager = new SessionManager();
const performanceMetrics = new PerformanceMetrics();
const resourceProvider = new ResourceProvider(sessionManager, performanceMetrics);

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

// Available models per CLI with descriptions
const CLI_INFO = {
  claude: {
    description: "Anthropic's Claude Code CLI - best for code generation, analysis, and agentic coding tasks",
    models: {
      opus: "Most capable model. Best for: complex reasoning, nuanced analysis, difficult problems, research",
      sonnet: "Balanced performance. Best for: everyday coding, code review, general tasks (default)",
      haiku: "Fastest model. Best for: simple queries, quick answers, high-volume tasks, cost-sensitive use"
    }
  },
  codex: {
    description: "OpenAI's Codex CLI - best for code execution in sandboxed environments",
    models: {
      "o3": "Most capable reasoning model. Best for: complex multi-step problems, math, science",
      "o4-mini": "Fast reasoning model. Best for: coding tasks, quick iterations",
      "gpt-4.1": "Latest GPT-4 variant. Best for: general coding, instruction following"
    }
  },
  gemini: {
    description: "Google's Gemini CLI - best for multimodal tasks and Google ecosystem integration",
    models: {
      "gemini-2.5-pro": "Most capable model. Best for: complex reasoning, long context, multimodal",
      "gemini-2.5-flash": "Fast model. Best for: quick responses, high throughput, cost-sensitive use"
    }
  }
} as const;

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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    const contents = resourceProvider.readResource(uri.href);
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
    model: z.enum(["opus", "sonnet", "haiku"]).optional().describe("Model (opus|sonnet|haiku)"),
    outputFormat: z.enum(["text", "json"]).default("text").describe("Output format (text|json)"),
    sessionId: z.string().optional().describe("Session ID (uses active if omitted)"),
    continueSession: z.boolean().default(false).describe("Continue active session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools (['Bash(git:*)','Edit','Write'])"),
    disallowedTools: z.array(z.string()).optional().describe("Disallowed tools"),
    dangerouslySkipPermissions: z.boolean().default(false).describe("Bypass permissions (sandbox only)"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, outputFormat, sessionId, continueSession, createNewSession, allowedTools, disallowedTools, dangerouslySkipPermissions, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    logger.info(`[${corrId}] claude_request invoked with model=${model || 'default'}, prompt length=${prompt.length}, sessionId=${sessionId}, dangerouslySkipPermissions=${dangerouslySkipPermissions}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    try {
      const args = ["-p", effectivePrompt];
      if (model) args.push("--model", model);
      if (outputFormat === "json") args.push("--output-format", "json");

      // Tool permissions
      if (allowedTools && allowedTools.length > 0) {
        args.push("--allowed-tools", ...allowedTools);
      }
      if (disallowedTools && disallowedTools.length > 0) {
        args.push("--disallowed-tools", ...disallowedTools);
      }
      if (dangerouslySkipPermissions) {
        args.push("--permission-mode", "bypassPermissions");
      }

      // Session management
      let effectiveSessionId = sessionId;
      if (!createNewSession && !continueSession && !sessionId) {
        // Use active session if exists
        const activeSession = sessionManager.getActiveSession("claude");
        if (activeSession) {
          effectiveSessionId = activeSession.id;
        }
      }

      if (continueSession) {
        args.push("--continue");
      } else if (effectiveSessionId) {
        args.push("--session-id", effectiveSessionId);
        sessionManager.updateSessionUsage(effectiveSessionId);
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
      if (effectiveSessionId && !sessionManager.getSession(effectiveSessionId)) {
        sessionManager.createSession("claude", "Claude Session", effectiveSessionId);
      }

      logger.info(`[${corrId}] claude_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      // Include session info in response if using a session
      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }

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
    model: z.enum(["o3", "o4-mini", "gpt-4.1"]).optional().describe("Model (o3|o4-mini|gpt-4.1)"),
    fullAuto: z.boolean().default(false).describe("Full-auto mode (sandboxed execution)"),
    sessionId: z.string().optional().describe("Session ID (Codex manages internally)"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, fullAuto, sessionId, createNewSession, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    logger.info(`[${corrId}] codex_request invoked with model=${model || 'default'}, fullAuto=${fullAuto}, prompt length=${prompt.length}, sessionId=${sessionId}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    try {
      const args = ["exec"];
      if (model) args.push("--model", model);
      if (fullAuto) args.push("--full-auto");
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
        const activeSession = sessionManager.getActiveSession("codex");
        if (activeSession) {
          effectiveSessionId = activeSession.id;
        } else {
          // Create a new session for tracking
          const newSession = sessionManager.createSession("codex", "Codex Session");
          effectiveSessionId = newSession.id;
        }
      } else if (sessionId) {
        sessionManager.updateSessionUsage(sessionId);
      } else if (createNewSession) {
        const newSession = sessionManager.createSession("codex", "Codex Session");
        effectiveSessionId = newSession.id;
      }

      logger.info(`[${corrId}] codex_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }

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
    model: z.enum(["gemini-2.5-pro", "gemini-2.5-flash"]).optional().describe("Model (pro|flash)"),
    sessionId: z.string().optional().describe("Session ID or 'latest'"),
    resumeLatest: z.boolean().default(false).describe("Resume latest session"),
    createNewSession: z.boolean().default(false).describe("Force new session"),
    approvalMode: z.enum(["default", "auto_edit", "yolo"]).optional().describe("Approval: default|auto_edit|yolo"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools (['Write','Edit','Bash'])"),
    includeDirs: z.array(z.string()).optional().describe("Additional workspace directories"),
    correlationId: z.string().optional().describe("Request trace ID (auto if omitted)"),
    optimizePrompt: z.boolean().default(false).describe("Optimize prompt before execution"),
    optimizeResponse: z.boolean().default(false).describe("Optimize response output")
  },
  async ({ prompt, model, sessionId, resumeLatest, createNewSession, approvalMode, allowedTools, includeDirs, correlationId, optimizePrompt, optimizeResponse }) => {
    const startTime = Date.now();
    const corrId = correlationId || randomUUID();
    let durationMs = 0;
    let wasSuccessful = false;
    let effectivePrompt = prompt;
    logger.info(`[${corrId}] gemini_request invoked with model=${model || 'default'}, approvalMode=${approvalMode}, prompt length=${prompt.length}, sessionId=${sessionId}`);

    if (optimizePrompt) {
      const optimizedPrompt = optimizePromptText(effectivePrompt);
      logOptimizationTokens("prompt", corrId, effectivePrompt, optimizedPrompt);
      effectivePrompt = optimizedPrompt;
    }

    try {
      const args = [effectivePrompt];
      if (model) args.push("--model", model);

      // Tool approval settings
      if (approvalMode) args.push("--approval-mode", approvalMode);
      if (allowedTools && allowedTools.length > 0) {
        allowedTools.forEach(tool => args.push("--allowed-tools", tool));
      }
      if (includeDirs && includeDirs.length > 0) {
        includeDirs.forEach(dir => args.push("--include-directories", dir));
      }

      // Session management
      let effectiveSessionId = sessionId;
      if (!createNewSession && !sessionId && !resumeLatest) {
        const activeSession = sessionManager.getActiveSession("gemini");
        if (activeSession) {
          effectiveSessionId = activeSession.id;
          resumeLatest = true;
        }
      }

      if (resumeLatest && !sessionId) {
        args.push("--resume", "latest");
      } else if (effectiveSessionId) {
        args.push("--resume", effectiveSessionId);
        sessionManager.updateSessionUsage(effectiveSessionId);
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
        const newSession = sessionManager.createSession("gemini", "Gemini Session");
        effectiveSessionId = newSession.id;
      } else if (effectiveSessionId && !sessionManager.getSession(effectiveSessionId)) {
        sessionManager.createSession("gemini", "Gemini Session", effectiveSessionId);
      }

      logger.info(`[${corrId}] gemini_request completed successfully in ${durationMs}ms, response length=${finalStdout.length}`);
      const response = { content: [{ type: "text" as const, text: finalStdout }] };

      if (effectiveSessionId) {
        (response as any).sessionId = effectiveSessionId;
      }

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
// List Models Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "list_models",
  {
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("CLI filter (claude|codex|gemini)")
  },
  async ({ cli }) => {
    const result = cli ? { [cli]: CLI_INFO[cli] } : CLI_INFO;
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
      const session = sessionManager.createSession(cli, description);

      if (setAsActive) {
        sessionManager.setActiveSession(cli, session.id);
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
      const sessions = sessionManager.listSessions(cli);
      const activeSessions = {
        claude: sessionManager.getActiveSession("claude"),
        codex: sessionManager.getActiveSession("codex"),
        gemini: sessionManager.getActiveSession("gemini")
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
      const success = sessionManager.setActiveSession(cli, sessionId || null);

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
      const session = sessionManager.getSession(sessionId);
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

      const success = sessionManager.deleteSession(sessionId);
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
      const session = sessionManager.getSession(sessionId);

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

      const activeSession = sessionManager.getActiveSession(session.cli);

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
      const count = sessionManager.clearAllSessions(cli);
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
// Server Startup
//──────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("Starting llm-cli-gateway MCP server");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("llm-cli-gateway MCP server connected and ready");
}

main().catch((error) => {
  logger.error("Fatal server error:", error);
  console.error("Server error:", error);
  process.exit(1);
});
