#!/usr/bin/env node

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { PostgreSQLSessionManager } from "./session-manager-pg.js";
import type { Logger } from "./logger.js";
import { SessionStorage, CliType } from "./session-manager.js";
import { loadConfig } from "./config.js";
import { createDatabaseConnection } from "./db.js";

// Simple console logger for migration script
const logger: Logger = {
  info: (message: string, meta?: any) => console.error(`[INFO] ${message}`, meta || ""),
  error: (message: string, meta?: any) => console.error(`[ERROR] ${message}`, meta || ""),
  debug: (message: string, meta?: any) => console.error(`[DEBUG] ${message}`, meta || "")
};

interface MigrationResult {
  migrated: number;
  failed: number;
  errors: string[];
}

/**
 * Migrate sessions from file-based storage to PostgreSQL
 */
export async function migrateFromFile(
  filePath: string,
  pgManager: PostgreSQLSessionManager
): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: 0,
    failed: 0,
    errors: []
  };

  // Read file-based sessions
  let fileData: SessionStorage;
  try {
    const fileContent = readFileSync(filePath, "utf-8");
    fileData = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(`Failed to read sessions file: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.error(`Found ${Object.keys(fileData.sessions).length} sessions to migrate`);

  // Migrate sessions
  for (const [id, session] of Object.entries(fileData.sessions)) {
    try {
      await pgManager.createSession(session.cli, session.description, session.id);

      // Migrate metadata if present
      if (session.metadata) {
        await pgManager.updateSessionMetadata(id, session.metadata);
      }

      result.migrated++;
      console.error(`✓ Migrated session ${id} (${session.cli})`);
    } catch (error) {
      result.failed++;
      const errorMsg = `Failed to migrate session ${id}: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(errorMsg);
      console.error(`✗ ${errorMsg}`);
    }
  }

  // Restore active sessions
  console.error("\nRestoring active sessions...");
  for (const [cli, sessionId] of Object.entries(fileData.activeSession)) {
    if (sessionId) {
      try {
        await pgManager.setActiveSession(cli as CliType, sessionId);
        console.error(`✓ Set active session for ${cli}: ${sessionId}`);
      } catch (error) {
        const errorMsg = `Failed to set active session for ${cli}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error(`✗ ${errorMsg}`);
      }
    }
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
  REDIS_URL        Redis connection string (required)
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
  console.error(`  REDIS_URL: ${process.env.REDIS_URL ? "[set]" : "[not set]"}`);
  console.error("");

  // Load config
  const config = loadConfig();
  if (!config) {
    console.error("ERROR: DATABASE_URL and REDIS_URL must be set");
    process.exit(1);
  }

  // Connect to database
  console.error("Connecting to database...");
  const db = await createDatabaseConnection(config, logger);
  const pgManager = new PostgreSQLSessionManager(db.getPool(), db.getRedis(), config.cacheTtl, logger);
  console.error("✓ Connected to database\n");

  try {
    // Run migration
    console.error("Starting migration...\n");
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
