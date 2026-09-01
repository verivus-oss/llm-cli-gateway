/**
 * `llm-cli-gateway storage ...`: the operator half of the retention policy.
 *
 * Retention frees PAGES. SQLite never returns them to the filesystem on its
 * own, so a bounded recorder still reports the size it grew to and the problem
 * an operator actually feels is unfixed. Compaction is what returns the bytes,
 * and it rewrites the database under an exclusive lock, which is why it is a
 * command someone runs and not a timer that fires while requests are in flight.
 *
 * `--yes` is required for the same reason: the lock is the cost, and a
 * subcommand that took it because the operator was exploring would stall the
 * gateway they were exploring it from.
 */
import { statSync } from "fs";
import { loadPersistenceConfig } from "./config.js";
import {
  compactFlightRecorderFile,
  flightRecorderEngineDecision,
  resolveFlightRecorderDbPath,
} from "./flight-recorder.js";
import { persistenceRetentionPolicy, unboundedRetentionSubsystems } from "./storage/retention.js";

const USAGE = [
  "Usage:",
  "  llm-cli-gateway storage status            # bounds, sizes and what a sweep would delete",
  "  llm-cli-gateway storage compact --yes     # rewrite the transcript file; STOP the gateway first",
  "",
  "compact takes an exclusive lock for the length of a full rewrite of the",
  "database. Run it with the gateway stopped.",
].join("\n");

function bytes(n: number): string {
  return `${n} bytes (${(n / 1_048_576).toFixed(1)} MiB)`;
}

/**
 * The file this host's transcripts are actually in, or a reason there is none.
 *
 * Not `resolveFlightRecorderDbPath()` alone: on a PostgreSQL host that path can
 * still name the abandoned SQLite file, and compacting it would rewrite the
 * wrong database while reporting success.
 */
function sqliteTranscriptPath(): { path: string } | { refusal: string } {
  const persistence = loadPersistenceConfig();
  const path = resolveFlightRecorderDbPath();
  if (!path) {
    return { refusal: "The flight recorder is disabled (LLM_GATEWAY_LOGS_DB is 'none')." };
  }
  const decision = flightRecorderEngineDecision(persistence.backend);
  if (decision.engine === "postgres") {
    return {
      refusal:
        "Request history is in PostgreSQL on this host. There is nothing to compact: autovacuum " +
        "reclaims deleted rows and no exclusive lock or operator step is involved.",
    };
  }
  return { path };
}

function printStatus(): void {
  const persistence = loadPersistenceConfig();
  const policy = persistenceRetentionPolicy(persistence);
  const target = sqliteTranscriptPath();
  const lines = [
    `job store backend: ${persistence.backend}`,
    `retention (days):  ${JSON.stringify(policy.days)}`,
    `unbounded:         ${unboundedRetentionSubsystems(policy).join(", ") || "(none)"}`,
  ];
  if ("path" in target) {
    let size: string;
    try {
      size = bytes(statSync(target.path).size);
    } catch {
      size = "not created yet";
    }
    lines.push(`transcript file:   ${target.path}`, `                   ${size}`);
  } else {
    lines.push(`transcript file:   ${target.refusal}`);
  }
  lines.push(
    "",
    "Row counts and what a sweep would delete: llm-cli-gateway doctor --json  ->  .storage.retention"
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function compact(args: string[]): Promise<void> {
  const target = sqliteTranscriptPath();
  if ("refusal" in target) {
    process.stderr.write(`${target.refusal}\n`);
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--yes")) {
    process.stderr.write(
      `${target.path}\n` +
        "Compaction rewrites the whole database under an exclusive lock. STOP the gateway first, " +
        "then re-run with --yes.\n"
    );
    process.exitCode = 2;
    return;
  }
  const result = await compactFlightRecorderFile(target.path);
  const freed = result.beforeBytes - result.afterBytes;
  process.stdout.write(
    `${result.path}\n  before: ${bytes(result.beforeBytes)}\n  after:  ${bytes(result.afterBytes)}\n` +
      `  freed:  ${bytes(freed)}\n`
  );
}

export async function runStorageCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "status") {
    printStatus();
    return;
  }
  if (sub === "compact") {
    await compact(args.slice(1));
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}
