/**
 * Phase 4 slice η — test-veracity regressions for Claude `--fallback-model`
 * and `--json-schema`.
 *
 * Mirrors the REGRESSIONS pattern from `test-veracity-regressions.test.ts`
 * and slice ε's slice-epsilon file. Every test below is mutation-probe-
 * friendly; the audit spec at
 * `docs/plans/test-veracity-audit-slice-eta.spec.md` documents the
 * counterexample mutations each LLM reviewer must run before approving
 * this slice.
 *
 * Probe targets:
 *
 *   P-Hα-1/2/3   — Zod registered-tool inputSchema (sync + async).
 *   P-Hβ-1/2/3/4 — prepareClaudeRequest argv emission end-to-end.
 *   P-Hε-1/2/3/4 — UPSTREAM_CLI_CONTRACTS flags/fixtures/mcpParameters
 *                  + mechanical fixture validation.
 */
import { describe, expect, it } from "vitest";
import { createGatewayServer, prepareClaudeRequest } from "../index.js";
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

// ─── REGRESSIONS Hα — registered MCP schemas for fallbackModel + jsonSchema ─
//
// Falsifiability: reverting either Zod entry on either tool fails the
// matching assertion; loosening `jsonSchema` to `z.unknown()` fails the
// rejection cases.
describe("REGRESSIONS Hα — registered tool fallbackModel + jsonSchema (slice η)", () => {
  it.each(["claude_request", "claude_request_async"])(
    "%s.fallbackModel accepts a non-empty string",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.fallbackModel;
      expect(f, `${name}.fallbackModel must be registered`).toBeDefined();
      expect(f.safeParse("claude-haiku-4-5-20251001").success).toBe(true);
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "%s.fallbackModel rejects empty string (bounded by .min(1))",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.fallbackModel;
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "%s rejects empty system-prompt overrides",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      for (const field of ["systemPrompt", "appendSystemPrompt"]) {
        const schema = shape[field];
        expect(schema, `${name}.${field} must be registered`).toBeDefined();
        expect(schema.safeParse("override").success).toBe(true);
        expect(schema.safeParse("").success).toBe(false);
      }
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "%s.jsonSchema accepts both string and object branches",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.jsonSchema;
      expect(f, `${name}.jsonSchema must be registered`).toBeDefined();
      expect(f.safeParse('{"type":"object"}').success).toBe(true);
      expect(f.safeParse({ type: "object" }).success).toBe(true);
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "%s.jsonSchema rejects unrelated types (number, array)",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.jsonSchema;
      expect(f.safeParse(42).success).toBe(false);
      expect(f.safeParse([1, 2, 3]).success).toBe(false);
    }
  );
});

