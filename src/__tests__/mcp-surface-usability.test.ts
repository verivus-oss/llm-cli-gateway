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
    expect(names.length).toBeGreaterThanOrEqual(40);
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

  it("every tool carries annotations: title + behavioural hints (2.3.0 slice)", async () => {
    const server = await makeServer(true);
    const registry = (
      server as unknown as Record<
        string,
        Record<
          string,
          {
            annotations?: {
              title?: string;
              readOnlyHint?: boolean;
              destructiveHint?: boolean;
              idempotentHint?: boolean;
              openWorldHint?: boolean;
            };
          }
        >
      >
    )._registeredTools;
    const names = Object.keys(registry);
    expect(names.length).toBeGreaterThanOrEqual(44) /* exact toBe(44) asserted below */;
    for (const name of names) {
      const ann = registry[name].annotations;
      expect(ann, `${name} has annotations`).toBeDefined();
      expect((ann?.title ?? "").length, `${name} has a display title`).toBeGreaterThan(2);
      // a tool cannot be both read-only and destructive
      expect(
        ann?.readOnlyHint === true && ann?.destructiveHint === true,
        `${name} readOnly+destructive contradiction`
      ).toBe(false);
    }
    // EXACT set pinning (post-2.3.0-gate Codex finding): derive the actual
    // sets from the registry and compare them exactly — positive membership
    // alone would let a future mis-classified or unlisted tool slip through.
    expect(names.length).toBe(44);
    const setOf = (pred: (a: NonNullable<(typeof registry)[string]["annotations"]>) => boolean) =>
      names.filter(n => pred(registry[n].annotations!)).sort();
    expect(setOf(a => a.readOnlyHint === true)).toEqual(
      [
        "approval_list",
        "cli_versions",
        "compare_answers",
        "job_result",
        "job_status",
        "list_available_models",
        "list_models",
        "llm_job_result",
        "llm_job_status",
        "llm_process_health",
        "llm_request_result",
        "provider_subcommand_contract",
        "provider_subcommand_drift",
        "provider_subcommands_list",
        "session_get",
        "session_list",
        "upstream_contracts",
        "workspace_get",
        "workspace_list",
      ].sort()
    );
    expect(setOf(a => a.openWorldHint === true)).toEqual(
      [
        "claude_request",
        "claude_request_async",
        "codex_request",
        "codex_request_async",
        "codex_fork_session",
        "gemini_request",
        "gemini_request_async",
        "grok_request",
        "grok_request_async",
        "mistral_request",
        "mistral_request_async",
        "validate_with_models",
        "second_opinion",
        "red_team_review",
        "consensus_check",
        "ask_model",
        "synthesize_validation",
        "cli_upgrade",
      ].sort()
    );
    expect(setOf(a => a.destructiveHint === true)).toEqual(
      [
        // provider-spawning (17)
        "claude_request",
        "claude_request_async",
        "codex_request",
        "codex_request_async",
        "codex_fork_session",
        "gemini_request",
        "gemini_request_async",
        "grok_request",
        "grok_request_async",
        "mistral_request",
        "mistral_request_async",
        "validate_with_models",
        "second_opinion",
        "red_team_review",
        "consensus_check",
        "ask_model",
        "synthesize_validation",
        // gateway-destructive (4)
        "cli_upgrade",
        "llm_job_cancel",
        "session_delete",
        "session_clear_all",
        "workspace_create",
      ].sort()
    );
  });
});
