import { describe, it, expect } from "vitest";
import { parseGeminiJson } from "../gemini-json-parser.js";

describe("parseGeminiJson", () => {
  it("maps usageMetadata fields to the unified usage shape", () => {
    const stdout = JSON.stringify({
      response: "hello",
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 42,
        cachedContentTokenCount: 100,
        totalTokenCount: 192,
      },
    });

    const result = parseGeminiJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("hello");
    expect(result?.usage).toEqual({
      input_tokens: 150,
      output_tokens: 42,
      cache_read_tokens: 100,
    });
  });

  it("omits cache_read_tokens when cachedContentTokenCount is missing", () => {
    const stdout = JSON.stringify({
      response: "hi",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
      },
    });

    const result = parseGeminiJson(stdout);

    expect(result?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it("returns response only when usageMetadata is missing", () => {
    const stdout = JSON.stringify({ response: "no usage" });

    const result = parseGeminiJson(stdout);

    expect(result).not.toBeNull();
    expect(result?.response).toBe("no usage");
    expect(result?.usage).toBeUndefined();
  });

  it("returns null on invalid JSON", () => {
    expect(parseGeminiJson("not json at all")).toBeNull();
    expect(parseGeminiJson("")).toBeNull();
  });

  it("returns null when the parsed value is not an object", () => {
    expect(parseGeminiJson("123")).toBeNull();
    expect(parseGeminiJson("null")).toBeNull();
  });
});
