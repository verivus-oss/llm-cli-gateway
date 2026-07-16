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

  it("workspace tools are described as remote-only and not a stdio path-access fallback", async () => {
    const server = await makeServer(true);
    const registry = (server as unknown as Record<string, Record<string, { description?: string }>>)
      ._registeredTools;

    for (const name of [
      "workspace_list",
      "workspace_get",
      "workspace_create",
      "workspace_register_existing_repo",
    ]) {
      const desc = registry[name].description ?? "";
      expect(desc, `${name} must say it is for remote workspaces`).toMatch(/remote HTTP\/OAuth/i);
      expect(desc, `${name} must warn stdio callers away`).toMatch(/stdio\/local/i);
      expect(desc, `${name} must not be a path-access repair tool`).toMatch(/not|do not/i);
    }
  });

  it("provider path fields warn stdio callers not to use workspace tools as a fallback", async () => {
    const server = await makeServer(true);
    const registry = (
      server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>
    )._registeredTools;
    const shapeFor = (
      name: string
    ): Record<string, { _def?: { description?: string; innerType?: unknown } }> => {
      const schema = registry[name].inputSchema as {
        _def?: { shape?: () => Record<string, unknown> };
      };
      return (schema._def?.shape?.() ?? {}) as Record<
        string,
        { _def?: { description?: string; innerType?: unknown } }
      >;
    };

    for (const [toolName, fieldName] of [
      ["claude_request", "addDir"],
      ["claude_request_async", "addDir"],
      ["codex_request", "workingDir"],
      ["codex_request", "addDir"],
      ["codex_request_async", "workingDir"],
      ["codex_request_async", "addDir"],
      ["gemini_request", "includeDirs"],
      ["gemini_request_async", "includeDirs"],
      ["grok_request_async", "workingDir"],
      ["mistral_request", "workingDir"],
      ["mistral_request", "addDir"],
      ["mistral_request_async", "workingDir"],
      ["mistral_request_async", "addDir"],
    ]) {
      const desc = shapeFor(toolName)[fieldName]?._def?.description ?? "";
      expect(desc, `${toolName}.${fieldName} must mention stdio/local`).toMatch(/stdio\/local/i);
      expect(desc, `${toolName}.${fieldName} must reject workspace fallback`).toMatch(
        /do not call workspace_\*/i
      );
    }

    for (const toolName of [
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
    ]) {
      const desc = shapeFor(toolName).workspace?._def?.description ?? "";
      expect(desc, `${toolName}.workspace must be remote-only`).toMatch(/remote HTTP\/OAuth/i);
      expect(desc, `${toolName}.workspace must warn stdio callers away`).toMatch(/stdio\/local/i);
      expect(desc, `${toolName}.workspace must reject workspace fallback`).toMatch(
        /do not use this field/i
      );
    }
  });

  it("pins complete Codex and Claude native-continuation target semantics", async () => {
    const server = await makeServer(true);
    const registry = (
      server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>
    )._registeredTools;
    const descriptionFor = (toolName: string, fieldName: string): string => {
      const schema = registry[toolName].inputSchema as {
        _def?: { shape?: () => Record<string, unknown> };
      };
      const shape = (schema._def?.shape?.() ?? {}) as Record<
        string,
        { _def?: { description?: string } }
      >;
      return shape[fieldName]?._def?.description ?? "";
    };

    for (const toolName of ["codex_request", "codex_request_async"]) {
      const description = descriptionFor(toolName, "resumeLatest");
      expect(description, `${toolName}.resumeLatest must identify the global selector`).toMatch(
        /globally latest/i
      );
      expect(description, `${toolName}.resumeLatest must preserve the original cwd`).toMatch(
        /inherits that session's original cwd/i
      );
      expect(description, `${toolName}.resumeLatest must reject path retargeting claims`).toMatch(
        /workingDir\/addDir do not retarget it/i
      );
      expect(description, `${toolName}.resumeLatest must explain explicit UUID targeting`).toMatch(
        /explicit real Codex UUID targets that session/i
      );
    }

    for (const toolName of ["claude_request", "claude_request_async"]) {
      const description = descriptionFor(toolName, "continueSession");
      expect(description, `${toolName}.continueSession must require stable selection`).toMatch(
        /stable workspace selection is required/i
      );
      expect(description, `${toolName}.continueSession must name workingDir`).toMatch(/workingDir/);
      expect(description, `${toolName}.continueSession must name registered workspace`).toMatch(
        /registered workspace/i
      );
      expect(description, `${toolName}.continueSession must name configured default`).toMatch(
        /configured default workspace/i
      );
    }
  });

  it("pins the gateway-owned worktree materialization side-effect boundary", async () => {
    const server = await makeServer(true);
    const registry = (
      server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>
    )._registeredTools;

    for (const toolName of [
      "claude_request",
      "claude_request_async",
      "codex_request",
      "codex_request_async",
      "gemini_request",
      "gemini_request_async",
      "grok_request",
      "grok_request_async",
      "mistral_request",
      "mistral_request_async",
      "devin_request",
      "devin_request_async",
    ]) {
      const schema = registry[toolName].inputSchema as {
        _def?: { shape?: () => Record<string, unknown> };
      };
      const shape = (schema._def?.shape?.() ?? {}) as Record<
        string,
        { _def?: { description?: string } }
      >;
      const description = shape.worktree?._def?.description ?? "";

      expect(description, `${toolName}.worktree must pin hook suppression`).toMatch(
        /repository, system, and global Git hooks/i
      );
      expect(description, `${toolName}.worktree must pin checkout filter suppression`).toMatch(
        /clean, smudge, and process checkout filters/i
      );
      expect(description, `${toolName}.worktree must explain Git LFS representation`).toMatch(
        /Git LFS remains in its repository representation/i
      );
      expect(description, `${toolName}.worktree must reject host-command execution claims`).toMatch(
        /instead of executing host commands/i
      );
    }
  });

  it("server instructions advertise async/job tools only when they are registered", () => {
    const withAsync = buildServerInstructions(true);
    expect(withAsync).toContain("*_request_async");
    expect(withAsync).toContain("llm_job_status");
    expect(withAsync).toContain("llm_job_watch");
    expect(withAsync).toContain("review_changes");
    expect(withAsync).toContain("auto-defers");
    expect(withAsync).toContain("do not use workspace_*");
    expect(withAsync).toContain("Stdio/local provider calls may pass local workingDir");
    expect(withAsync).toContain("Codex new and resume prompts use stdin.");
    expect(withAsync).toContain("codex_fork_session remains argv-bound");
    expect(withAsync).not.toContain("Codex prompts use stdin.");
    expect(withAsync).not.toContain("${SYNC_DEADLINE_MS}"); // interpolation regression guard

    const withoutAsync = buildServerInstructions(false);
    // The "(async)" advertisement must be gone; the DISABLED note may still
    // NAME the tools to explain that they are not registered.
    expect(withoutAsync).not.toContain("*_request_async (async)");
    expect(withoutAsync).toContain("not registered");
    expect(withoutAsync).not.toContain("Jobs: llm_job_status");
    expect(withoutAsync).not.toContain("review_changes");
    expect(withoutAsync).toContain("DISABLED");
    expect(withoutAsync).toContain("no auto-deferral");
  });

  it("does not advertise validation tools when Kit mode leaves them unregistered", () => {
    const kitInstructions = buildServerInstructions(true, false, false);
    expect(kitInstructions).toContain("validation tools are not registered");
    expect(kitInstructions).not.toContain("validate_with_models");
    expect(kitInstructions).not.toContain("second_opinion");
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
      "llm_job_watch",
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
    expect(names.length).toBeGreaterThanOrEqual(44); /* exact toBe(44) asserted below */
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
    expect(names.length).toBe(61);
    const setOf = (pred: (a: NonNullable<(typeof registry)[string]["annotations"]>) => boolean) =>
      names.filter(n => pred(registry[n].annotations!)).sort();
    expect(setOf(a => a.readOnlyHint === true)).toEqual(
      [
        "approval_list",
        "cli_versions",
        "compare_answers",
        "config_status",
        "job_result",
        "job_status",
        "list_available_models",
        "list_models",
        "llm_job_result",
        "llm_job_status",
        "llm_job_watch",
        "llm_process_health",
        "llm_request_result",
        "explain_effective_config",
        "provider_tool_capabilities",
        "provider_subcommand_contract",
        "provider_subcommand_drift",
        "provider_subcommands_list",
        "provider_admin_list",
        "provider_admin_run",
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
        "cursor_request",
        "cursor_request_async",
        "devin_request",
        "devin_request_async",
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
        // provider-spawning (19)
        "claude_request",
        "claude_request_async",
        "codex_request",
        "codex_request_async",
        "codex_fork_session",
        "cursor_request",
        "cursor_request_async",
        "devin_request",
        "devin_request_async",
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
        "config_init",
        "config_recover_kit_attempt",
        "llm_job_cancel",
        "session_delete",
        "session_clear_all",
        "workspace_create",
        // provider admin mutating (1)
        "provider_admin_mutate",
      ].sort()
    );
  });
});
