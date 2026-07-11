import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager } from "../session-manager.js";
import { defaultLeastCostConfig, type LeastCostConfig, type PersistenceConfig } from "../config.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// Phase_1 route_request / route_request_async: registration gating (dormant by
// default) and the fail-closed routing block. The fail-closed paths short-circuit
// BEFORE any CLI is spawned (budget / unpriced rejection), so they need no
// provider binaries.

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15000,
    instanceLeaseTtlMs: 90000,
    httpJobGraceMs: 300000,
    orphanSweepIntervalMs: 30000,
    instanceGcMs: 3600000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function ctx(): GatewayRequestContext {
  return { transport: "stdio", authScopes: [] };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

describe("route_request / route_request_async registration + fail-closed", () => {
  let tmp: string;
  let sessions: FileSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "route-tools-"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeServer(leastCost: LeastCostConfig) {
    return createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      flightRecorder: new NoopFlightRecorder(),
      leastCost,
    });
  }

  function tools(server: ReturnType<typeof createGatewayServer>): Record<string, RegisteredTool> {
    return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
  }

  async function call(
    server: ReturnType<typeof createGatewayServer>,
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    text: string;
    isError?: boolean;
    routing?: Record<string, unknown>;
  }> {
    const reg = tools(server);
    const result = await runWithRequestContext(ctx(), () => reg[name].handler(args, {}));
    const routing = (result.structuredContent?.routing ?? undefined) as
      Record<string, unknown> | undefined;
    return { text: result.content[0]?.text ?? "", isError: result.isError, routing };
  }

  it("does NOT register the route tools when [least_cost].enabled is false (dormant)", () => {
    const server = makeServer(defaultLeastCostConfig());
    const reg = tools(server);
    expect(reg.route_request).toBeUndefined();
    expect(reg.route_request_async).toBeUndefined();
  });

  it("registers both route tools when enabled (async under the async gate)", () => {
    const server = makeServer({ ...defaultLeastCostConfig(), enabled: true });
    const reg = tools(server);
    expect(reg.route_request).toBeDefined();
    expect(reg.route_request_async).toBeDefined();
    // A direct per-provider tool is untouched by LCR.
    expect(reg.claude_request).toBeDefined();
  });

  it("fails closed with a routing block when nothing fits an impossibly low budget", async () => {
    const server = makeServer({ ...defaultLeastCostConfig(), enabled: true });
    const res = await call(server, "route_request", { prompt: "hello", maxCostUsd: 1e-9 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/\[routing\]/);
    expect(res.text).toMatch(/budget/i);
    expect(res.routing).toBeDefined();
    expect(res.routing?.error).toBe("BudgetExceeded");
  });

  it("fails closed (NoEligibleCandidate) for an explicit unpriced candidate without allowUnpriced", async () => {
    const server = makeServer({ ...defaultLeastCostConfig(), enabled: true });
    const res = await call(server, "route_request", {
      prompt: "hello",
      candidates: [{ provider: "claude", model: "no-such-model-xyz" }],
    });
    expect(res.isError).toBe(true);
    expect(res.routing?.error).toBe("NoEligibleCandidate");
    // The rejection names the unpriced reason.
    expect(res.text).toMatch(/unpriced|no eligible/i);
  });

  it("routing block reports considered candidates and the rejection list", async () => {
    const server = makeServer({ ...defaultLeastCostConfig(), enabled: true });
    const res = await call(server, "route_request", { prompt: "hi", maxCostUsd: 1e-9 });
    expect(res.routing).toBeDefined();
    expect(typeof res.routing?.consideredCount).toBe("number");
    expect(Array.isArray(res.routing?.rejected)).toBe(true);
  });
});
