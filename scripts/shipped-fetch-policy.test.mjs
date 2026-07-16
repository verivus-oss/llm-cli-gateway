import { describe, expect, it } from "vitest";
import {
  findShippedFetchViolations,
  isApprovedShippedFetchLine,
  isShippedDistSourcePath,
} from "./shipped-fetch-policy.mjs";

const approvedLines = [
  'case "fetch":',
  'git(layout.baselineDir, ["fetch", "origin"], false, options);',
  'const upstreamSynchronization = git(layout.baselineDir, ["fetch", "origin"], true, options);',
];

describe("shipped fetch policy", () => {
  it("identifies only shipped JavaScript and declaration files", () => {
    expect(isShippedDistSourcePath("dist/personal-config.js")).toBe(true);
    expect(isShippedDistSourcePath("dist/personal-config.d.ts")).toBe(true);
    expect(isShippedDistSourcePath("dist\\personal-config.js")).toBe(true);
    expect(isShippedDistSourcePath("dist/__tests__/personal-config.js")).toBe(false);
    expect(isShippedDistSourcePath("dist/__tests__/personal-config.d.ts")).toBe(false);
    expect(isShippedDistSourcePath("src/personal-config.ts")).toBe(false);
    expect(isShippedDistSourcePath("dist/personal-config.js.map")).toBe(false);
  });

  it.each(approvedLines)("allows the exact reviewed Git line %s", line => {
    expect(isApprovedShippedFetchLine("dist/personal-config.js", line)).toBe(true);
    expect(isApprovedShippedFetchLine("dist\\personal-config.js", `  ${line}  `)).toBe(true);
  });

  it("rejects an otherwise approved line outside its exact generated file", () => {
    for (const line of approvedLines) {
      expect(isApprovedShippedFetchLine("dist/personal-config.d.ts", line)).toBe(false);
      expect(isApprovedShippedFetchLine("dist/other.js", line)).toBe(false);
      expect(isApprovedShippedFetchLine("src/personal-config.ts", line)).toBe(false);
    }
  });

  it("rejects altered lines and browser-style fetch calls", () => {
    expect(
      isApprovedShippedFetchLine(
        "dist/personal-config.js",
        'git(layout.baselineDir, ["fetch", "origin"], true);'
      )
    ).toBe(false);
    // The pre-timeout call forms must not keep passing once the reviewed code
    // moved on: an allowlist that still accepts superseded lines would let an
    // unbounded network Git call back into the shipped package unnoticed.
    expect(
      isApprovedShippedFetchLine(
        "dist/personal-config.js",
        'git(layout.baselineDir, ["fetch", "origin"]);'
      )
    ).toBe(false);
    expect(
      isApprovedShippedFetchLine(
        "dist/personal-config.js",
        'const upstreamSynchronization = git(layout.baselineDir, ["fetch", "origin"], true);'
      )
    ).toBe(false);
    expect(
      isApprovedShippedFetchLine(
        "dist/personal-config.js",
        'const response = fetch("https://example.invalid");'
      )
    ).toBe(false);
  });

  it("finds only unapproved fetch tokens with their generated line numbers", () => {
    expect(
      findShippedFetchViolations(
        "dist/personal-config.js",
        [
          'case "fetch":',
          'git(layout.baselineDir, ["fetch", "origin"], false, options);',
          "const answer = Fetch(url);",
          'throw new Error("Baseline requires a fetch URL");',
          'const response = fetch("https://example.invalid");',
        ].join("\n")
      )
    ).toEqual([
      { line: "const answer = Fetch(url);", lineNumber: 3 },
      { line: 'throw new Error("Baseline requires a fetch URL");', lineNumber: 4 },
      { line: 'const response = fetch("https://example.invalid");', lineNumber: 5 },
    ]);
    expect(
      findShippedFetchViolations("dist/personal-config.d.ts", "declare const FETCH: unknown;")
    ).toEqual([{ line: "declare const FETCH: unknown;", lineNumber: 1 }]);
    expect(findShippedFetchViolations("dist/__tests__/example.js", "fetch(url);")).toEqual([]);
  });
});
