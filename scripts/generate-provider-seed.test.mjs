import { describe, expect, it } from "vitest";
import { advertisedCompletionSubcommand } from "./generate-provider-seed.mjs";

describe("advertisedCompletionSubcommand", () => {
  it("finds a subcommand the binary lists", () => {
    expect(advertisedCompletionSubcommand("Commands:\n  agent   Run\n  completions  Shell\n")).toBe(
      "completions"
    );
    expect(advertisedCompletionSubcommand("Commands:\n  completion  Shell\n")).toBe("completion");
  });

  it("returns null for a binary that lists none", () => {
    expect(
      advertisedCompletionSubcommand("Commands:\n  agent  Run\n  mcp  Configure\n")
    ).toBeNull();
  });

  it("does NOT match a mention in prose, which would bill a model call", () => {
    // `claude completion` reached the model because `completion` parsed as a
    // prompt. A word in a sentence must never authorise an invocation.
    expect(
      advertisedCompletionSubcommand("Generate shell completions with your package manager.\n")
    ).toBeNull();
  });

  it("does NOT match a flag that happens to be named --completions", () => {
    expect(advertisedCompletionSubcommand("Options:\n  --completions  Print them\n")).toBeNull();
  });
});
