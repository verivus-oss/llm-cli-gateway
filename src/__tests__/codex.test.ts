import { describe, it, expect } from "vitest";
import { executeCodexRequest } from "../tools/codex.js";

// These tests require the codex CLI to be installed
// They test the actual integration with the CLI

describe("executeCodexRequest", () => {
  describe("basic requests", () => {
    it("should execute a simple prompt and return response", async () => {
      const result = await executeCodexRequest(
        "What is 3+3? Reply with just the number.",
        {}
      );
      expect(result).toContain("6");
    }, 60000);

    it("should handle prompts with special characters", async () => {
      const result = await executeCodexRequest(
        "Echo back: Hello $PATH!",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle multi-line prompts", async () => {
      const result = await executeCodexRequest(
        "First line\nSecond line\nHow many lines? Reply with number only.",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);
  });

  describe("model selection", () => {
    it("should work with default model", async () => {
      const result = await executeCodexRequest("Say 'test'", {});
      expect(result).toBeTruthy();
    }, 60000);

    it("should accept model parameter", async () => {
      // Note: model availability depends on account type
      // This test verifies the parameter is passed correctly
      try {
        const result = await executeCodexRequest("Say 'model test'", {
          model: "gpt-4o"
        });
        expect(result).toBeTruthy();
      } catch (error) {
        // Model might not be available for this account type
        expect(String(error)).toContain("model");
      }
    }, 60000);
  });

  describe("fullAuto mode", () => {
    it("should work without fullAuto", async () => {
      const result = await executeCodexRequest("Say hello", {
        fullAuto: false
      });
      expect(result).toBeTruthy();
    }, 60000);

    it("should work with fullAuto enabled", async () => {
      const result = await executeCodexRequest("Say hello", {
        fullAuto: true
      });
      expect(result).toBeTruthy();
    }, 60000);
  });

  describe("edge cases", () => {
    it("should handle prompts with quotes", async () => {
      const result = await executeCodexRequest(
        'Respond with: "Hello" and \'World\'',
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle prompts with unicode", async () => {
      const result = await executeCodexRequest(
        "What is 日本? Respond briefly.",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle code-related prompts", async () => {
      const result = await executeCodexRequest(
        "Write a one-line Python print statement that prints 'hello'",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);
  });
});
