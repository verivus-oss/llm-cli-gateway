#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeClaudeRequest } from "./tools/claude.js";
import { executeCodexRequest } from "./tools/codex.js";
import { executeGeminiRequest } from "./tools/gemini.js";

const server = new McpServer({
  name: "llm-cli-gateway",
  version: "1.0.0"
});

// Claude Code tool
server.tool(
  "claude_request",
  {
    prompt: z.string().describe("The prompt to send to Claude Code"),
    model: z.enum(["opus", "sonnet", "haiku"]).optional().describe("Model to use"),
    outputFormat: z.enum(["text", "json"]).default("text").describe("Output format")
  },
  async ({ prompt, model, outputFormat }) => {
    try {
      const result = await executeClaudeRequest(prompt, { model, outputFormat });
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// Codex tool
server.tool(
  "codex_request",
  {
    prompt: z.string().describe("The prompt to send to Codex"),
    model: z.string().optional().describe("Model to use"),
    fullAuto: z.boolean().default(false).describe("Enable full-auto mode for sandboxed automatic execution")
  },
  async ({ prompt, model, fullAuto }) => {
    try {
      const result = await executeCodexRequest(prompt, { model, fullAuto });
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// Gemini tool
server.tool(
  "gemini_request",
  {
    prompt: z.string().describe("The prompt to send to Gemini CLI"),
    model: z.string().optional().describe("Model to use")
  },
  async ({ prompt, model }) => {
    try {
      const result = await executeGeminiRequest(prompt, { model });
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);

// List models tool
server.tool(
  "list_models",
  {
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("Specific CLI to list models for")
  },
  async ({ cli }) => {
    const models: Record<string, string[]> = {
      claude: ["opus", "sonnet", "haiku"],
      codex: ["o4-mini", "o3", "gpt-4.1"],
      gemini: ["gemini-2.5-pro", "gemini-2.5-flash"]
    };

    if (cli) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ [cli]: models[cli] }, null, 2)
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(models, null, 2)
      }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
