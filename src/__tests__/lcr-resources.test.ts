import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder } from "../flight-recorder.js";
import { ResourceProvider } from "../resources.js";
import { PerformanceMetrics } from "../metrics.js";
import { defaultLeastCostConfig, type LeastCostConfig } from "../config.js";
import { telemetryTierFor } from "../lcr-telemetry.js";
import type { ISessionManager } from "../session-manager.js";

// Minimal session manager stub: the routing:// resources never call into it.
const sessionManagerStub: ISessionManager = {} as ISessionManager;

function enabledLeastCost(): LeastCostConfig {
  return { ...defaultLeastCostConfig(), enabled: true };
}

/** Seed one routed claude row whose prompt carries a marker we must never emit. */
function seedRoutedRow(rec: FlightRecorder): void {
  rec.logStart({
    correlationId: "routed-1",
    cli: "claude",
    model: "claude-sonnet-4-5",
    prompt: "SECRETPROMPT do the thing",
    sessionId: "sess-A",
  });
  rec.logComplete("routed-1", {
    response: "SECRETRESPONSE done",
    durationMs: 1,
    retryCount: 0,
    circuitBreakerState: "closed",
    optimizationApplied: false,
    exitCode: 0,
    status: "completed",
    inputTokens: 120,
    outputTokens: 45,
    costUsd: 0.0021,
    costBasis: "provider-reported",
  });
  rec.recordRouting("routed-1", {
    estCostUsd: 0.0025,
    estConfidence: "high",
    reason: "cheapest-eligible",
    considered: 3,
    reroutes: 0,
  });
}

describe("telemetryTierFor", () => {
  it("assigns the DAG cost-model tier for each of the 7 CLI providers", () => {
    expect(telemetryTierFor("claude")).toBe("T1");
    expect(telemetryTierFor("codex")).toBe("T2");
    expect(telemetryTierFor("gemini")).toBe("T2");
    expect(telemetryTierFor("grok")).toBe("T3");
    expect(telemetryTierFor("mistral")).toBe("T1");
    expect(telemetryTierFor("devin")).toBe("T4");
    expect(telemetryTierFor("cursor")).toBe("T4");
  });

  it("falls back to T2 for API-backed / unknown providers", () => {
    expect(telemetryTierFor("grok-api")).toBe("T2");
    expect(telemetryTierFor("some-openrouter-provider")).toBe("T2");
  });
});

describe("routing:// resources (LCR phase_2)", () => {
  let tmpDir: string;
  let rec: FlightRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcr-res-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
  });

  afterEach(() => {
    rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is dormant by default: neither resource is listed and reads return null", async () => {
    const provider = new ResourceProvider(sessionManagerStub, new PerformanceMetrics(), rec);
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).not.toContain("routing://decisions");
    expect(uris).not.toContain("routing://priors");
    expect(await provider.readResource("routing://decisions")).toBeNull();
    expect(await provider.readResource("routing://priors")).toBeNull();
  });

  it("stays dormant when leastCost is present but disabled", async () => {
    const provider = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      null,
      null,
      undefined,
      null,
      { ...defaultLeastCostConfig(), enabled: false }
    );
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).not.toContain("routing://decisions");
    expect(uris).not.toContain("routing://priors");
    expect(await provider.readResource("routing://decisions")).toBeNull();
    expect(await provider.readResource("routing://priors")).toBeNull();
  });

  it("lists both resources when enabled", () => {
    const provider = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      null,
      null,
      undefined,
      null,
      enabledLeastCost()
    );
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).toContain("routing://decisions");
    expect(uris).toContain("routing://priors");
  });

  it("routing://decisions returns the routed row, redacted (no raw prompt/response)", async () => {
    seedRoutedRow(rec);
    const provider = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      null,
      null,
      undefined,
      null,
      enabledLeastCost()
    );
    const res = await provider.readResource("routing://decisions");
    expect(res).not.toBeNull();
    expect(res!.mimeType).toBe("application/json");
    // No raw prompt/response text leaks.
    expect(res!.text).not.toContain("SECRETPROMPT");
    expect(res!.text).not.toContain("SECRETRESPONSE");

    const payload = JSON.parse(res!.text) as {
      decisions: Array<Record<string, unknown>>;
    };
    expect(payload.decisions).toHaveLength(1);
    const d = payload.decisions[0];
    expect(d.provider).toBe("claude");
    expect(d.model).toBe("claude-sonnet-4-5");
    expect(d.tier).toBe("T1");
    expect(d.estCostUsd).toBeCloseTo(0.0025, 6);
    expect(d.costBasis).toBe("provider-reported");
    expect(d.confidence).toBe("high");
    expect(d.reason).toBe("cheapest-eligible");
    expect(d.considered).toBe(3);
    expect(d.reroutes).toBe(0);
    expect(typeof d.at).toBe("string");
    // Structural redaction: no principal / prompt fields on a decision.
    expect(d.prompt).toBeUndefined();
    expect(d.ownerPrincipal).toBeUndefined();
    expect(d.principal).toBeUndefined();
  });

  it("routing://decisions is empty-but-valid when no routed rows exist", async () => {
    const provider = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      null,
      null,
      undefined,
      null,
      enabledLeastCost()
    );
    const res = await provider.readResource("routing://decisions");
    expect(res).not.toBeNull();
    const payload = JSON.parse(res!.text) as { decisions: unknown[] };
    expect(payload.decisions).toEqual([]);
  });

  it("routing://priors carries priceAsOf and leaks no principal", async () => {
    seedRoutedRow(rec);
    const provider = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      null,
      null,
      undefined,
      null,
      enabledLeastCost()
    );
    const res = await provider.readResource("routing://priors");
    expect(res).not.toBeNull();
    expect(res!.text).not.toContain("SECRETPROMPT");

    const payload = JSON.parse(res!.text) as {
      priceAsOf: { table: string; apiCatalog: string };
      priorsScope: string;
      outputPriors: unknown[];
      calibration: unknown[];
    };
    expect(payload.priceAsOf.table).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.priceAsOf.apiCatalog).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.priorsScope).toBe("global");
    expect(Array.isArray(payload.outputPriors)).toBe(true);
    expect(Array.isArray(payload.calibration)).toBe(true);
    // No principal / owner field anywhere in the serialized payload.
    expect(res!.text).not.toContain("ownerPrincipal");
    expect(res!.text).not.toContain("owner_principal");
  });
});
