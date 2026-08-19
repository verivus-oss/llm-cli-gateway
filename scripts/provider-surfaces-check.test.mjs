import { describe, expect, it } from "vitest";
import { findHandAuthoredProviderFacts } from "./provider-surfaces-check.mjs";

const binding = `
export const GEMINI_PARAMETER_BINDINGS = [
  { flag: "--add-dir", requestParameter: "includeDirs", emit: "repeat_if_nonempty", inputType: "string[]" },
];
`;

describe("the gate forbids the sin, not the shape", () => {
  it("PERMITS a binding table that names only gateway data", () => {
    // The rule this replaces refused any *_FLAG_GENERATION by NAME, so
    // converting a second provider looked like it required defeating the gate.
    // Two people tried, one day apart, and both were wrong to.
    expect(findHandAuthoredProviderFacts(binding)).toEqual([]);
  });

  it("REFUSES a row that declares what the binary accepts", () => {
    const withEnum = binding.replace(
      'flag: "--add-dir",',
      'flag: "--add-dir", values: ["a", "b"],'
    );
    expect(findHandAuthoredProviderFacts(withEnum)).toEqual(["--add-dir declares values"]);
  });

  it("REFUSES a hand-typed arity, which is the same claim about the binary", () => {
    const withArity = binding.replace(
      'flag: "--add-dir",',
      'flag: "--add-dir",\n    arity: "one",'
    );
    expect(findHandAuthoredProviderFacts(withArity)).toEqual(["--add-dir declares arity"]);
  });

  it("does not mistake the WORD values in a description for a declaration", () => {
    // The first version of this detector flagged "Known values: low, medium,
    // high" inside a describe string. That prose is a caller being told what
    // the binary publishes, which is exactly what the policy asks a description
    // to do, so flagging it would have forbidden the fix as well as the defect.
    const described = binding.replace(
      'inputType: "string[]"',
      'inputType: "string[]", describe: "Known values: a, b. Not enforced."'
    );
    expect(findHandAuthoredProviderFacts(described)).toEqual([]);
  });

  it("scopes the scan to the row's own object, not its neighbours", () => {
    const neighbour = `
      const unrelated = { values: ["x"] };
      const rows = [{ flag: "--ok", requestParameter: "ok", emit: "flag_if_true" }];
    `;
    expect(findHandAuthoredProviderFacts(neighbour)).toEqual([]);
  });

  it("finds the live tree clean", async () => {
    const { readFileSync } = await import("node:fs");
    expect(findHandAuthoredProviderFacts(readFileSync("src/provider-codegen.ts", "utf8"))).toEqual(
      []
    );
  });
});
