import { describe, expect, it } from "vitest";
import { planProviderCapture } from "../provider-capture.js";

describe("provider capture planning", () => {
  it.each([
    ["gemini", ["--print=hello"], "--output-format", "stream-json"],
    ["grok", ["-p=hello"], "--output-format", "streaming-json"],
    ["mistral", ["-p=hello", "--agent", "accept-edits"], "--output", "streaming"],
  ] as const)("selects the rich %s wire for text callers", (provider, input, flag, value) => {
    const plan = planProviderCapture(provider, input, "text");
    expect(plan.args.slice(plan.args.indexOf(flag), plan.args.indexOf(flag) + 2)).toEqual([
      flag,
      value,
    ]);
    expect(plan.transcriptCapable).toBe(true);
    expect(input).not.toContain(flag);
  });

  it("inserts Cursor capture flags before the prompt boundary", () => {
    const plan = planProviderCapture("cursor", ["--print", "--", "hello"], "text");
    expect(plan.args).toEqual(["--print", "--output-format", "stream-json", "--", "hello"]);
  });

  it.each([
    ["claude", ["-p", "--output-format", "json", "--", "hello"], "--output-format", "stream-json"],
    ["gemini", ["--print=hello", "--output-format", "json"], "--output-format", "stream-json"],
    ["grok", ["-p=hello", "--output-format", "json"], "--output-format", "streaming-json"],
    ["mistral", ["-p=hello", "--output", "json"], "--output", "streaming"],
    [
      "cursor",
      ["--print", "--output-format", "json", "--", "hello"],
      "--output-format",
      "stream-json",
    ],
  ] as const)("captures the rich %s wire for JSON presentation", (provider, input, flag, value) => {
    const plan = planProviderCapture(provider, input, "json");
    expect(plan.args.slice(plan.args.indexOf(flag), plan.args.indexOf(flag) + 2)).toEqual([
      flag,
      value,
    ]);
    expect(plan.captureFormat).toBe(value);
    expect(plan.transcriptCapable).toBe(true);
  });
});
