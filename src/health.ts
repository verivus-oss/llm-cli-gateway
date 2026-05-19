import { DatabaseConnection } from "./db.js";
import { listProviderRuntimeStatuses, type ProviderRuntimeStatus } from "./provider-status.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  postgres: { status: "up" | "down"; latency: number };
  redis: { status: "up" | "down"; latency: number };
  timestamp: string;
}

export interface ProviderRuntimeHealth {
  status: "healthy" | "degraded" | "unhealthy";
  providers: Record<
    string,
    Pick<ProviderRuntimeStatus, "installed" | "version" | "loginStatus" | "loginCheck">
  >;
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

export function checkProviderRuntimeHealth(): ProviderRuntimeHealth {
  const providers = listProviderRuntimeStatuses();
  const projected = Object.fromEntries(
    Object.entries(providers).map(([name, provider]) => [
      name,
      {
        installed: provider.installed,
        version: provider.version,
        loginStatus: provider.loginStatus,
        loginCheck: provider.loginCheck,
      },
    ])
  );
  const statuses = Object.values(providers);
  const installedCount = statuses.filter(provider => provider.installed).length;
  const authenticatedCount = statuses.filter(
    provider => provider.loginStatus === "authenticated"
  ).length;
  const status =
    installedCount === 0 ? "unhealthy" : authenticatedCount === 0 ? "degraded" : "healthy";

  return {
    status,
    providers: projected,
    timestamp: new Date().toISOString(),
  };
}
