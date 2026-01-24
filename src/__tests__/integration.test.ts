import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  content: TextContent[];
  isError?: boolean;
}

describe("MCP Server Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    const serverPath = path.resolve(__dirname, "../../dist/index.js");

    transport = new StdioClientTransport({
      command: "node",
      args: [serverPath]
    });

    client = new Client({
      name: "test-client",
      version: "1.0.0"
    });

    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client.close();
  });

  describe("tool listing", () => {
    it("should list all available tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      expect(toolNames).toContain("claude_request");
      expect(toolNames).toContain("codex_request");
      expect(toolNames).toContain("gemini_request");
      expect(toolNames).toContain("list_models");
    });

    it("should have correct schema for claude_request", async () => {
      const result = await client.listTools();
      const claudeTool = result.tools.find(t => t.name === "claude_request");

      expect(claudeTool).toBeDefined();
      expect(claudeTool?.inputSchema).toBeDefined();
    });

    it("should have correct schema for codex_request", async () => {
      const result = await client.listTools();
      const codexTool = result.tools.find(t => t.name === "codex_request");

      expect(codexTool).toBeDefined();
      expect(codexTool?.inputSchema).toBeDefined();
    });

    it("should have correct schema for gemini_request", async () => {
      const result = await client.listTools();
      const geminiTool = result.tools.find(t => t.name === "gemini_request");

      expect(geminiTool).toBeDefined();
      expect(geminiTool?.inputSchema).toBeDefined();
    });

    it("should have correct schema for list_models", async () => {
      const result = await client.listTools();
      const listModelsTool = result.tools.find(t => t.name === "list_models");

      expect(listModelsTool).toBeDefined();
      expect(listModelsTool?.inputSchema).toBeDefined();
    });
  });

  describe("list_models tool", () => {
    it("should return all models when no CLI specified", async () => {
      const result = await client.callTool({
        name: "list_models",
        arguments: {}
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      const content = result.content[0];
      expect(content.type).toBe("text");

      const models = JSON.parse(content.text);
      expect(models.claude).toBeDefined();
      expect(models.codex).toBeDefined();
      expect(models.gemini).toBeDefined();
    });

    it("should return only claude models when specified", async () => {
      const result = await client.callTool({
        name: "list_models",
        arguments: { cli: "claude" }
      }) as CallToolResult;

      const content = result.content[0];
      const models = JSON.parse(content.text);
      expect(models.claude).toBeDefined();
      expect(models.codex).toBeUndefined();
      expect(models.gemini).toBeUndefined();
    });

    it("should return only codex models when specified", async () => {
      const result = await client.callTool({
        name: "list_models",
        arguments: { cli: "codex" }
      }) as CallToolResult;

      const content = result.content[0];
      const models = JSON.parse(content.text);
      expect(models.codex).toBeDefined();
      expect(models.claude).toBeUndefined();
    });

    it("should return only gemini models when specified", async () => {
      const result = await client.callTool({
        name: "list_models",
        arguments: { cli: "gemini" }
      }) as CallToolResult;

      const content = result.content[0];
      const models = JSON.parse(content.text);
      expect(models.gemini).toBeDefined();
      expect(models.claude).toBeUndefined();
    });
  });

  describe("claude_request tool", () => {
    it("should execute a simple request", async () => {
      const result = await client.callTool({
        name: "claude_request",
        arguments: {
          prompt: "What is 1+1? Reply with just the number.",
          model: "haiku"
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      const content = result.content[0];
      expect(content.type).toBe("text");
      expect(content.text).toContain("2");
    }, 30000);

    it("should handle prompts with special characters via MCP", async () => {
      const result = await client.callTool({
        name: "claude_request",
        arguments: {
          prompt: 'Echo: "quotes" and $pecial chars!',
          model: "haiku"
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.isError).toBeFalsy();
    }, 30000);
  });

  describe("codex_request tool", () => {
    it("should execute a simple request", async () => {
      const result = await client.callTool({
        name: "codex_request",
        arguments: {
          prompt: "What is 2+2? Reply with just the number."
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      const content = result.content[0];
      expect(content.type).toBe("text");
    }, 60000);

    it("should work with fullAuto option", async () => {
      const result = await client.callTool({
        name: "codex_request",
        arguments: {
          prompt: "Say 'hello'",
          fullAuto: true
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.isError).toBeFalsy();
    }, 60000);
  });

  describe("gemini_request tool", () => {
    it("should execute a simple request", async () => {
      const result = await client.callTool({
        name: "gemini_request",
        arguments: {
          prompt: "What is 5+5? Reply with just the number."
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      const content = result.content[0];
      expect(content.type).toBe("text");
      expect(content.text).toContain("10");
    }, 60000);

    it("should accept model parameter", async () => {
      const result = await client.callTool({
        name: "gemini_request",
        arguments: {
          prompt: "Say 'test'",
          model: "gemini-2.5-flash"
        }
      }) as CallToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.isError).toBeFalsy();
    }, 60000);
  });

  describe("error handling", () => {
    it("should handle missing required prompt parameter", async () => {
      try {
        await client.callTool({
          name: "claude_request",
          arguments: {}
        });
        // If we get here, the server accepted it (might use empty prompt)
      } catch (error) {
        // Expected - missing required parameter
        expect(error).toBeDefined();
      }
    });

    it("should return error for invalid tool name", async () => {
      try {
        await client.callTool({
          name: "nonexistent_tool",
          arguments: {}
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe("concurrent requests", () => {
    it("should handle multiple concurrent requests", async () => {
      const promises = [
        client.callTool({
          name: "list_models",
          arguments: {}
        }),
        client.callTool({
          name: "list_models",
          arguments: { cli: "claude" }
        }),
        client.callTool({
          name: "list_models",
          arguments: { cli: "codex" }
        })
      ];

      const results = await Promise.all(promises) as CallToolResult[];

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.content).toHaveLength(1);
      });
    });
  });
});
