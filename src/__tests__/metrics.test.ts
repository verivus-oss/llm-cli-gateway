import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PerformanceMetrics } from "../metrics.js";
import { ResourceProvider } from "../resources.js";
import { SessionManager } from "../session-manager.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("PerformanceMetrics", () => {
  it("should start with zeroed metrics", () => {
    const metrics = new PerformanceMetrics();
    const snapshot = metrics.snapshot();

    expect(snapshot.totalRequests).toBe(0);
    expect(snapshot.totalSuccesses).toBe(0);
    expect(snapshot.totalFailures).toBe(0);
    expect(snapshot.byTool.claude.requestCount).toBe(0);
    expect(snapshot.byTool.codex.requestCount).toBe(0);
    expect(snapshot.byTool.gemini.requestCount).toBe(0);
    expect(snapshot.byTool.claude.averageResponseTimeMs).toBe(0);
    expect(snapshot.byTool.claude.successRate).toBe(0);
    expect(snapshot.byTool.claude.failureRate).toBe(0);
  });

  it("should track counts, averages, and rates per tool", () => {
    const metrics = new PerformanceMetrics();
    metrics.recordRequest("claude", 100, true);
    metrics.recordRequest("claude", 300, false);
    metrics.recordRequest("codex", 200, true);

    const snapshot = metrics.snapshot();

    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.totalSuccesses).toBe(2);
    expect(snapshot.totalFailures).toBe(1);
    expect(snapshot.byTool.claude.requestCount).toBe(2);
    expect(snapshot.byTool.claude.successCount).toBe(1);
    expect(snapshot.byTool.claude.failureCount).toBe(1);
    expect(snapshot.byTool.claude.averageResponseTimeMs).toBe(200);
    expect(snapshot.byTool.claude.successRate).toBeCloseTo(0.5);
    expect(snapshot.byTool.claude.failureRate).toBeCloseTo(0.5);
    expect(snapshot.byTool.codex.requestCount).toBe(1);
    expect(snapshot.byTool.codex.averageResponseTimeMs).toBe(200);
    expect(snapshot.byTool.gemini.requestCount).toBe(0);
  });

  it("should treat invalid durations as zero", () => {
    const metrics = new PerformanceMetrics();
    metrics.recordRequest("claude", Number.NaN, true);
    metrics.recordRequest("claude", Number.POSITIVE_INFINITY, false);
    metrics.recordRequest("claude", -50, true);

    const snapshot = metrics.snapshot();

    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.totalSuccesses).toBe(2);
    expect(snapshot.totalFailures).toBe(1);
    expect(snapshot.byTool.claude.requestCount).toBe(3);
    expect(snapshot.byTool.claude.averageResponseTimeMs).toBe(0);
  });
});

describe("ResourceProvider performance metrics resource", () => {
  let testDir: string;
  let sessionManager: SessionManager;
  let metrics: PerformanceMetrics;
  let resourceProvider: ResourceProvider;

  beforeEach(() => {
    testDir = join(tmpdir(), `metrics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    sessionManager = new SessionManager(join(testDir, "sessions.json"));
    metrics = new PerformanceMetrics();
    resourceProvider = new ResourceProvider(sessionManager, metrics);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should list the performance metrics resource", () => {
    const resources = resourceProvider.listResources();
    expect(resources.some(resource => resource.uri === "metrics://performance")).toBe(true);
  });

  it("should expose performance metrics as a resource", () => {
    metrics.recordRequest("gemini", 250, true);

    const resource = resourceProvider.readResource("metrics://performance");
    expect(resource).not.toBeNull();

    const parsed = JSON.parse(resource?.text || "{}");
    expect(parsed.totalRequests).toBe(1);
    expect(parsed.byTool.gemini.requestCount).toBe(1);
    expect(parsed.byTool.gemini.averageResponseTimeMs).toBe(250);
  });
});
