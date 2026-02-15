import { z } from "zod";

// Zod schemas for configuration validation
const DatabaseUrlSchema = z.string().url().startsWith("postgresql://");
const RedisUrlSchema = z.string().url().startsWith("redis://");

export interface CacheTtl {
  session: number;
  activeSession: number;
  sessionList: number;
}

export interface DatabaseConfig {
  connectionString: string;
  pool: {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    statementTimeout: number;
  };
}

export interface RedisConfig {
  url: string;
  retryStrategy: {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
  };
}

export interface Config {
  database?: DatabaseConfig;
  redis?: RedisConfig;
  cacheTtl: CacheTtl;
  sessionTtl: number; // Session expiration in seconds
}

/**
 * Load configuration from environment variables
 * @returns Config object or undefined if database config not present
 */
export function loadConfig(): Config | undefined {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;

  // Default cache TTLs
  const cacheTtl: CacheTtl = {
    session: 3600, // 1 hour
    activeSession: 1800, // 30 minutes
    sessionList: 120 // 2 minutes
  };

  const sessionTtl = parseInt(process.env.SESSION_TTL || "2592000", 10); // 30 days default

  // If no database config, return undefined (will use file-based storage)
  if (!databaseUrl || !redisUrl) {
    return undefined;
  }

  // Validate URLs
  try {
    DatabaseUrlSchema.parse(databaseUrl);
    RedisUrlSchema.parse(redisUrl);
  } catch (error) {
    throw new Error(`Invalid database or redis URL: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    database: {
      connectionString: databaseUrl,
      pool: {
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statementTimeout: 10000
      }
    },
    redis: {
      url: redisUrl,
      retryStrategy: {
        maxRetries: 3,
        initialDelay: 50,
        maxDelay: 2000
      }
    },
    cacheTtl,
    sessionTtl
  };
}
