#!/usr/bin/env node

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  PostgreSQLSessionManager,
  type FileSessionMigrationPlan,
  type FileSessionMigrationRecord,
} from "./session-manager-pg.js";
import type { Logger } from "./logger.js";
import {
  canonicalizeKitActiveSessionPointerKey,
  getKitSessionBinding,
  type ProviderType,
  type Session,
} from "./session-manager.js";
import { loadConfig } from "./config.js";
import { createDatabaseConnection } from "./db.js";

// Simple console logger for migration script
const logger: Logger = {
  info: (message: string, meta?: any) => console.error(`[INFO] ${message}`, meta || ""),
  error: (message: string, meta?: any) => console.error(`[ERROR] ${message}`, meta || ""),
  debug: (message: string, meta?: any) => console.error(`[DEBUG] ${message}`, meta || ""),
};

interface MigrationResult {
  migrated: number;
  failed: number;
  errors: string[];
}

interface SourceMigrationRecord {
  source: Session;
  record: FileSessionMigrationRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]*$/.test(value) && value.length <= 32;
}

function ownerForMigration(session: Session): string {
  return typeof session.ownerPrincipal === "string" && session.ownerPrincipal.trim().length > 0
    ? session.ownerPrincipal
    : "local";
}

function makeSourceMigrationRecord(
  storageKey: string,
  value: unknown
): SourceMigrationRecord | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const cli = value.cli;
  const description = value.description;
  const rawMetadata = value.metadata;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id !== storageKey ||
    !isProviderType(cli) ||
    (description !== undefined && typeof description !== "string") ||
    (rawMetadata !== undefined && rawMetadata !== null && !isRecord(rawMetadata))
  ) {
    return null;
  }

  const ownerPrincipal =
    typeof value.ownerPrincipal === "string" && value.ownerPrincipal.trim().length > 0
      ? value.ownerPrincipal
      : "local";
  const metadata = rawMetadata && isRecord(rawMetadata) ? { ...rawMetadata } : {};
  const source: Session = {
    id,
    cli,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : "",
    ...(description === undefined ? {} : { description }),
    metadata,
    ownerPrincipal,
  };
  const binding = getKitSessionBinding(source);
  // Never silently drop a malformed Kit document during a general session
  // import. The operator must repair it before a transactional retry.
  if (Object.prototype.hasOwnProperty.call(metadata, "kit") && !binding) return null;

  return {
    source,
    record: {
      id,
      cli,
      ...(description === undefined ? {} : { description }),
      metadata,
      ownerPrincipal,
      binding,
    },
  };
}

function invalidSourceError(): string {
  return "Skipped invalid session record";
}

function invalidActiveSessionPointerError(): string {
  return "Skipped invalid active session pointer";
}

function invalidKitPointerError(): string {
  return "Skipped invalid Personal Agent Config Kit pointer";
}

/**
 * Validate every source record and pointer before any target write begins.
 * Errors intentionally omit source ids, paths, keys, and metadata because
 * those values can include private workspace information.
 */
function buildMigrationPlan(fileData: unknown): {
  plan: FileSessionMigrationPlan | null;
  errors: string[];
} {
  if (!isRecord(fileData) || !isRecord(fileData.sessions) || !isRecord(fileData.activeSession)) {
    return { plan: null, errors: [invalidSourceError()] };
  }

  const errors: string[] = [];
  const sourceRecords = new Map<string, SourceMigrationRecord>();
  const sessions: FileSessionMigrationRecord[] = [];
  for (const [storageKey, value] of Object.entries(fileData.sessions)) {
    const sourceRecord = makeSourceMigrationRecord(storageKey, value);
    if (!sourceRecord || sourceRecords.has(sourceRecord.record.id)) {
      errors.push(invalidSourceError());
      continue;
    }
    sourceRecords.set(sourceRecord.record.id, sourceRecord);
    sessions.push(sourceRecord.record);
  }

  const activeSessions: FileSessionMigrationPlan["activeSessions"][number][] = [];
  for (const [cliValue, sessionId] of Object.entries(fileData.activeSession)) {
    if (sessionId === null) continue;
    if (typeof sessionId !== "string" || !isProviderType(cliValue)) {
      errors.push(invalidActiveSessionPointerError());
      continue;
    }
    const source = sourceRecords.get(sessionId);
    if (!source || source.record.cli !== cliValue) {
      errors.push(invalidActiveSessionPointerError());
      continue;
    }
    activeSessions.push({ cli: cliValue, sessionId });
  }

  const activeKitSessions: FileSessionMigrationPlan["activeKitSessions"][number][] = [];
  const kitPointerTargets = new Map<string, string>();
  const activeKitSession = fileData.activeKitSession;
  if (activeKitSession !== undefined && activeKitSession !== null) {
    if (!isRecord(activeKitSession)) {
      errors.push(invalidKitPointerError());
    } else {
      for (const [cliValue, pointers] of Object.entries(activeKitSession)) {
        if (!isProviderType(cliValue) || !isRecord(pointers)) {
          errors.push(invalidKitPointerError());
          continue;
        }
        for (const [sourceKey, sessionId] of Object.entries(pointers)) {
          if (typeof sessionId !== "string") {
            errors.push(invalidKitPointerError());
            continue;
          }
          const source = sourceRecords.get(sessionId);
          const binding = source ? getKitSessionBinding(source.source) : null;
          if (!source || !binding || source.record.cli !== cliValue) {
            errors.push(invalidKitPointerError());
            continue;
          }
          const ownerPrincipal = ownerForMigration(source.source);
          const scopeKey = canonicalizeKitActiveSessionPointerKey(
            sourceKey,
            binding.execution,
            ownerPrincipal
          );
          if (!scopeKey) {
            errors.push(invalidKitPointerError());
            continue;
          }
          const targetKey = `${cliValue}\u0000${scopeKey}`;
          const existingTarget = kitPointerTargets.get(targetKey);
          if (existingTarget && existingTarget !== sessionId) {
            errors.push(invalidKitPointerError());
            continue;
          }
          if (existingTarget) continue;
          kitPointerTargets.set(targetKey, sessionId);
          activeKitSessions.push({
            cli: cliValue,
            scopeRoot: binding.execution.scopeRoot,
            sessionId,
            execution: binding.execution,
            ownerPrincipal,
          });
        }
      }
    }
  }

  if (errors.length > 0) return { plan: null, errors };
  return { plan: { sessions, activeSessions, activeKitSessions }, errors };
}

