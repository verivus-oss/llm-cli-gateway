import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDER_TABLES,
  tableTargets,
  transcriptMigrationFiles,
  transcriptMigrationText,
} from "./transcript-migration-selection.mjs";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const LEDGER = version =>
  `INSERT INTO schema_migrations (version, name) VALUES (${version}, 'x') ON CONFLICT DO NOTHING;`;

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "migsel-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("which migrations construct the flight recorder", () => {
  it("selects the recorder's own migrations out of the real tree", () => {
    expect(transcriptMigrationFiles(MIGRATIONS)).toEqual([
      "022_flight_recorder_transcripts.sql",
      "023_completion_rank_fence.sql",
    ]);
  });

  it("excludes a migration that targets another subsystem's table", () => {
    // The defect this module exists for: 024 alters `jobs`, and executing it
    // into a schema holding only the recorder's tables fails outright.
    const selected = transcriptMigrationFiles(MIGRATIONS);
    expect(selected).not.toContain("024_async_job_cwd_scope.sql");
    expect(transcriptMigrationText(MIGRATIONS)).not.toContain("ALTER TABLE jobs");
  });

  it("picks up a later recorder migration with nobody adding it here", () => {
    const dir = fixture({
      "022_a.sql": `CREATE TABLE requests (id TEXT);\n${LEDGER(22)}`,
      "031_later.sql": `ALTER TABLE gateway_metadata ADD COLUMN IF NOT EXISTS z TEXT;\n${LEDGER(31)}`,
    });
    try {
      expect(transcriptMigrationFiles(dir)).toEqual(["022_a.sql", "031_later.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes a migration that touches the recorder AND something else", () => {
    // Loud is correct here: such a migration cannot be replayed into a
    // recorder-only schema, and dropping it makes the mirror comparison fail
    // rather than quietly executing SQL against a table that is not there.
    const dir = fixture({
      "022_a.sql": `CREATE TABLE requests (id TEXT);\n${LEDGER(22)}`,
      "025_mixed.sql": `ALTER TABLE requests ADD COLUMN a TEXT;\nALTER TABLE jobs ADD COLUMN b TEXT;\n${LEDGER(25)}`,
    });
    try {
      expect(transcriptMigrationFiles(dir)).toEqual(["022_a.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never lets the runner's own ledger receipt decide ownership", () => {
    expect([...tableTargets(LEDGER(99))]).toEqual([]);
    expect([
      ...tableTargets(`ALTER TABLE gateway_metadata ADD COLUMN q TEXT;\n${LEDGER(99)}`),
    ]).toEqual(["gateway_metadata"]);
  });

  it("reads index targets, so an index-only recorder migration still qualifies", () => {
    expect([...tableTargets("CREATE INDEX IF NOT EXISTS idx_x ON requests(cli);")]).toEqual([
      "requests",
    ]);
  });

  it("reads quoted table identifiers without treating another subsystem as recorder-owned", () => {
    expect([...tableTargets('ALTER TABLE "jobs" ADD COLUMN x TEXT;')]).toEqual(["jobs"]);
    expect([...tableTargets('ALTER TABLE "requests" ADD COLUMN x TEXT;')]).toEqual(["requests"]);
  });

  it("reads the table after ALTER TABLE IF EXISTS rather than the IF keyword", () => {
    expect([...tableTargets("ALTER TABLE IF EXISTS requests ADD COLUMN x TEXT;")]).toEqual([
      "requests",
    ]);
  });

  it("refuses to return an empty selection instead of an empty schema", () => {
    const dir = fixture({ "022_none.sql": LEDGER(22) });
    try {
      expect(() => transcriptMigrationText(dir)).toThrow(/no flight-recorder migrations/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the recorder's tables once, and the parity gate reads them here", () => {
    expect(RECORDER_TABLES).toEqual(["requests", "gateway_metadata"]);
  });
});
