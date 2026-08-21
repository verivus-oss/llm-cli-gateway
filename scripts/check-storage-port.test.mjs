import { describe, expect, it } from "vitest";
import {
  maintenanceLiterals,
  sqlLiterals,
  stripComments,
  violationsFor,
} from "./check-storage-port.mjs";

/** What the gate sees: a file body with its comments already blanked. */
const seen = source => stripComments(source);

const PRODUCTION = "cache-stats.ts";
const OWNER = "flight-recorder.ts";
const TEST = "__tests__/flight-recorder.test.ts";

describe("rule 3: PRAGMA and VACUUM outside a storage module", () => {
  // ADD form. Each of these is a file that does NOT exist; the control is that
  // adding it turns the gate red. A gate proven only by the tree being clean
  // is a gate proven by the absence of the defect, which is not a proof.
  it("fires on a PRAGMA in a double-quoted string", () => {
    const body = seen(`const rows = db.prepare("PRAGMA table_info(requests)").all();`);
    expect(violationsFor(PRODUCTION, body)).toHaveLength(1);
    expect(violationsFor(PRODUCTION, body)[0]).toContain("PRAGMA or VACUUM");
  });

  it("fires on a PRAGMA in a template literal and in a single-quoted string", () => {
    expect(maintenanceLiterals(seen("db.exec(`PRAGMA journal_mode = WAL`);"))).toEqual([1]);
    expect(maintenanceLiterals(seen("db.exec('PRAGMA synchronous = NORMAL');"))).toEqual([1]);
  });

  it("fires on VACUUM", () => {
    expect(violationsFor(PRODUCTION, seen(`db.exec("VACUUM");`))).toHaveLength(1);
  });

  it("REGRESSION: the template-literal-only scan could not see either", () => {
    // This is the whole reason rule 3 needed its own literal scan. The rule-1
    // scan reads template literals because that is where SELECT and INSERT
    // live. PRAGMA is short enough to sit in a quoted string, and does, at
    // eleven sites in flight-recorder.ts alone.
    const body = seen(`const rows = db.prepare("PRAGMA table_info(requests)").all();`);
    expect(sqlLiterals(body)).toEqual([]);
    expect(maintenanceLiterals(body)).toEqual([1]);
  });

  it("reports the line the statement is on, not line 1", () => {
    const body = seen(`const a = 1;\nconst b = 2;\ndb.exec("VACUUM");`);
    expect(violationsFor(PRODUCTION, body)[0]).toContain(`${PRODUCTION}:3:`);
  });
});

describe("rule 3: where it deliberately does NOT fire", () => {
  it("a storage-owning module may spell both", () => {
    const body = seen(`db.exec("PRAGMA journal_mode = WAL"); db.exec("VACUUM");`);
    expect(violationsFor(OWNER, body)).toEqual([]);
  });

  it("a test may seed and inspect a fixture database directly", () => {
    const body = seen(`db.prepare("PRAGMA table_info(requests)").all();`);
    expect(violationsFor(TEST, body)).toEqual([]);
  });

  it("prose about a PRAGMA in a comment is not a PRAGMA", () => {
    const body = seen(`// checked via a prior PRAGMA table_info() call\nconst x = 1;`);
    expect(violationsFor(PRODUCTION, body)).toEqual([]);
  });

  it("KNOWN BOUNDARY: prose inside a STRING does fire, and that is accepted", () => {
    // Comments are blanked, string literals are not, so a user-facing message
    // mentioning either verb outside a storage module turns the gate red. The
    // tree is at zero today and the resolution when it happens is to reword the
    // message or move it, never to suppress the site. Recorded as a test so the
    // next reader meets it as a decision rather than as a surprise.
    expect(
      violationsFor(PRODUCTION, seen(`throw new Error("VACUUM is not permitted here");`))
    ).toHaveLength(1);
  });
});

describe("rules 1 and 2 still hold", () => {
  it("SQL in a template literal outside a storage module is a violation", () => {
    const body = seen("const rows = db.all(`SELECT id FROM requests WHERE cli = ?`);");
    expect(violationsFor(PRODUCTION, body)[0]).toContain("SQL outside a storage-owning module");
  });

  it("the phrase that broke the first version is still not SQL", () => {
    expect(violationsFor(PRODUCTION, seen("const m = `select a workspace first`;"))).toEqual([]);
  });

  it("calling queryRequests outside the recorder is a violation", () => {
    const body = seen("recorder.queryRequests(`SELECT 1`);");
    expect(violationsFor(PRODUCTION, body).some(v => v.includes("calls queryRequests"))).toBe(true);
    expect(violationsFor(OWNER, body).some(v => v.includes("calls queryRequests"))).toBe(false);
  });
});
