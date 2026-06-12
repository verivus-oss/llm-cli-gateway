/**
 * Phase 4 slice ζ — test-veracity regressions for working-dir + add-dir
 * parity across Claude (`--add-dir`), Codex (`-C` + `--add-dir`), Grok
 * (`--cwd`), and Vibe (`--workdir` + `--add-dir`).
 *
 * Gemini-compatible Antigravity `includeDirs` → `--add-dir` wiring is
 * exercised as a regression guard at the end of REGRESSIONS Zε.
 *
 * Every test below is mutation-probe-friendly; the audit spec at
 * `docs/plans/test-veracity-audit-slice-zeta.spec.md` documents the
 * counterexample mutations each LLM reviewer must run before approving
 * this slice.
 *
 * Probe targets:
 *
 *   P-Zα-1/2/3       — Zod registered-tool inputSchema (sync + async).
 *   P-Zβ-1/2/3/4/5   — prepare*Request argv emission end-to-end +
 *                       Codex resume-filter integration + retry-prep.
 *   P-Zε-1/2/3/4/5   — UPSTREAM_CLI_CONTRACTS flags/fixtures/mcpParameters
 *                       + mechanical fixture validation + Gemini regression
 *                       guard.
 */
import { describe, expect, it } from "vitest";
import {
  buildMistralRetryPrep,
  createGatewayServer,
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGrokRequest,
  prepareMistralRequest,
} from "../index.js";
import { UPSTREAM_CLI_CONTRACTS, validateUpstreamCliArgs } from "../upstream-contracts.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

function makeServerWithAsyncTools(): ReturnType<typeof createGatewayServer> {
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  return createGatewayServer({
    asyncJobManager: manager,
    persistence: {
      backend: "sqlite",
      logsDbPath: ":memory:",
      jobsDbPath: ":memory:",
      jobRetentionDays: 7,
      dedupWindowMs: 0,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    },
  });
}

function getRegisteredToolSchema(toolName: string): {
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
} {
  const server = makeServerWithAsyncTools();
  const registry = (server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>)
    ._registeredTools;
  const tool = registry[toolName];
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  const schema = tool.inputSchema as { _def?: { shape?: () => Record<string, unknown> } };
  const shape = (schema._def?.shape?.() ?? {}) as Record<
    string,
    { safeParse: (v: unknown) => { success: boolean } }
  >;
  return { shape };
}

// ─── REGRESSIONS Zα — registered MCP schemas for new dir-flag fields ────
//
// Falsifiability: reverting any Zod entry on either tool fails the matching
// assertion; dropping `.min(1)` on a workingDir field fails the empty-string
// rejection case.

