#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCli } from "./executor.js";

const server = new McpServer({
  name: "llm-cli-gateway",
  version: "1.0.0"
});

// Available models per CLI (used by list_models and for documentation)
const CLI_MODELS = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["o4-mini", "o3", "gpt-4.1"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"]
} as const;

//──────────────────────────────────────────────────────────────────────────────
// Claude Code Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "claude_request",
  {
    prompt: z.string().describe("The prompt to send to Claude Code"),
    model: z.enum(["opus", "sonnet", "haiku"]).optional().describe("Model to use"),
    outputFormat: z.enum(["text", "json"]).default("text").describe("Output format")
  },
  async ({ prompt, model, outputFormat }) => {
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    if (outputFormat === "json") args.push("--output-format", "json");

    const { stdout, stderr, code } = await executeCli("claude", args);

    if (code !== 0) {
      return { content: [{ type: "text", text: `Error: Claude failed (${code}): ${stderr}` }], isError: true };
    }
    return { content: [{ type: "text", text: stdout }] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Codex Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "codex_request",
  {
    prompt: z.string().describe("The prompt to send to Codex"),
    model: z.string().optional().describe("Model to use"),
    fullAuto: z.boolean().default(false).describe("Enable full-auto mode for sandboxed automatic execution")
  },
  async ({ prompt, model, fullAuto }) => {
    const args = ["exec"];
    if (model) args.push("--model", model);
    if (fullAuto) args.push("--full-auto");
    args.push("--skip-git-repo-check", prompt);

    const { stdout, stderr, code } = await executeCli("codex", args);

    if (code !== 0) {
      return { content: [{ type: "text", text: `Error: Codex failed (${code}): ${stderr}` }], isError: true };
    }
    return { content: [{ type: "text", text: stdout }] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Gemini Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "gemini_request",
  {
    prompt: z.string().describe("The prompt to send to Gemini CLI"),
    model: z.string().optional().describe("Model to use")
  },
  async ({ prompt, model }) => {
    const args = [prompt];
    if (model) args.push("--model", model);

    const { stdout, stderr, code } = await executeCli("gemini", args);

    if (code !== 0) {
      return { content: [{ type: "text", text: `Error: Gemini failed (${code}): ${stderr}` }], isError: true };
    }
    return { content: [{ type: "text", text: stdout }] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// List Models Tool
//──────────────────────────────────────────────────────────────────────────────

server.tool(
  "list_models",
  {
    cli: z.enum(["claude", "codex", "gemini"]).optional().describe("Specific CLI to list models for")
  },
  async ({ cli }) => {
    const result = cli ? { [cli]: CLI_MODELS[cli] } : CLI_MODELS;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Server Startup
//──────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
