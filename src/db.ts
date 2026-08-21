import { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import {
  nodePostgresPoolFactory,
  PostgresStorageDriver,
  SESSION_POOL_SETTINGS,
} from "./storage/drivers/postgres.js";

export interface HealthCheckResult {
  postgres: { connected: boolean; latency: number };
}

/**
 * Database connection manager for PostgreSQL-backed sessions.
 *
 * It used to build its own `pg.Pool` from `config.database`. That pool was the
 * session store's private connection to the same database the job store was
 * already talking to through the storage port, which is the split this
 * programme exists to remove: two pools, two sets of settings, and role routing
 * that could never reach the sessions because they were not on the port at all.
 *
 * It now owns a `PostgresStorageDriver` instead. The class survives because it
 * is what `index.ts` holds for the `health://status` resource and shutdown, and
 * because keeping the shape means the session wiring did not have to change in
 * the same commit as the statements underneath it.
 */
export class DatabaseConnection {
  private driver: PostgresStorageDriver | null = null;
  private config: Config;

  constructor(
    config: Config,
    private logger: Logger = noopLogger
  ) {
    if (!config.database) {
      throw new Error("Database configuration required");
    }
    this.config = config;
  }

  /**
   * Initialize connection to PostgreSQL.
   */
  async connect(): Promise<void> {
    const createPool = await sessionPoolFactory(this.logger);
    const driver = new PostgresStorageDriver(
      // One role, `app`. Per-role DSNs are s9's `[persistence.roles]`; until
      // they exist the driver already reports role separation as not in force
      // rather than implying it is.
      { app: this.config.database!.connectionString },
      createPool
    );

    try {
      // `write`, for a SELECT 1. The operation class picks a CREDENTIAL, and a
      // liveness probe has to use the one the session store actually writes
      // with; probing the reader would report a database the writer cannot
      // reach as healthy.
      await driver.withConnection("write", connection => connection.query("SELECT 1"));
      this.logger.info("PostgreSQL connection established");
    } catch (error) {
      // Close the pool the failed probe opened. The previous implementation
      // left it behind on every failed connect.
      await driver.close().catch(() => undefined);
      this.logger.error("Failed to connect to PostgreSQL", { error });
      throw new Error(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    this.driver = driver;
  }

  /**
   * Graceful shutdown - close all connections
   */
  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting database connections");
    if (!this.driver) return;

    const driver = this.driver;
    this.driver = null;
    try {
      await driver.close();
    } catch (error) {
      throw new Error(
        `Disconnect errors: PostgreSQL disconnect error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Health check for PostgreSQL.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      postgres: { connected: false, latency: 0 },
    };

    if (this.driver) {
      const pgStart = Date.now();
      try {
        await this.driver.withConnection("write", connection => connection.query("SELECT 1"));
        result.postgres.connected = true;
        result.postgres.latency = Date.now() - pgStart;
      } catch {
        result.postgres.connected = false;
      }
    }

    this.logger.debug("Health check completed", {
      postgres: result.postgres.connected,
    });
    return result;
  }

  /** The storage driver the session store runs its statements on. */
  getDriver(): PostgresStorageDriver {
    if (!this.driver) {
      throw new Error("PostgreSQL pool not initialized");
    }
    return this.driver;
  }
}

/**
 * The session pool factory, with the optional-peer message the session path has
 * always given. `nodePostgresPoolFactory` imports `pg` dynamically and lets a
 * missing module propagate raw; this keeps the remedy attached to it.
 */
async function sessionPoolFactory(logger: Logger) {
  try {
    return await nodePostgresPoolFactory(
      (role, error) => logger.error(`Session pool error on role ${role}`, error),
      SESSION_POOL_SETTINGS
    );
  } catch (error: any) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "PostgreSQL sessions require optional peer dependency 'pg'. Install it alongside llm-cli-gateway to use DATABASE_URL-backed sessions.",
        { cause: error }
      );
    }
    throw error;
  }
}

/**
 * Factory function to create and connect DatabaseConnection
 */
export async function createDatabaseConnection(
  config: Config,
  logger?: Logger
): Promise<DatabaseConnection> {
  const db = new DatabaseConnection(config, logger);
  await db.connect();
  return db;
}