describe("REGRESSIONS Zα — registered tool addDir / workingDir (slice ζ)", () => {
  // Claude: addDir only (Claude has no working-dir flag).
  it.each(["claude_request", "claude_request_async"])("%s.addDir accepts string[]", name => {
    const { shape } = getRegisteredToolSchema(name);
    const f = shape.addDir;
    expect(f, `${name}.addDir must be registered`).toBeDefined();
    expect(f.safeParse(["/tmp/a", "/tmp/b"]).success).toBe(true);
    expect(f.safeParse([]).success).toBe(true);
  });

  // Codex: workingDir + addDir.
  it.each(["codex_request", "codex_request_async"])(
    "%s.workingDir accepts non-empty string and rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.workingDir;
      expect(f, `${name}.workingDir must be registered`).toBeDefined();
      expect(f.safeParse("/tmp/work").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["codex_request", "codex_request_async"])("%s.addDir accepts string[]", name => {
    const { shape } = getRegisteredToolSchema(name);
    const f = shape.addDir;
    expect(f, `${name}.addDir must be registered`).toBeDefined();
    expect(f.safeParse(["/tmp/a"]).success).toBe(true);
  });

  // Grok: workingDir only (Grok has no --add-dir analogue).
  it.each(["grok_request", "grok_request_async"])(
    "%s.workingDir accepts non-empty string and rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.workingDir;
      expect(f, `${name}.workingDir must be registered`).toBeDefined();
      expect(f.safeParse("/tmp/work").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  // Vibe (Mistral): workingDir + addDir.
  it.each(["mistral_request", "mistral_request_async"])(
    "%s.workingDir accepts non-empty string and rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.workingDir;
      expect(f, `${name}.workingDir must be registered`).toBeDefined();
      expect(f.safeParse("/tmp/work").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["mistral_request", "mistral_request_async"])("%s.addDir accepts string[]", name => {
    const { shape } = getRegisteredToolSchema(name);
    const f = shape.addDir;
    expect(f, `${name}.addDir must be registered`).toBeDefined();
    expect(f.safeParse(["/tmp/a", "/tmp/b"]).success).toBe(true);
  });
});

// ─── REGRESSIONS Zβ — prepare*Request end-to-end argv emission ─────────
//
// Falsifiability: each test inspects the actual argv each prepare*Request
// would spawn. Mutating any helper, prepare-function threading, OR the
// Zod field threading all surface here.

const baseClaudeParams = {
  prompt: "hello",
  outputFormat: "text" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};

const baseCodexParams = {
  prompt: "hello",
  fullAuto: false,
  dangerouslyBypassApprovalsAndSandbox: false,
  approvalStrategy: "legacy" as const,
  createNewSession: false,
  optimizePrompt: false,
  operation: "codex_request",
};

const baseGrokParams = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "grok_request",
};

const baseMistralWrapperParams = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "mistral_request",
};

function adjacentTokenIndex(args: readonly string[], flag: string): number {
  return args.indexOf(flag);
}

function allAdjacentValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

describe("REGRESSIONS Zβ — prepare*Request emit new working-dir / add-dir flags", () => {
  it("prepareClaudeRequest emits ['--add-dir',<dir>] once per entry (repeated instances)", () => {
    const prep = prepareClaudeRequest({
      ...baseClaudeParams,
      addDir: ["/tmp/a", "/tmp/b"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const values = allAdjacentValues(prep.args, "--add-dir");
    expect(values).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("prepareClaudeRequest emits NO --add-dir when addDir is absent", () => {
    const prep = prepareClaudeRequest({ ...baseClaudeParams });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--add-dir");
  });

  it("prepareCodexRequest (new session) emits '-C <dir>' and repeated '--add-dir <each>'", () => {
    const prep = prepareCodexRequest({
      ...baseCodexParams,
      createNewSession: true,
      workingDir: "/tmp/work",
      addDir: ["/tmp/a", "/tmp/b"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const cdIdx = adjacentTokenIndex(prep.args, "-C");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(prep.args[cdIdx + 1]).toBe("/tmp/work");
    expect(allAdjacentValues(prep.args, "--add-dir")).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("prepareCodexRequest (resume) emits NEITHER -C NOR --add-dir", () => {
    // Resume mode: CODEX_RESUME_FILTERED_FLAGS strips -C / --add-dir.
    // The prep function gates emission on `sessionPlan.mode === "new"` so
    // they never appear on resume argv (no wasted strip + clean argv log).
    const prep = prepareCodexRequest({
      ...baseCodexParams,
      createNewSession: false,
      resumeLatest: true,
      workingDir: "/tmp/work",
      addDir: ["/tmp/a"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-C");
    expect(prep.args).not.toContain("--add-dir");
    // sanity: resume argv shape is preserved
    expect(prep.args.slice(0, 3)).toEqual(["exec", "resume", "--last"]);
  });

  it("prepareGrokRequest emits '--cwd <dir>' as adjacent tokens", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, workingDir: "/tmp/work" });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = adjacentTokenIndex(prep.args, "--cwd");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("/tmp/work");
  });

  it("prepareMistralRequest (wrapper) emits '--workdir <dir>' and repeated '--add-dir <each>'", () => {
    const prep = prepareMistralRequest({
      ...baseMistralWrapperParams,
      workingDir: "/tmp/work",
      addDir: ["/tmp/a", "/tmp/b"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const wdIdx = adjacentTokenIndex(prep.args, "--workdir");
    expect(wdIdx).toBeGreaterThan(-1);
    expect(prep.args[wdIdx + 1]).toBe("/tmp/work");
    expect(allAdjacentValues(prep.args, "--add-dir")).toEqual(["/tmp/a", "/tmp/b"]);
  });

  // Retry-path invariant from slice δ post-mortem: every param the wrapper
  // threads into the FIRST buildMistralCliInvocation call MUST also be
  // threaded through buildMistralRetryPrep, or a fresh-workspace /
  // budgeted run can degrade on the stale-model recovery retry.
  it("buildMistralRetryPrep threads workingDir + addDir through to the retry argv", () => {
    const retryPrep = buildMistralRetryPrep(
      {
        effectivePrompt: "hello",
        outputFormat: "json",
        permissionMode: "auto-approve",
        approvalStrategy: "legacy",
        workingDir: "/tmp/work",
        addDir: ["/tmp/a"],
      },
      "mistral-medium-3.5"
    );
    const wdIdx = adjacentTokenIndex(retryPrep.args, "--workdir");
    expect(wdIdx, "buildMistralRetryPrep must emit --workdir").toBeGreaterThan(-1);
    expect(retryPrep.args[wdIdx + 1]).toBe("/tmp/work");
    expect(allAdjacentValues(retryPrep.args, "--add-dir")).toEqual(["/tmp/a"]);
  });

  // REGRESSIONS D-style end-to-end: prepare → contract consistency for
  // every new flag. Closes the contract-table gap class that bit slices
  // α/γ/δ — i.e. a Zod field added without a contract entry.
  it("argv from prepareClaudeRequest({addDir}) passes validateUpstreamCliArgs", () => {
    const prep = prepareClaudeRequest({
      ...baseClaudeParams,
      addDir: ["/tmp/a", "/tmp/b"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("claude", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("argv from prepareCodexRequest({workingDir,addDir}) passes validateUpstreamCliArgs (new session)", () => {
    const prep = prepareCodexRequest({
      ...baseCodexParams,
      createNewSession: true,
      workingDir: "/tmp/work",
      addDir: ["/tmp/a"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("codex", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("argv from prepareGrokRequest({workingDir}) passes validateUpstreamCliArgs", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, workingDir: "/tmp/work" });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("grok", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("argv from prepareMistralRequest({workingDir,addDir}) passes validateUpstreamCliArgs", () => {
    const prep = prepareMistralRequest({
      ...baseMistralWrapperParams,
      workingDir: "/tmp/work",
      addDir: ["/tmp/a", "/tmp/b"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("mistral", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});

// ─── REGRESSIONS Zε — UPSTREAM_CLI_CONTRACTS introspection + fixtures ──
//
// Falsifiability: removing any flag from contract.flags fails the matching
// introspection + the mechanical-fixture validation in the same it() block.
// The Gemini regression-guard at the end catches an accidental break of
// pre-existing wiring while touching adjacent code.

describe("REGRESSIONS Zε — slice ζ contract entries + fixtures", () => {
  // Claude.
  it("validateUpstreamCliArgs accepts repeated ['-p','x','--add-dir','/a','--add-dir','/b']", () => {
    const validation = validateUpstreamCliArgs("claude", [
      "-p",
      "x",
      "--add-dir",
      "/tmp/a",
      "--add-dir",
      "/tmp/b",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs rejects ['-p','x','--add-dir'] (missing required value)", () => {
    const validation = validateUpstreamCliArgs("claude", ["-p", "x", "--add-dir"]);
    expect(validation.ok).toBe(false);
  });

  // Codex.
  it("validateUpstreamCliArgs accepts codex new-session argv with -C + --add-dir", () => {
    const validation = validateUpstreamCliArgs("codex", [
      "exec",
      "--skip-git-repo-check",
      "-C",
      "/tmp/work",
      "--add-dir",
      "/tmp/a",
      "hello",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  // Grok.
  it("validateUpstreamCliArgs accepts ['-p','x','--cwd','/tmp/work']", () => {
    const validation = validateUpstreamCliArgs("grok", ["-p", "x", "--cwd", "/tmp/work"]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  // Vibe.
  it("validateUpstreamCliArgs accepts vibe argv with --workdir + repeated --add-dir", () => {
    const validation = validateUpstreamCliArgs("mistral", [
      "-p",
      "x",
      "--agent",
      "auto-approve",
      "--workdir",
      "/tmp/work",
      "--add-dir",
      "/tmp/a",
      "--add-dir",
      "/tmp/b",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("contract introspection: all 6 new dir-flag entries are arity:'one'", () => {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["claude", "--add-dir"],
      ["codex", "-C"],
      ["codex", "--add-dir"],
      ["grok", "--cwd"],
      ["mistral", "--workdir"],
      ["mistral", "--add-dir"],
    ];
    for (const [cli, flag] of entries) {
      const f = UPSTREAM_CLI_CONTRACTS[cli as keyof typeof UPSTREAM_CLI_CONTRACTS].flags[flag];
      expect(f, `${cli}.flags["${flag}"] must be registered`).toBeDefined();
      expect(f.arity).toBe("one");
    }
  });

  it("contract introspection: mcpParameters contain all new param names", () => {
    const claudeParams = UPSTREAM_CLI_CONTRACTS.claude.mcpParameters;
    const codexParams = UPSTREAM_CLI_CONTRACTS.codex.mcpParameters;
    const grokParams = UPSTREAM_CLI_CONTRACTS.grok.mcpParameters;
    const mistralParams = UPSTREAM_CLI_CONTRACTS.mistral.mcpParameters;
    expect(claudeParams).toContain("addDir");
    expect(codexParams).toContain("workingDir");
    expect(codexParams).toContain("addDir");
    expect(grokParams).toContain("workingDir");
    expect(mistralParams).toContain("workingDir");
    expect(mistralParams).toContain("addDir");
  });

  // Eε-pattern: fixture presence is necessary but NOT sufficient — each new
  // fixture must mechanically validate against the contract inside the same
  // it() block. Catches the slice-ε round-1 gap class.
  const newFixtures: ReadonlyArray<{ cli: keyof typeof UPSTREAM_CLI_CONTRACTS; id: string }> = [
    { cli: "claude", id: "claude-add-dir" },
    { cli: "codex", id: "codex-working-dir" },
    { cli: "codex", id: "codex-add-dir" },
    { cli: "grok", id: "grok-working-dir" },
    { cli: "mistral", id: "mistral-working-dir" },
    { cli: "mistral", id: "mistral-add-dir" },
  ];

  it.each(newFixtures)(
    "$cli fixture '$id' exists AND mechanically validates against its CLI's contract",
    ({ cli, id }) => {
      const fixture = UPSTREAM_CLI_CONTRACTS[cli].conformanceFixtures.find(f => f.id === id);
      expect(fixture, `${cli} fixture '${id}' must be registered`).toBeDefined();
      expect(fixture?.expect).toBe("pass");
      const validation = validateUpstreamCliArgs(cli, fixture?.args as readonly string[]);
      expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
    }
  );

  // Regression guard: the Gemini-compatible Antigravity path maps includeDirs
  // to agy's --add-dir flag.
  it("regression guard: gemini includeDirs / agy --add-dir still wired", () => {
    expect(UPSTREAM_CLI_CONTRACTS.gemini.mcpParameters).toContain("includeDirs");
    const flag = UPSTREAM_CLI_CONTRACTS.gemini.flags["--add-dir"];
    expect(flag, "gemini.flags['--add-dir'] must be registered").toBeDefined();
    expect(flag.arity).toBe("one");
    const validation = validateUpstreamCliArgs("gemini", ["--print", "x", "--add-dir", "/tmp/a"]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});