// ─── REGRESSIONS Hβ — prepareClaudeRequest end-to-end argv emission ────
//
// Falsifiability: each test inspects the actual argv prepareClaudeRequest
// would spawn. Mutating the helper, the prepareClaudeRequest threading,
// OR the Zod schemas all surface here.
describe("REGRESSIONS Hβ — prepareClaudeRequest emits --fallback-model + --json-schema", () => {
  const baseParams = {
    prompt: "hello",
    outputFormat: "text" as const,
    dangerouslySkipPermissions: false,
    approvalStrategy: "legacy" as const,
    strictMcpConfig: false,
    optimizePrompt: false,
    operation: "claude_request",
  };

  it("emits ['--fallback-model','<model>'] as adjacent tokens when fallbackModel is set", () => {
    const prep = prepareClaudeRequest({
      ...baseParams,
      fallbackModel: "claude-haiku-4-5-20251001",
    });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--fallback-model");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("emits ['--json-schema','<literal>'] verbatim when jsonSchema is a string", () => {
    const literal = '{"type":"object","properties":{"name":{"type":"string"}}}';
    const prep = prepareClaudeRequest({ ...baseParams, jsonSchema: literal });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe(literal);
  });

  it("emits ['--json-schema',JSON.stringify(obj)] when jsonSchema is an object", () => {
    const obj = { type: "object", properties: { name: { type: "string" } } };
    const prep = prepareClaudeRequest({ ...baseParams, jsonSchema: obj });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    // The argv value must be JSON-parseable back to the same object —
    // guards against `String(obj)` ("[object Object]") regressions.
    const arg = prep.args[idx + 1];
    expect(JSON.parse(arg)).toEqual(obj);
  });

  it("emits NEITHER flag when both are absent", () => {
    const prep = prepareClaudeRequest({ ...baseParams });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--fallback-model");
    expect(prep.args).not.toContain("--json-schema");
  });

  // REGRESSIONS D-style end-to-end: prepare → contract consistency.
  // Closes the contract-table gap class that bit slices α/γ/δ.
  it("argv from prepareClaudeRequest({fallbackModel,jsonSchema}) passes validateUpstreamCliArgs", () => {
    const prep = prepareClaudeRequest({
      ...baseParams,
      fallbackModel: "claude-haiku-4-5-20251001",
      jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("claude", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});

// ─── REGRESSIONS Hε — UPSTREAM_CLI_CONTRACTS claude flags + fixtures ───
//
// Falsifiability: removing either flag from contract.flags fails Hε-1/4/7;
// dropping the fixture fails Hε-7/8; the mechanical-validation assertion
// inside each fixture-presence test catches the slice-ε round-1 gap class
// (fixture exists but contract drifted).
describe("REGRESSIONS Hε — claude contract accepts --fallback-model + --json-schema", () => {
  it("validateUpstreamCliArgs accepts ['-p','x','--fallback-model','<model>']", () => {
    const validation = validateUpstreamCliArgs("claude", [
      "-p",
      "x",
      "--fallback-model",
      "claude-haiku-4-5-20251001",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs rejects ['-p','x','--fallback-model'] (missing required value)", () => {
    const validation = validateUpstreamCliArgs("claude", ["-p", "x", "--fallback-model"]);
    expect(validation.ok).toBe(false);
  });

  it("validateUpstreamCliArgs accepts ['-p','x','--json-schema','<literal>']", () => {
    const validation = validateUpstreamCliArgs("claude", [
      "-p",
      "x",
      "--json-schema",
      '{"type":"object","properties":{"name":{"type":"string"}}}',
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("contract introspection: claude.flags['--fallback-model'] arity=one", () => {
    const flag = UPSTREAM_CLI_CONTRACTS.claude.flags["--fallback-model"];
    expect(flag, "claude.flags['--fallback-model'] must be registered").toBeDefined();
    expect(flag.arity).toBe("one");
  });

  it("contract introspection: claude.flags['--json-schema'] arity=one", () => {
    const flag = UPSTREAM_CLI_CONTRACTS.claude.flags["--json-schema"];
    expect(flag, "claude.flags['--json-schema'] must be registered").toBeDefined();
    expect(flag.arity).toBe("one");
  });

  it("contract introspection: claude.mcpParameters contains fallbackModel + jsonSchema", () => {
    const params = UPSTREAM_CLI_CONTRACTS.claude.mcpParameters;
    expect(params).toContain("fallbackModel");
    expect(params).toContain("jsonSchema");
  });

  // Eε-pattern: presence check + mechanical end-to-end validation in the
  // same it() block. Under P-Hε-1 (revert flag from contract.flags) this
  // mechanical assertion goes red even if the fixture object still
  // exists in the array.
  it("claude-fallback-model fixture exists AND mechanically validates against the contract", () => {
    const fixture = UPSTREAM_CLI_CONTRACTS.claude.conformanceFixtures.find(
      f => f.id === "claude-fallback-model"
    );
    expect(fixture, "claude-fallback-model fixture must be registered").toBeDefined();
    expect(fixture?.expect).toBe("pass");
    expect(fixture?.args).toContain("--fallback-model");

    const validation = validateUpstreamCliArgs("claude", fixture?.args as readonly string[]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("claude-json-schema fixture exists AND mechanically validates against the contract", () => {
    const fixture = UPSTREAM_CLI_CONTRACTS.claude.conformanceFixtures.find(
      f => f.id === "claude-json-schema"
    );
    expect(fixture, "claude-json-schema fixture must be registered").toBeDefined();
    expect(fixture?.expect).toBe("pass");
    expect(fixture?.args).toContain("--json-schema");

    const validation = validateUpstreamCliArgs("claude", fixture?.args as readonly string[]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});
