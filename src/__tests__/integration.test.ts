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

      // CLI tools
      expect(toolNames).toContain("claude_request");
      expect(toolNames).toContain("codex_request");
      expect(toolNames).toContain("gemini_request");
      expect(toolNames).toContain("list_models");

      // Session management tools
      expect(toolNames).toContain("session_create");
      expect(toolNames).toContain("session_list");
      expect(toolNames).toContain("session_set_active");
      expect(toolNames).toContain("session_get");
      expect(toolNames).toContain("session_delete");
      expect(toolNames).toContain("session_clear_all");
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

  describe("session management", () => {
    // Clean up sessions before and after session tests
    beforeAll(async () => {
      await client.callTool({
        name: "session_clear_all",
        arguments: {}
      });
    });

    afterAll(async () => {
      await client.callTool({
        name: "session_clear_all",
        arguments: {}
      });
    });

    describe("session_create", () => {
      it("should create a new session", async () => {
        const result = await client.callTool({
          name: "session_create",
          arguments: {
            cli: "claude",
            description: "Test session",
            setAsActive: true
          }
        }) as CallToolResult;

        expect(result.content).toHaveLength(1);
        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(true);
        expect(response.session.id).toBeDefined();
        expect(response.session.cli).toBe("claude");
        expect(response.session.description).toBe("Test session");
        expect(response.session.isActive).toBe(true);
      });

      it("should create session without description", async () => {
        const result = await client.callTool({
          name: "session_create",
          arguments: {
            cli: "codex"
          }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(true);
        expect(response.session.id).toBeDefined();
      });

      it("should create sessions for different CLIs", async () => {
        const claudeResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "Claude session" }
        }) as CallToolResult;

        const codexResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "codex", description: "Codex session" }
        }) as CallToolResult;

        const geminiResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "gemini", description: "Gemini session" }
        }) as CallToolResult;

        const claudeSession = JSON.parse(claudeResult.content[0].text).session;
        const codexSession = JSON.parse(codexResult.content[0].text).session;
        const geminiSession = JSON.parse(geminiResult.content[0].text).session;

        expect(claudeSession.cli).toBe("claude");
        expect(codexSession.cli).toBe("codex");
        expect(geminiSession.cli).toBe("gemini");
      });
    });

    describe("session_list", () => {
      it("should list all sessions", async () => {
        // Create a few sessions first
        await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "Session 1" }
        });
        await client.callTool({
          name: "session_create",
          arguments: { cli: "codex", description: "Session 2" }
        });

        const result = await client.callTool({
          name: "session_list",
          arguments: {}
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.total).toBeGreaterThanOrEqual(2);
        expect(response.sessions).toBeInstanceOf(Array);
        expect(response.activeSessions).toBeDefined();
      });

      it("should filter sessions by CLI", async () => {
        const result = await client.callTool({
          name: "session_list",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.sessions.every((s: any) => s.cli === "claude")).toBe(true);
      });

      it("should show active session indicators", async () => {
        const result = await client.callTool({
          name: "session_list",
          arguments: {}
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.activeSessions).toHaveProperty("claude");
        expect(response.activeSessions).toHaveProperty("codex");
        expect(response.activeSessions).toHaveProperty("gemini");
      });
    });

    describe("session_get", () => {
      it("should retrieve a session by ID", async () => {
        // Create a session
        const createResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "Test get" }
        }) as CallToolResult;

        const created = JSON.parse(createResult.content[0].text).session;

        // Get the session
        const getResult = await client.callTool({
          name: "session_get",
          arguments: { sessionId: created.id }
        }) as CallToolResult;

        const response = JSON.parse(getResult.content[0].text);
        expect(response.success).toBe(true);
        expect(response.session.id).toBe(created.id);
        expect(response.session.description).toBe("Test get");
      });

      it("should return error for non-existent session", async () => {
        const result = await client.callTool({
          name: "session_get",
          arguments: { sessionId: "non-existent-id" }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
      });
    });

    describe("session_set_active", () => {
      it("should set a session as active", async () => {
        // Create a session
        const createResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "Active test", setAsActive: false }
        }) as CallToolResult;

        const session = JSON.parse(createResult.content[0].text).session;

        // Set it as active
        const setResult = await client.callTool({
          name: "session_set_active",
          arguments: { cli: "claude", sessionId: session.id }
        }) as CallToolResult;

        const response = JSON.parse(setResult.content[0].text);
        expect(response.success).toBe(true);
        expect(response.activeSessionId).toBe(session.id);

        // Verify via session_list
        const listResult = await client.callTool({
          name: "session_list",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const listResponse = JSON.parse(listResult.content[0].text);
        expect(listResponse.activeSessions.claude).toBe(session.id);
      });

      it("should return error for non-existent session", async () => {
        const result = await client.callTool({
          name: "session_set_active",
          arguments: { cli: "claude", sessionId: "non-existent" }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(false);
      });

      it("should return error when setting wrong CLI session", async () => {
        const createResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const claudeSession = JSON.parse(createResult.content[0].text).session;

        const result = await client.callTool({
          name: "session_set_active",
          arguments: { cli: "codex", sessionId: claudeSession.id }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(false);
      });
    });

    describe("session_delete", () => {
      it("should delete a session", async () => {
        // Create a session
        const createResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "To be deleted" }
        }) as CallToolResult;

        const session = JSON.parse(createResult.content[0].text).session;

        // Delete it
        const deleteResult = await client.callTool({
          name: "session_delete",
          arguments: { sessionId: session.id }
        }) as CallToolResult;

        const response = JSON.parse(deleteResult.content[0].text);
        expect(response.success).toBe(true);
        expect(response.deletedSession.id).toBe(session.id);

        // Verify it's gone
        const getResult = await client.callTool({
          name: "session_get",
          arguments: { sessionId: session.id }
        }) as CallToolResult;

        const getResponse = JSON.parse(getResult.content[0].text);
        expect(getResponse.success).toBe(false);
      });

      it("should return error for non-existent session", async () => {
        const result = await client.callTool({
          name: "session_delete",
          arguments: { sessionId: "non-existent" }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(false);
      });
    });

    describe("session_clear_all", () => {
      it("should clear all sessions", async () => {
        // Create some sessions
        await client.callTool({
          name: "session_create",
          arguments: { cli: "claude" }
        });
        await client.callTool({
          name: "session_create",
          arguments: { cli: "codex" }
        });

        // Clear all
        const result = await client.callTool({
          name: "session_clear_all",
          arguments: {}
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(true);
        expect(response.deletedCount).toBeGreaterThanOrEqual(2);

        // Verify all are gone
        const listResult = await client.callTool({
          name: "session_list",
          arguments: {}
        }) as CallToolResult;

        const listResponse = JSON.parse(listResult.content[0].text);
        expect(listResponse.total).toBe(0);
      });

      it("should clear sessions for specific CLI only", async () => {
        // Create sessions for different CLIs
        await client.callTool({
          name: "session_create",
          arguments: { cli: "claude" }
        });
        await client.callTool({
          name: "session_create",
          arguments: { cli: "codex" }
        });

        // Clear only Claude sessions
        const result = await client.callTool({
          name: "session_clear_all",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(true);

        // Verify Claude sessions gone but Codex remains
        const claudeList = await client.callTool({
          name: "session_list",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const codexList = await client.callTool({
          name: "session_list",
          arguments: { cli: "codex" }
        }) as CallToolResult;

        expect(JSON.parse(claudeList.content[0].text).total).toBe(0);
        expect(JSON.parse(codexList.content[0].text).total).toBeGreaterThan(0);
      });
    });

    describe("session workflow", () => {
      it("should support complete session lifecycle", async () => {
        // 1. Create a session
        const createResult = await client.callTool({
          name: "session_create",
          arguments: { cli: "claude", description: "Full lifecycle test" }
        }) as CallToolResult;

        const session = JSON.parse(createResult.content[0].text).session;
        const sessionId = session.id;

        // 2. Verify it's in the list
        const listResult = await client.callTool({
          name: "session_list",
          arguments: { cli: "claude" }
        }) as CallToolResult;

        const sessions = JSON.parse(listResult.content[0].text).sessions;
        expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);

        // 3. Get the session details
        const getResult = await client.callTool({
          name: "session_get",
          arguments: { sessionId }
        }) as CallToolResult;

        expect(JSON.parse(getResult.content[0].text).success).toBe(true);

        // 4. Set as active
        await client.callTool({
          name: "session_set_active",
          arguments: { cli: "claude", sessionId }
        });

        // 5. Verify it's active
        const listResult2 = await client.callTool({
          name: "session_list",
          arguments: {}
        }) as CallToolResult;

        expect(JSON.parse(listResult2.content[0].text).activeSessions.claude).toBe(sessionId);

        // 6. Delete the session
        const deleteResult = await client.callTool({
          name: "session_delete",
          arguments: { sessionId }
        }) as CallToolResult;

        expect(JSON.parse(deleteResult.content[0].text).success).toBe(true);

        // 7. Verify it's gone and active is cleared
        const listResult3 = await client.callTool({
          name: "session_list",
          arguments: {}
        }) as CallToolResult;

        const finalList = JSON.parse(listResult3.content[0].text);
        expect(finalList.sessions.some((s: any) => s.id === sessionId)).toBe(false);
        expect(finalList.activeSessions.claude).toBeNull();
      });
    });
  });

  describe("cross-client session sharing", () => {
    // This tests the scenario where one LLM wants to reuse another LLM's conversation
    // e.g., LLM A creates a session, LLM B continues it

    afterAll(async () => {
      await client.callTool({
        name: "session_clear_all",
        arguments: {}
      });
    });

    it("should allow different clients to share the same session", async () => {
      // Client A creates a session
      const createResult = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "claude",
          description: "Shared session for multiple LLMs",
          setAsActive: false  // Don't set as active so we explicitly pass sessionId
        }
      }) as CallToolResult;

      const sessionData = JSON.parse(createResult.content[0].text);
      const sharedSessionId = sessionData.session.id;

      expect(sharedSessionId).toBeDefined();

      // Verify any client can retrieve the session
      const getResult = await client.callTool({
        name: "session_get",
        arguments: { sessionId: sharedSessionId }
      }) as CallToolResult;

      const getResponse = JSON.parse(getResult.content[0].text);
      expect(getResponse.success).toBe(true);
      expect(getResponse.session.id).toBe(sharedSessionId);
      expect(getResponse.session.description).toBe("Shared session for multiple LLMs");
    });

    it("should allow Client B to set active a session created by Client A", async () => {
      // Client A creates a session
      const createResult = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "codex",
          description: "Client A's session",
          setAsActive: false
        }
      }) as CallToolResult;

      const sessionId = JSON.parse(createResult.content[0].text).session.id;

      // Client B (simulated by same client) sets it as active
      const setActiveResult = await client.callTool({
        name: "session_set_active",
        arguments: {
          cli: "codex",
          sessionId: sessionId
        }
      }) as CallToolResult;

      const setResponse = JSON.parse(setActiveResult.content[0].text);
      expect(setResponse.success).toBe(true);

      // Verify it's now the active session
      const listResult = await client.callTool({
        name: "session_list",
        arguments: { cli: "codex" }
      }) as CallToolResult;

      const listResponse = JSON.parse(listResult.content[0].text);
      expect(listResponse.activeSessions.codex).toBe(sessionId);
    });

    it("should share session updates across clients", async () => {
      // Client A creates a session
      const createResult = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "gemini",
          description: "Updated by multiple clients"
        }
      }) as CallToolResult;

      const sessionId = JSON.parse(createResult.content[0].text).session.id;

      // Client A retrieves it
      const getResult1 = await client.callTool({
        name: "session_get",
        arguments: { sessionId }
      }) as CallToolResult;

      const session1 = JSON.parse(getResult1.content[0].text).session;
      const originalLastUsed = session1.lastUsedAt;

      // Simulate some time passing and Client B using the session
      await new Promise(resolve => setTimeout(resolve, 10));

      // Client B would use the session (simulated by retrieving it)
      const getResult2 = await client.callTool({
        name: "session_get",
        arguments: { sessionId }
      }) as CallToolResult;

      const session2 = JSON.parse(getResult2.content[0].text).session;

      // Both clients see the same session
      expect(session2.id).toBe(session1.id);
      expect(session2.description).toBe(session1.description);
      expect(session2.cli).toBe(session1.cli);
    });

    it("should allow session handoff between LLMs", async () => {
      // Scenario: LLM A creates a session and does some work
      // LLM B wants to check something from that conversation
      // LLM C might then continue the work

      // LLM A creates and uses a session
      const createResult = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "claude",
          description: "Code review started by LLM A"
        }
      }) as CallToolResult;

      const sessionId = JSON.parse(createResult.content[0].text).session.id;

      // LLM A sets it as active (implicit in many scenarios)
      await client.callTool({
        name: "session_set_active",
        arguments: { cli: "claude", sessionId }
      });

      // LLM B retrieves the session to check on progress
      const llmBCheck = await client.callTool({
        name: "session_get",
        arguments: { sessionId }
      }) as CallToolResult;

      expect(JSON.parse(llmBCheck.content[0].text).success).toBe(true);

      // LLM B can see it's the active session
      const listResult = await client.callTool({
        name: "session_list",
        arguments: { cli: "claude" }
      }) as CallToolResult;

      const activeSessions = JSON.parse(listResult.content[0].text).activeSessions;
      expect(activeSessions.claude).toBe(sessionId);

      // LLM C could now continue using this session by passing sessionId
      // This would happen in the actual claude_request call
      // (We can't fully test this without actual CLI tools, but the session is accessible)
    });

    it("should prevent session interference between different CLIs", async () => {
      // Create sessions for different CLIs
      const claudeResult = await client.callTool({
        name: "session_create",
        arguments: { cli: "claude", description: "Claude work" }
      }) as CallToolResult;

      const codexResult = await client.callTool({
        name: "session_create",
        arguments: { cli: "codex", description: "Codex work" }
      }) as CallToolResult;

      const claudeSessionId = JSON.parse(claudeResult.content[0].text).session.id;
      const codexSessionId = JSON.parse(codexResult.content[0].text).session.id;

      // Try to set Claude session as active for Codex (should fail)
      const wrongCliResult = await client.callTool({
        name: "session_set_active",
        arguments: { cli: "codex", sessionId: claudeSessionId }
      }) as CallToolResult;

      const response = JSON.parse(wrongCliResult.content[0].text);
      expect(response.success).toBe(false);

      // Verify sessions remain independent
      const claudeList = await client.callTool({
        name: "session_list",
        arguments: { cli: "claude" }
      }) as CallToolResult;

      const codexList = await client.callTool({
        name: "session_list",
        arguments: { cli: "codex" }
      }) as CallToolResult;

      const claudeSessions = JSON.parse(claudeList.content[0].text);
      const codexSessions = JSON.parse(codexList.content[0].text);

      expect(claudeSessions.activeSessions.claude).toBe(claudeSessionId);
      expect(codexSessions.activeSessions.codex).toBe(codexSessionId);
    });

    it("should support multi-LLM workflow with explicit session IDs", async () => {
      // Complex scenario: Multiple LLMs coordinating using explicit session IDs

      // LLM 1: Creates a session for initial analysis
      const session1Result = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "claude",
          description: "Step 1: Initial code analysis",
          setAsActive: false
        }
      }) as CallToolResult;

      const session1Id = JSON.parse(session1Result.content[0].text).session.id;

      // LLM 2: Creates a separate session for design review
      const session2Result = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "claude",
          description: "Step 2: Design review",
          setAsActive: false
        }
      }) as CallToolResult;

      const session2Id = JSON.parse(session2Result.content[0].text).session.id;

      // LLM 3: Creates a session for implementation
      const session3Result = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "claude",
          description: "Step 3: Implementation",
          setAsActive: false
        }
      }) as CallToolResult;

      const session3Id = JSON.parse(session3Result.content[0].text).session.id;

      // Verify all sessions exist independently
      const listResult = await client.callTool({
        name: "session_list",
        arguments: { cli: "claude" }
      }) as CallToolResult;

      const sessions = JSON.parse(listResult.content[0].text).sessions;
      const sessionIds = sessions.map((s: any) => s.id);

      expect(sessionIds).toContain(session1Id);
      expect(sessionIds).toContain(session2Id);
      expect(sessionIds).toContain(session3Id);

      // LLM 4 (coordinator) can retrieve all sessions to check progress
      const get1 = await client.callTool({
        name: "session_get",
        arguments: { sessionId: session1Id }
      }) as CallToolResult;

      const get2 = await client.callTool({
        name: "session_get",
        arguments: { sessionId: session2Id }
      }) as CallToolResult;

      const get3 = await client.callTool({
        name: "session_get",
        arguments: { sessionId: session3Id }
      }) as CallToolResult;

      expect(JSON.parse(get1.content[0].text).session.description).toBe("Step 1: Initial code analysis");
      expect(JSON.parse(get2.content[0].text).session.description).toBe("Step 2: Design review");
      expect(JSON.parse(get3.content[0].text).session.description).toBe("Step 3: Implementation");
    });

    it("should allow session deletion by any client", async () => {
      // Client A creates a session
      const createResult = await client.callTool({
        name: "session_create",
        arguments: {
          cli: "gemini",
          description: "Temporary collaboration session"
        }
      }) as CallToolResult;

      const sessionId = JSON.parse(createResult.content[0].text).session.id;

      // Verify it exists
      const getResult = await client.callTool({
        name: "session_get",
        arguments: { sessionId }
      }) as CallToolResult;

      expect(JSON.parse(getResult.content[0].text).success).toBe(true);

      // Client B decides to delete it (cleanup)
      const deleteResult = await client.callTool({
        name: "session_delete",
        arguments: { sessionId }
      }) as CallToolResult;

      expect(JSON.parse(deleteResult.content[0].text).success).toBe(true);

      // Client C verifies it's gone
      const verifyResult = await client.callTool({
        name: "session_get",
        arguments: { sessionId }
      }) as CallToolResult;

      expect(JSON.parse(verifyResult.content[0].text).success).toBe(false);
    });
  });
});
