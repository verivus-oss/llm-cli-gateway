import { Pool, PoolConfig } from "pg";
import { Redis, type RedisOptions } from "ioredis";
import { Config } from "./config.js";

export interface HealthCheckResult {
  postgres: { connected: boolean; latency: number };
  redis: { connected: boolean; latency: number };
}

/**
 * Database connection manager for PostgreSQL and Redis
 */
export class DatabaseConnection {
  private pool: Pool | null = null;
  private redis: Redis | null = null;
  private config: Config;

  constructor(config: Config) {
    if (!config.database || !config.redis) {
      throw new Error("Database and Redis configuration required");
    }
    this.config = config;
  }

  /**
   * Initialize connections to PostgreSQL and Redis
   */
  async connect(): Promise<void> {
    // Initialize PostgreSQL pool
    const poolConfig: PoolConfig = {
      connectionString: this.config.database!.connectionString,
      max: this.config.database!.pool.max,
      idleTimeoutMillis: this.config.database!.pool.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.database!.pool.connectionTimeoutMillis,
      statement_timeout: this.config.database!.pool.statementTimeout
    };

    this.pool = new Pool(poolConfig);

    // Test PostgreSQL connection
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
    } catch (error) {
      throw new Error(`Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Initialize Redis client
    const redisOptions: RedisOptions = {
      retryStrategy: (times: number): number | null => {
        const { maxRetries, initialDelay, maxDelay } = this.config.redis!.retryStrategy;
        if (times > maxRetries) {
          return null; // Stop retrying
        }
        return Math.min(initialDelay * times, maxDelay);
      },
      lazyConnect: false,
      reconnectOnError: (err: Error): boolean | 1 | 2 => {
        // Reconnect on READONLY and ECONNRESET errors
        const targetErrors = ["READONLY", "ECONNRESET"];
        return targetErrors.some(targetError => err.message.includes(targetError));
      }
    };

    this.redis = new Redis(this.config.redis!.url, redisOptions);

    // Test Redis connection
    try {
      await this.redis.ping();
    } catch (error) {
      throw new Error(`Failed to connect to Redis: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Graceful shutdown - close all connections
   */
  async disconnect(): Promise<void> {
    const errors: Error[] = [];

    if (this.pool) {
      try {
        await this.pool.end();
        this.pool = null;
      } catch (error) {
        errors.push(new Error(`PostgreSQL disconnect error: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    if (this.redis) {
      try {
        this.redis.disconnect();
        this.redis = null;
      } catch (error) {
        errors.push(new Error(`Redis disconnect error: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    if (errors.length > 0) {
      throw new Error(`Disconnect errors: ${errors.map(e => e.message).join("; ")}`);
    }
  }

  /**
   * Health check for PostgreSQL and Redis
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      postgres: { connected: false, latency: 0 },
      redis: { connected: false, latency: 0 }
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
      } catch (error) {
        result.postgres.connected = false;
      } finally {
        // Always release the client to prevent connection leaks
        if (client) {
          client.release();
        }
      }
    }

    // Check Redis
    if (this.redis) {
      const redisStart = Date.now();
      try {
        await this.redis.ping();
        result.redis.connected = true;
        result.redis.latency = Date.now() - redisStart;
      } catch (error) {
        result.redis.connected = false;
      }
    }

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

  /**
   * Get Redis client
   */
  getRedis(): Redis {
    if (!this.redis) {
      throw new Error("Redis client not initialized");
    }
    return this.redis;
  }
}

/**
 * Factory function to create and connect DatabaseConnection
 */
export async function createDatabaseConnection(config: Config): Promise<DatabaseConnection> {
  const db = new DatabaseConnection(config);
  await db.connect();
  return db;
}
