import { DatabaseConnection } from "./db.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  postgres: { status: "up" | "down"; latency: number };
  redis: { status: "up" | "down"; latency: number };
  timestamp: string;
}

/**
 * Check health status of PostgreSQL and Redis
 * - Both up → healthy
 * - Only PostgreSQL up → degraded (Redis down but DB works)
 * - PostgreSQL down → unhealthy (critical failure)
 */
export async function checkHealth(db: DatabaseConnection): Promise<HealthStatus> {
  const result = await db.healthCheck();

  const health: HealthStatus = {
    status: "unhealthy",
    postgres: {
      status: result.postgres.connected ? "up" : "down",
      latency: result.postgres.latency,
    },
    redis: {
      status: result.redis.connected ? "up" : "down",
      latency: result.redis.latency,
    },
    timestamp: new Date().toISOString(),
  };

  // Determine overall health status
  if (result.postgres.connected && result.redis.connected) {
    health.status = "healthy";
  } else if (result.postgres.connected && !result.redis.connected) {
    health.status = "degraded";
  } else {
    health.status = "unhealthy";
  }

  return health;
}
