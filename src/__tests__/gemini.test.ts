import { describe, it, expect } from "vitest";
import { executeGeminiRequest } from "../tools/gemini.js";

// These tests require the gemini CLI to be installed
// They test the actual integration with the CLI

describe("executeGeminiRequest", () => {
  describe("basic requests", () => {
    it("should execute a simple prompt and return response", async () => {
      const result = await executeGeminiRequest(
        "What is 4+4? Reply with just the number.",
        {}
      );
      expect(result).toContain("8");
    }, 60000);

    it("should handle prompts with special characters", async () => {
      const result = await executeGeminiRequest(
        "Echo: Hello $USER!",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle multi-line prompts", async () => {
      const result = await executeGeminiRequest(
        "A\nB\nC\nHow many letters? Just the number.",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);
  });

  describe("model selection", () => {
    it("should work with default model", async () => {
      const result = await executeGeminiRequest("Say 'test'", {});
      expect(result).toBeTruthy();
    }, 60000);

    it("should accept model parameter", async () => {
      const result = await executeGeminiRequest("Say 'model test'", {
        model: "gemini-2.5-flash"
      });
      expect(result).toBeTruthy();
    }, 60000);
  });

  describe("edge cases", () => {
    it("should handle prompts with quotes", async () => {
      const result = await executeGeminiRequest(
        'Say: "Double" and \'Single\'',
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle prompts with unicode", async () => {
      const result = await executeGeminiRequest(
        "Translate 'hello' to Japanese. One word only.",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);

    it("should handle technical prompts", async () => {
      const result = await executeGeminiRequest(
        "What programming language uses .py extension? One word.",
        {}
      );
      expect(result.toLowerCase()).toContain("python");
    }, 60000);

    it("should handle prompts with backticks", async () => {
      const result = await executeGeminiRequest(
        "What is `console.log` in JavaScript? Brief answer.",
        {}
      );
      expect(result).toBeTruthy();
    }, 60000);
  });
});
