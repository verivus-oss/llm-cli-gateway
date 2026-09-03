/**
 * The enumerator is inside the blast radius of what it constrains.
 *
 * Its first version required an `if` branch to be a single `return`, and so
 * missed two real gates: one whose branch is `console.error` plus
 * `process.exit`, and a Zod `.refine()` link, which is a control expressed as a
 * call argument rather than a statement. A sweep that silently enumerates fewer
 * controls than the tree holds reports a clean result for the wrong reason, so
 * each shape gets a fixture that would fail if that shape stopped being found.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const temporaries = [];

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop(), { recursive: true, force: true });
});

/** Enumerate one fixture and return every mutation found in it. */
function enumerate(source) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-sweep-"));
  temporaries.push(dir);
  const file = join(dir, "fixture.ts");
  const out = join(dir, "mutations.json");
  writeFileSync(file, source);
  execFileSync("node", [join(ROOT, "scripts", "mutation-sweep.mjs"), "enumerate", out, file], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

const labels = mutations => mutations.map(m => m.label).join("\n");

describe("mutation-sweep enumerate", () => {
  it("emits one mutation per member of an enumerated set", () => {
    const found = enumerate(`const KEYWORDS = new Set(["host", "port", "database"]);\n`);
    const members = found.filter(m => m.kind === "set-member");
    expect(members).toHaveLength(3);
    for (const word of ["host", "port", "database"]) {
      expect(labels(members)).toContain(`drop "${word}"`);
    }
  });

  it("emits one mutation per arm of a multi-arm condition", () => {
    const found = enumerate(
      `export function f(a: string): boolean {\n  return a.includes("=") || a.includes(",");\n}\n`
    );
    const arms = found.filter(m => m.kind === "logical-arm");
    expect(arms).toHaveLength(2);
    expect(labels(arms)).toContain("drop arm 1/2");
    expect(labels(arms)).toContain("drop arm 2/2");
  });

  it("emits one mutation per switch case", () => {
    const found = enumerate(
      `export function f(s: string): string {\n  switch (s) {\n    case "a":\n      return "A";\n    case "b":\n      return "B";\n    default:\n      return "";\n  }\n}\n`
    );
    expect(found.filter(m => m.kind === "switch-case")).toHaveLength(2);
  });

  it("emits one mutation per regex alternative and per flag, but never for /g", () => {
    const found = enumerate(`const AT = /@|%40/gi;\n`);
    const parts = found.filter(m => m.kind === "regex-part");
    expect(labels(parts)).toContain("drop alternative 1/2");
    expect(labels(parts)).toContain("drop alternative 2/2");
    expect(labels(parts)).toContain("drop flag /i");
    expect(labels(parts)).not.toContain("drop flag /g");
  });

  it("finds a guard whose branch is not a single return", () => {
    // THE MISS THAT PROMPTED THIS FILE. A gate written as `console.error` plus
    // `process.exit` is exactly as much of a control as one written `return`.
    const found = enumerate(
      `export function f(ok: boolean): void {\n  if (!ok) {\n    console.error("no");\n    process.exit(1);\n  }\n}\n`
    );
    expect(found.filter(m => m.kind === "guard-stmt")).toHaveLength(1);
  });

  it("finds a control expressed as a call argument rather than a statement", () => {
    // The other miss: a Zod `.refine()` link is dropped by keeping the chain.
    const found = enumerate(`const S = z.string().url().refine(isFine, { message: "no" });\n`);
    const refine = found.filter(m => m.kind === "guard-stmt" && m.label.includes(".refine()"));
    expect(refine).toHaveLength(1);
    expect(refine[0].replacement).toBe("z.string().url()");
  });

  it("finds an assertion call standing alone", () => {
    const found = enumerate(
      `export function f(d: string): void {\n  assertAdmissible(d, "app");\n}\n`
    );
    expect(labels(found)).toContain("delete call `assertAdmissible");
  });

  it("gives every mutation a distinct id and a replacement that changes the text", () => {
    const found = enumerate(
      `const A = new Set(["x", "y"]);\nexport function f(a: string): boolean {\n  return a.includes("=") || a.includes(",");\n}\n`
    );
    expect(new Set(found.map(m => m.id)).size).toBe(found.length);
    for (const m of found) {
      expect(m.end, m.label).toBeGreaterThan(m.start);
      expect(m.replacement, m.label).not.toBe(undefined);
    }
  });
});

describe("mutation-sweep run", () => {
  it("refuses to report anything without --total", () => {
    // The number of tests the UNMUTATED tree reports is what separates "the
    // suite went red" from "the suite never started". Without it there is no
    // verdict to give, and the first version of this harness gave 48 anyway.
    const dir = mkdtempSync(join(tmpdir(), "mutation-sweep-run-"));
    temporaries.push(dir);
    const mutations = join(dir, "m.json");
    writeFileSync(mutations, JSON.stringify([{ id: "m001", file: "src/config.ts" }]));
    let status = 0;
    let output = "";
    try {
      execFileSync(
        "node",
        [join(ROOT, "scripts", "mutation-sweep.mjs"), "run", mutations, join(dir, "out.jsonl")],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (error) {
      status = error.status ?? 1;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    expect(status).toBe(2);
    expect(output).toContain("--total");
  });
});
