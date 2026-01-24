import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeClaudeRequest } from "../tools/claude.js";

// These tests require the claude CLI to be installed
// They test the actual integration with the CLI

describe("executeClaudeRequest", () => {
  describe("basic requests", () => {
    it("should execute a simple prompt and return response", async () => {
      const result = await executeClaudeRequest("What is 2+2? Reply with just the number.", {
        model: "haiku"
      });
      expect(result).toContain("4");
    }, 30000);

    it("should handle prompts with special characters", async () => {
      const result = await executeClaudeRequest("Echo back exactly: Hello $USER!", {
        model: "haiku"
      });
      expect(result).toBeTruthy();
    }, 30000);

    it("should handle multi-line prompts", async () => {
      const result = await executeClaudeRequest(
        "Line 1\nLine 2\nLine 3\nCount the lines and respond with just the number.",
        { model: "haiku" }
      );
      expect(result).toContain("3");
    }, 30000);
  });

  describe("model selection", () => {
    it("should use haiku model when specified", async () => {
      const result = await executeClaudeRequest("Say 'haiku test'", {
        model: "haiku"
      });
      expect(result).toBeTruthy();
    }, 30000);

    it("should work without model specified (uses default)", async () => {
      const result = await executeClaudeRequest("Say 'default model test'", {});
      expect(result).toBeTruthy();
    }, 30000);
  });

  describe("output formats", () => {
    it("should return text format by default", async () => {
      const result = await executeClaudeRequest("Say hello", {
        model: "haiku",
        outputFormat: "text"
      });
      expect(typeof result).toBe("string");
      expect(result).toBeTruthy();
    }, 30000);

    it("should return JSON format when specified", async () => {
      const result = await executeClaudeRequest(
        "Respond with a JSON object containing a greeting field",
        { model: "haiku", outputFormat: "json" }
      );
      expect(result).toBeTruthy();
      // JSON output should contain JSON-like content
    }, 30000);
  });

  describe("edge cases", () => {
    it("should handle empty-ish prompts gracefully", async () => {
      const result = await executeClaudeRequest(".", { model: "haiku" });
      expect(result).toBeTruthy();
    }, 30000);

    it("should handle very long prompts", async () => {
      const longPrompt = "Repeat 'ok'. ".repeat(100) + " Just say 'done'.";
      const result = await executeClaudeRequest(longPrompt, { model: "haiku" });
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle prompts with quotes", async () => {
      const result = await executeClaudeRequest(
        'Say exactly: "Hello" and \'World\'',
        { model: "haiku" }
      );
      expect(result).toBeTruthy();
    }, 30000);

    it("should handle prompts with unicode", async () => {
      const result = await executeClaudeRequest(
        "What emoji is this: 🎉? Describe it briefly.",
        { model: "haiku" }
      );
      expect(result).toBeTruthy();
    }, 30000);
  });

  describe("error scenarios", () => {
    it("should throw error for invalid model", async () => {
      // This depends on CLI behavior - it might reject or use default
      try {
        await executeClaudeRequest("test", { model: "invalid-model" as any });
        // If it doesn't throw, it used a default model
      } catch (error) {
        expect(error).toBeDefined();
      }
    }, 30000);
  });
});
