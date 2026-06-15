import { PROVIDER_TYPES, type ProviderType } from "./session-manager.js";

export interface ToolMetricsSnapshot {
  requestCount: number;
  successCount: number;
  failureCount: number;
  averageResponseTimeMs: number;
  successRate: number;
  failureRate: number;
}

export interface PerformanceMetricsSnapshot {
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  overallSuccessRate: number;
  overallFailureRate: number;
  byTool: Record<ProviderType, ToolMetricsSnapshot>;
  generatedAt: string;
}

interface ToolMetrics {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalResponseTimeMs: number;
}

const createEmptyMetrics = (): Record<ProviderType, ToolMetrics> =>
  Object.fromEntries(
    PROVIDER_TYPES.map(provider => [
      provider,
      { requestCount: 0, successCount: 0, failureCount: 0, totalResponseTimeMs: 0 },
    ])
  ) as Record<ProviderType, ToolMetrics>;

export class PerformanceMetrics {
  private metrics: Record<ProviderType, ToolMetrics> = createEmptyMetrics();

  recordRequest(provider: ProviderType, durationMs: number, success: boolean): void {
    // Slice 0.5: the known CLI/API providers are pre-populated, but an arbitrary
    // `[providers.<name>]` (kind:"api") id may flow through here once API
    // providers are registered. Lazily create its bucket so the open
    // `ProviderType` never indexes an undefined entry.
    const metrics = (this.metrics[provider] ??= {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      totalResponseTimeMs: 0,
    });
    metrics.requestCount += 1;
    const normalizedDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    metrics.totalResponseTimeMs += normalizedDurationMs;
    if (success) {
      metrics.successCount += 1;
    } else {
      metrics.failureCount += 1;
    }
  }

  snapshot(): PerformanceMetricsSnapshot {
    const byTool = {} as Record<ProviderType, ToolMetricsSnapshot>;
    let totalRequests = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;

    // Iterate the actual recorded keys (the pre-populated registered set plus
    // any lazily-added API providers) rather than only PROVIDER_TYPES, so an
    // arbitrary API provider's metrics are not silently dropped from the snapshot.
    for (const provider of Object.keys(this.metrics) as ProviderType[]) {
      const metrics = this.metrics[provider];
      const averageResponseTimeMs =
        metrics.requestCount > 0 ? metrics.totalResponseTimeMs / metrics.requestCount : 0;
      const successRate =
        metrics.requestCount > 0 ? metrics.successCount / metrics.requestCount : 0;
      const failureRate =
        metrics.requestCount > 0 ? metrics.failureCount / metrics.requestCount : 0;

      byTool[provider] = {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failureCount: metrics.failureCount,
        averageResponseTimeMs,
        successRate,
        failureRate,
      };

      totalRequests += metrics.requestCount;
      totalSuccesses += metrics.successCount;
      totalFailures += metrics.failureCount;
    }

    const overallSuccessRate = totalRequests > 0 ? totalSuccesses / totalRequests : 0;
    const overallFailureRate = totalRequests > 0 ? totalFailures / totalRequests : 0;

    return {
      totalRequests,
      totalSuccesses,
      totalFailures,
      overallSuccessRate,
      overallFailureRate,
      byTool,
      generatedAt: new Date().toISOString(),
    };
  }
}
