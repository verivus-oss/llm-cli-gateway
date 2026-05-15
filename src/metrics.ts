import { CLI_TYPES, type CliType } from "./session-manager.js";

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
  byTool: Record<CliType, ToolMetricsSnapshot>;
  generatedAt: string;
}

interface ToolMetrics {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalResponseTimeMs: number;
}

const createEmptyMetrics = (): Record<CliType, ToolMetrics> =>
  Object.fromEntries(
    CLI_TYPES.map(cli => [
      cli,
      { requestCount: 0, successCount: 0, failureCount: 0, totalResponseTimeMs: 0 },
    ])
  ) as Record<CliType, ToolMetrics>;

export class PerformanceMetrics {
  private metrics: Record<CliType, ToolMetrics> = createEmptyMetrics();

  recordRequest(cli: CliType, durationMs: number, success: boolean): void {
    const metrics = this.metrics[cli];
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
    const byTool = {} as Record<CliType, ToolMetricsSnapshot>;
    let totalRequests = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;

    for (const cli of CLI_TYPES) {
      const metrics = this.metrics[cli];
      const averageResponseTimeMs =
        metrics.requestCount > 0 ? metrics.totalResponseTimeMs / metrics.requestCount : 0;
      const successRate =
        metrics.requestCount > 0 ? metrics.successCount / metrics.requestCount : 0;
      const failureRate =
        metrics.requestCount > 0 ? metrics.failureCount / metrics.requestCount : 0;

      byTool[cli] = {
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
