#!/usr/bin/env node
// Backfill `derived_prompt_chars` / `derived_content_class` / `derivation_version`
// for flight-recorder rows written before migration v11.
//
// Why this exists: the least-cost-routing path used to bulk-read
// `requests.prompt` on every load. Migration v11 persists the two signals it
// actually needs so that reader can go away, which is the prerequisite for
// encrypting the prompt/response columns (docs/plans/postgres-security-hardening.md
// section 4.2). Rows written before v11 have NULL signals and are skipped by
// the routing path, so historical calibration data is lost until this runs.
//
// This is the LAST point at which prompt bodies can be read in bulk. It must be
// run before body encryption, not after.
//
// Usage:
//   node scripts/backfill-prompt-derivations.mjs              # dry run
//   node scripts/backfill-prompt-derivations.mjs --apply      # write
//   LLM_GATEWAY_LOGS_DB=/path/to/logs.db node ... --apply
//
// Idempotent: only touches rows whose derivation_version IS NULL, so it is safe
// to re-run and resumes automatically after an interruption.

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { derivePromptSignals } from "../dist/token-estimator.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 2000;

const dbPath =
  process.env.LLM_GATEWAY_LOGS_DB && process.env.LLM_GATEWAY_LOGS_DB !== "none"
    ? process.env.LLM_GATEWAY_LOGS_DB
    : path.join(os.homedir(), ".llm-cli-gateway", "logs.db");

console.error(`db   : ${dbPath}`);
console.error(`mode : ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);

const db = new DatabaseSync(dbPath, { readOnly: !APPLY });

const cols = db
  .prepare("PRAGMA table_info(requests)")
  .all()
  .map(c => c.name);
for (const required of ["derived_prompt_chars", "derived_content_class", "derivation_version"]) {
  if (!cols.includes(required)) {
    console.error(`ERROR: column ${required} is missing. Start the gateway once to apply`);
    console.error("       migration v11, or run against a post-v11 database.");
    process.exit(1);
  }
}

const pending = db
  .prepare("SELECT COUNT(*) AS n FROM requests WHERE derivation_version IS NULL")
  .get().n;
const total = db.prepare("SELECT COUNT(*) AS n FROM requests").get().n;
console.error(`rows : ${total} total, ${pending} needing backfill`);

if (pending === 0) {
  console.error("nothing to do");
  db.close();
  process.exit(0);
}

const select = db.prepare(
  "SELECT id, prompt FROM requests WHERE derivation_version IS NULL LIMIT ?"
);
const update = APPLY
  ? db.prepare(
      `UPDATE requests
          SET derived_prompt_chars = ?, derived_content_class = ?, derivation_version = ?
        WHERE id = ? AND derivation_version IS NULL`
    )
  : null;

let done = 0;
const classCounts = new Map();
const started = process.hrtime.bigint();

for (;;) {
  const rows = select.all(BATCH);
  if (rows.length === 0) break;

  if (APPLY) db.exec("BEGIN");
  for (const row of rows) {
    const d = derivePromptSignals(row.prompt ?? "");
    classCounts.set(d.contentClass, (classCounts.get(d.contentClass) ?? 0) + 1);
    if (APPLY) update.run(d.promptChars, d.contentClass, d.derivationVersion, row.id);
  }
  if (APPLY) db.exec("COMMIT");

  done += rows.length;
  console.error(`  ${done}/${pending}`);

  // A dry run cannot consume its queue, so stop after one representative batch.
  if (!APPLY) break;
}

const secs = Number(process.hrtime.bigint() - started) / 1e9;
console.error(`\ncontent classes: ${JSON.stringify(Object.fromEntries(classCounts))}`);
console.error(`processed ${done} row(s) in ${secs.toFixed(1)}s`);

if (APPLY) {
  const left = db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE derivation_version IS NULL")
    .get().n;
  console.error(`remaining without a derivation: ${left}`);
  if (left !== 0) {
    console.error("WARNING: rows remain unbackfilled");
    process.exitCode = 1;
  }
} else {
  console.error("dry run: no writes performed");
}

db.close();