/**
 * Migrate sessions from file-based storage to PostgreSQL. The importer never
 * overwrites a different target active pointer: a live-pointer conflict rolls
 * the entire import back. Pause writers for a coherent cutover, or resolve the
 * conflict and retry from a fresh source snapshot.
 */
export async function migrateFromFile(
  filePath: string,
  pgManager: PostgreSQLSessionManager
): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: 0,
    failed: 0,
    errors: [],
  };

  // Read file-based sessions
  let fileData: unknown;
  try {
    const fileContent = readFileSync(filePath, "utf-8");
    fileData = JSON.parse(fileContent);
  } catch {
    throw new Error("Failed to read sessions file");
  }

  const { plan, errors } = buildMigrationPlan(fileData);
  if (!plan) {
    result.failed = errors.length;
    result.errors.push(...errors);
    for (const error of errors) console.error(`✗ ${error}`);
    return result;
  }

  console.error(`Found ${plan.sessions.length} sessions to migrate`);
  try {
    const outcome = await pgManager.importFileSessionMigration(plan);
    result.migrated = outcome.migrated;
    if (outcome.migrated > 0) console.error(`✓ Migrated ${outcome.migrated} session(s)`);
    if (outcome.replayed > 0) console.error(`✓ Replayed ${outcome.replayed} session(s)`);
  } catch {
    const errorMsg = "Session migration failed before completion; transaction rolled back";
    result.failed = Math.max(1, plan.sessions.length);
    result.errors.push(errorMsg);
    console.error(`✗ ${errorMsg}`);
  }

  return result;
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.error(`
Usage: node dist/migrate-sessions.js --from <sessions.json>

Migrate sessions from file-based storage to PostgreSQL.

Options:
  --from <path>    Path to sessions.json file (default: ~/.llm-cli-gateway/sessions.json)
  --help, -h       Show this help message

Environment Variables:
  DATABASE_URL     PostgreSQL connection string (required)
`);
    process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 1);
  }

  // Parse arguments
  let filePath = join(homedir(), ".llm-cli-gateway", "sessions.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      filePath = args[i + 1];
      i++;
    }
  }

  console.error(`Migration Configuration:`);
  console.error(`  Source: ${filePath}`);
  console.error(`  DATABASE_URL: ${process.env.DATABASE_URL ? "[set]" : "[not set]"}`);
  console.error("");

  // Load config
  const config = loadConfig();
  if (!config.database) {
    console.error("ERROR: DATABASE_URL must be set");
    process.exit(1);
  }

  // Connect to database
  console.error("Connecting to database...");
  const db = await createDatabaseConnection(config, logger);
  const pgManager = new PostgreSQLSessionManager(db.getPool());
  console.error("✓ Connected to database\n");

  try {
    // Run migration
    console.error("Starting migration...\n");
    console.error(
      "Pause target writers for a coherent cutover. Live active-pointer conflicts fail closed and can be retried.\n"
    );
    const result = await migrateFromFile(filePath, pgManager);

    console.error("\n" + "=".repeat(50));
    console.error("Migration Summary:");
    console.error(`  Migrated: ${result.migrated}`);
    console.error(`  Failed: ${result.failed}`);

    if (result.errors.length > 0) {
      console.error("\nErrors:");
      result.errors.forEach(err => console.error(`  - ${err}`));
    }

    if (result.failed === 0) {
      console.error("\n✓ Migration completed successfully!");
      process.exit(0);
    } else {
      console.error("\n⚠ Migration completed with errors");
      process.exit(1);
    }
  } catch (error) {
    console.error("\nERROR:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await db.disconnect();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
