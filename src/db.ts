import type { Pool, PoolConfig } from "pg";
import { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

export interface HealthCheckResult {
  postgres: { connected: boolean; latency: number };
}

/**
 * Database connection manager for PostgreSQL-backed sessions.
 */
export class DatabaseConnection {
  private pool: Pool | null = null;
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
    const { Pool } = await importOptionalPg();

    // Initialize PostgreSQL pool
    const poolConfig: PoolConfig = {
      connectionString: this.config.database!.connectionString,
      max: this.config.database!.pool.max,
      idleTimeoutMillis: this.config.database!.pool.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.database!.pool.connectionTimeoutMillis,
      statement_timeout: this.config.database!.pool.statementTimeout,
    };

    this.pool = new Pool(poolConfig);

    // Test PostgreSQL connection
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      this.logger.info("PostgreSQL connection established");
    } catch (error) {
      this.logger.error("Failed to connect to PostgreSQL", { error });
      throw new Error(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Graceful shutdown - close all connections
   */
  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting database connections");
    const errors: Error[] = [];

    if (this.pool) {
      try {
        await this.pool.end();
        this.pool = null;
      } catch (error) {
        errors.push(
          new Error(
            `PostgreSQL disconnect error: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
      }
    }

    if (errors.length > 0) {
      throw new Error(`Disconnect errors: ${errors.map(e => e.message).join("; ")}`);
    }
  }

  /**
   * Health check for PostgreSQL.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      postgres: { connected: false, latency: 0 },
    };

    // Check PostgreSQL
    if (this.pool) {
      const pgStart = Date.now();
      let client = null;
      try {
        client = await this.pool.connect();
        await client.query("SELECT 1");
        result.postgres.connected = true;
        result.postgres.latency = Date.now() - pgStart;
      } catch {
        result.postgres.connected = false;
      } finally {
        // Always release the client to prevent connection leaks
        if (client) {
          client.release();
        }
      }
    }

    this.logger.debug("Health check completed", {
      postgres: result.postgres.connected,
    });
    return result;
  }

  /**
   * Get PostgreSQL pool
   */
  getPool(): Pool {
    if (!this.pool) {
      throw new Error("PostgreSQL pool not initialized");
    }
    return this.pool;
  }
}

async function importOptionalPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg");
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
