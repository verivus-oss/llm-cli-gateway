import { describe, expect, it } from "vitest";
import {
  compareFrozenSqlCounts,
  findHandAuthoredProviderFacts,
  findSqlEnumeratedProviderLists,
  frozenSqlCounts,
} from "./provider-surfaces-check.mjs";

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

describe("the .sql blind spot", () => {
  // The scan stopped at `.ts`, so the ratchet built to forbid hand-maintained
  // provider lists could not see the four that lived in migrations/.
  it("finds the frozen lists, which is how we know the walk reached them", () => {
    // A gate that scanned nothing would also exit 0. This asserts the counts it
    // actually read, not merely that it was happy.
    expect(Object.fromEntries(frozenSqlCounts)).toEqual({
      "migrations/001_initial_schema.sql": 2,
      "migrations/003_provider_type_sessions.sql": 2,
      "migrations/005_provider_type_open_api_names.sql": 1,
    });
  });

  it("REFUSES a new enumerated provider list in SQL", () => {
    const added = "  cli TEXT NOT NULL CHECK (cli IN ('claude', 'codex', 'gemini')),";
    expect(findSqlEnumeratedProviderLists(added)).toEqual([
      { line: 1, snippet: "'claude', 'codex', 'gemini'" },
    ]);
  });

  it("PERMITS the format guard that replaced them", () => {
    const guard = "  cli VARCHAR(32) NOT NULL CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),";
    expect(findSqlEnumeratedProviderLists(guard)).toEqual([]);
  });

  it("PERMITS a two-name pair, which can be a legitimate either/or", () => {
    const pair = "  WHERE cli IN ('claude', 'codex')";
    expect(findSqlEnumeratedProviderLists(pair)).toEqual([]);
  });

  it("sees the wrong name as well as the missing ones", () => {
    // `grok-api` is an API provider id, not a CliType. A detector blind to it
    // would miss half of what makes these lists wrong.
    const withApi = "CHECK (cli IN ('grok', 'mistral', 'grok-api'))";
    expect(findSqlEnumeratedProviderLists(withApi)).toHaveLength(1);
  });

  it("fails when a frozen count changes in EITHER direction", () => {
    const edited = new Map([
      ["migrations/001_initial_schema.sql", 3],
      ["migrations/003_provider_type_sessions.sql", 2],
      ["migrations/005_provider_type_open_api_names.sql", 1],
    ]);
    expect(compareFrozenSqlCounts(edited)).toEqual([
      "migrations/001_initial_schema.sql: 3 enumerated provider list(s), expected exactly 2",
    ]);

    const deleted = new Map([["migrations/001_initial_schema.sql", 2]]);
    expect(compareFrozenSqlCounts(deleted)).toHaveLength(2);
  });

  it("EXITS NON-ZERO on a new migration carrying one, and zero without it", async () => {
    // The enforcement, not the detector: a gate that only prints is not a gate.
    // ADD form, per storage-unification.md 3.5: the fixture adds a NEW file
    // rather than removing an existing one, and it lives in a temporary
    // directory so the test never writes into the tree it is checking.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const root = mkdtempSync(join(tmpdir(), "provider-surfaces-sql-"));
    const migrations = join(root, "migrations");
    (await import("node:fs")).mkdirSync(migrations);
    const clean = "ALTER TABLE sessions ADD CONSTRAINT c CHECK (cli ~ '^[A-Za-z]');\n";
    writeFileSync(join(migrations, "900_clean.sql"), clean);

    const run = () => {
      try {
        // Never through a pipe: execFileSync reports the child's own status.
        execFileSync(process.execPath, [
          "scripts/provider-surfaces-check.mjs",
          `--sql-fixture=${root}`,
        ]);
        return 0;
      } catch (error) {
        return error.status;
      }
    };

    try {
      expect(run()).toBe(0);
      writeFileSync(
        join(migrations, "901_enumerated.sql"),
        "ALTER TABLE sessions ADD CONSTRAINT c CHECK (cli IN ('claude', 'codex', 'gemini'));\n"
      );
      expect(run()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
