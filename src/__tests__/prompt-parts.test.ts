import { describe, it, expect } from "vitest";
import {
  assemble,
  PromptPartsSchema,
  resolvePromptInput,
  type PromptParts,
} from "../prompt-parts.js";

describe("assemble", () => {
  it("preserves canonical order: system → tools → context → task", () => {
    const result = assemble({
      system: "S",
      tools: "T",
      context: "C",
      task: "Q",
    });
    expect(result.text).toBe("S\n\nT\n\nC\n\nQ");
  });

  it("stableByteEnd is byte-accurate for ASCII", () => {
    const result = assemble({ system: "abc", task: "ignored" });
    // stable text = "abc" → 3 bytes; task appended after \n\n
    expect(result.stableByteEnd).toBe(3);
    expect(result.text).toBe("abc\n\nignored");
  });

  it("stableByteEnd is byte-accurate for multi-byte UTF-8", () => {
    // "héllo" → h (1) + é (2) + l (1) + l (1) + o (1) = 6 bytes
    const parts: PromptParts = { system: "héllo", task: "x" };
    const result = assemble(parts);
    expect(result.stableByteEnd).toBe(6);
    expect(Buffer.from(result.text, "utf8").subarray(0, 6).toString("utf8")).toBe("héllo");
  });

  it("missing optional parts produce stable output", () => {
    const r1 = assemble({ task: "Q" });
    expect(r1.text).toBe("Q");
    expect(r1.stableByteEnd).toBe(0);

    const r2 = assemble({ system: "S", task: "Q" });
    expect(r2.text).toBe("S\n\nQ");
    expect(r2.stableByteEnd).toBe(1);

    const r3 = assemble({ tools: "T", context: "C", task: "Q" });
    expect(r3.text).toBe("T\n\nC\n\nQ");
    expect(r3.stableByteEnd).toBe(Buffer.byteLength("T\n\nC", "utf8"));
  });

  it("re-invocation with identical parts produces byte-identical output", () => {
    const parts: PromptParts = {
      system: "sys",
      tools: "tls",
      context: "ctx",
      task: "task",
    };
    const r1 = assemble(parts);
    const r2 = assemble(parts);
    expect(r1.text).toBe(r2.text);
    expect(r1.stableByteEnd).toBe(r2.stableByteEnd);
  });
});

describe("PromptPartsSchema", () => {
  it("accepts a valid promptParts with only task", () => {
    const parsed = PromptPartsSchema.parse({ task: "hello" });
    expect(parsed.task).toBe("hello");
  });

  it("accepts a fully populated promptParts", () => {
    const input = { system: "s", tools: "t", context: "c", task: "q" };
    expect(PromptPartsSchema.parse(input)).toEqual(input);
  });

  it("rejects empty task", () => {
    expect(() => PromptPartsSchema.parse({ task: "" })).toThrow();
  });

  it("rejects missing task", () => {
    expect(() => PromptPartsSchema.parse({ system: "s" } as unknown)).toThrow();
  });
});

describe("resolvePromptInput", () => {
  it("returns null hash and tokens when only prompt is provided", () => {
    const r = resolvePromptInput({ prompt: "hello" });
    expect(r.assembledPrompt).toBe("hello");
    expect(r.stablePrefixHash).toBeNull();
    expect(r.stablePrefixTokens).toBeNull();
  });

  it("returns non-null hash and tokens when promptParts is provided", () => {
    const r = resolvePromptInput({
      promptParts: { system: "s", task: "q" },
    });
    expect(r.assembledPrompt).toBe("s\n\nq");
    expect(r.stablePrefixHash).not.toBeNull();
    expect(r.stablePrefixTokens).not.toBeNull();
    expect(r.stablePrefixTokens).toBeGreaterThan(0);
  });

  it("identical promptParts → identical stablePrefixHash", () => {
    const a = resolvePromptInput({
      promptParts: { system: "sys", tools: "tls", task: "first" },
    });
    const b = resolvePromptInput({
      promptParts: { system: "sys", tools: "tls", task: "second" },
    });
    expect(a.stablePrefixHash).toBe(b.stablePrefixHash);
    expect(a.stablePrefixTokens).toBe(b.stablePrefixTokens);
    // assembled prompts differ (different task tail)
    expect(a.assembledPrompt).not.toBe(b.assembledPrompt);
  });

  it("different stable parts → different stablePrefixHash", () => {
    const a = resolvePromptInput({
      promptParts: { system: "sys-A", task: "x" },
    });
    const b = resolvePromptInput({
      promptParts: { system: "sys-B", task: "x" },
    });
    expect(a.stablePrefixHash).not.toBe(b.stablePrefixHash);
  });

  it("returns nulls when neither prompt nor promptParts provided", () => {
    const r = resolvePromptInput({});
    expect(r.assembledPrompt).toBe("");
    expect(r.stablePrefixHash).toBeNull();
    expect(r.stablePrefixTokens).toBeNull();
  });
});
