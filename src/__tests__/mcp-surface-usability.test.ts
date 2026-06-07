import { describe, expect, it } from "vitest";
import { buildServerInstructions, createGatewayServer } from "../index.js";
import type { PersistenceConfig } from "../config.js";

async function makeServer(asyncJobsEnabled: boolean) {
  const { AsyncJobManager } = await import("../async-job-manager.js");
  const { MemoryJobStore } = await import("../job-store.js");
  const { noopLogger } = await import("../logger.js");
  const manager = new AsyncJobManager(
    noopLogger,
    undefined,
    asyncJobsEnabled ? new MemoryJobStore() : undefined
  );
  const persistence: PersistenceConfig = asyncJobsEnabled
    ? {
        backend: "sqlite",
        logsDbPath: ":memory:",
        jobsDbPath: ":memory:",
        jobRetentionDays: 7,
        dedupWindowMs: 0,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      }
    : {
        backend: "none",
        logsDbPath: ":memory:",
        jobsDbPath: ":memory:",
        jobRetentionDays: 7,
        dedupWindowMs: 0,
        asyncJobsEnabled: false,
        sources: { configFile: null, envOverrides: [] },
      };
  return createGatewayServer({ asyncJobManager: manager, persistence });
}

describe("MCP tool-surface usability (post-usability-review regressions)", () => {
  it("every registered tool carries a clear description (>= 20 chars, per .cursorrules)", async () => {
    const server = await makeServer(true);
    const registry = (server as unknown as Record<string, Record<string, { description?: string }>>)
      ._registeredTools;
    const names = Object.keys(registry);
    expect(names.length).toBeGreaterThanOrEqual(37);
    for (const name of names) {
      const desc = registry[name].description ?? "";
      expect(desc.length, `${name} description present and >= 20 chars`).toBeGreaterThanOrEqual(20);
    }
  });

  it("job_status/job_result descriptions disambiguate from llm_job_* (validation vs provider jobs)", async () => {
    const server = await makeServer(true);
    const registry = (server as unknown as Record<string, Record<string, { description?: string }>>)
      ._registeredTools;
    expect(registry["job_status"].description).toMatch(/VALIDATION/);
    expect(registry["job_status"].description).toMatch(/llm_job_status/);
    expect(registry["job_result"].description).toMatch(/VALIDATION/);
    expect(registry["job_result"].description).toMatch(/llm_job_result/);
    expect(registry["compare_answers"].description).toMatch(/does not call any provider/i);
  });

  it("server instructions advertise async/job tools only when they are registered", () => {
    const withAsync = buildServerInstructions(true);
    expect(withAsync).toContain("*_request_async");
    expect(withAsync).toContain("llm_job_status");
    expect(withAsync).toContain("auto-defers");
    expect(withAsync).not.toContain("${SYNC_DEADLINE_MS}"); // interpolation regression guard

    const withoutAsync = buildServerInstructions(false);
    // The "(async)" advertisement must be gone; the DISABLED note may still
    // NAME the tools to explain that they are not registered.
    expect(withoutAsync).not.toContain("*_request_async (async)");
    expect(withoutAsync).toContain("not registered");
    expect(withoutAsync).not.toContain("Jobs: llm_job_status");
    expect(withoutAsync).toContain("DISABLED");
    expect(withoutAsync).toContain("no auto-deferral");
  });

  it("backend=none registers no async/job tools (structural invariant, client-visible)", async () => {
    const server = await makeServer(false);
    const registry = (server as unknown as Record<string, Record<string, unknown>>)
      ._registeredTools;
    for (const absent of [
      "claude_request_async",
      "codex_request_async",
      "gemini_request_async",
      "grok_request_async",
      "mistral_request_async",
      "llm_job_status",
      "llm_job_result",
      "llm_job_cancel",
    ]) {
      expect(registry[absent], `${absent} must NOT be registered on backend=none`).toBeUndefined();
    }
  });
});
