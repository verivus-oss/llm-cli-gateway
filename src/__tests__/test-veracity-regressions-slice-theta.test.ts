/**
 * Phase 4 slice θ — test-veracity regressions for Grok HIGH parity:
 *   --sandbox, --rules, --system-prompt-override, --allow, --deny.
 *
 * Mirrors the REGRESSIONS pattern from slices ε/η/ζ. Every test below is
 * mutation-probe-friendly; the audit spec at
 * `docs/plans/test-veracity-audit-slice-theta.spec.md` documents the
 * counterexample mutations each LLM reviewer must run before approving
 * this slice.
 *
 * Probe targets:
 *
 *   P-Tα-1/2/3       — Zod registered-tool inputSchema (sync + async).
 *   P-Tβ-1/2/3/4     — prepareGrokRequest argv emission end-to-end.
 *   P-Tε-1/2/3/4/5   — UPSTREAM_CLI_CONTRACTS flags/fixtures/mcpParameters
 *                       + mechanical fixture validation.
 */
import { describe, expect, it } from "vitest";
import { createGatewayServer, prepareGrokRequest } from "../index.js";
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

// ─── REGRESSIONS Tα — registered MCP schemas for the five new fields ──
//
// Falsifiability: reverting any Zod entry on either tool fails the
// matching assertion; dropping `.min(1)` on a string field fails the
// empty-string rejection case.

describe("REGRESSIONS Tα — registered tool sandbox/rules/systemPromptOverride/allow/deny (slice θ)", () => {
  it.each(["grok_request", "grok_request_async"])(
    "%s.sandbox accepts non-empty string + rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.sandbox;
      expect(f, `${name}.sandbox must be registered`).toBeDefined();
      expect(f.safeParse("workspace-write").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["grok_request", "grok_request_async"])(
    "%s.rules accepts non-empty string + rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.rules;
      expect(f, `${name}.rules must be registered`).toBeDefined();
      expect(f.safeParse("@./rules.md").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["grok_request", "grok_request_async"])(
    "%s.systemPromptOverride accepts non-empty string + rejects empty",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.systemPromptOverride;
      expect(f, `${name}.systemPromptOverride must be registered`).toBeDefined();
      expect(f.safeParse("You are a tester").success).toBe(true);
      expect(f.safeParse("").success).toBe(false);
    }
  );

  it.each(["grok_request", "grok_request_async"])("%s.allow accepts string[]", name => {
    const { shape } = getRegisteredToolSchema(name);
    const f = shape.allow;
    expect(f, `${name}.allow must be registered`).toBeDefined();
    expect(f.safeParse(["bash", "edit"]).success).toBe(true);
  });

  it.each(["grok_request", "grok_request_async"])("%s.deny accepts string[]", name => {
    const { shape } = getRegisteredToolSchema(name);
    const f = shape.deny;
    expect(f, `${name}.deny must be registered`).toBeDefined();
    expect(f.safeParse(["write", "kill"]).success).toBe(true);
  });
});

// ─── REGRESSIONS Tβ — prepareGrokRequest end-to-end argv emission ─────
//
// Falsifiability: each test inspects the actual argv prepareGrokRequest
// would spawn. Mutating any helper, prepare-function threading, OR the
// Zod field threading all surface here.

const baseGrokParams = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "grok_request",
};

describe("REGRESSIONS Tβ — prepareGrokRequest emits the five new flags", () => {
  it("emits ['--sandbox','<profile>'] as adjacent tokens when sandbox is set", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, sandbox: "workspace-write" });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = adjacentTokenIndex(prep.args, "--sandbox");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("workspace-write");
  });

  it("emits ['--rules','<value>'] verbatim (gateway does NOT strip the @ prefix)", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, rules: "@./rules.md" });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = adjacentTokenIndex(prep.args, "--rules");
    expect(idx).toBeGreaterThan(-1);
    // Catches the "helpfully strip the @ prefix" regression class.
    expect(prep.args[idx + 1]).toBe("@./rules.md");
  });

  it("emits ['--system-prompt-override','<prompt>'] as adjacent tokens", () => {
    const prep = prepareGrokRequest({
      ...baseGrokParams,
      systemPromptOverride: "You are a tester",
    });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = adjacentTokenIndex(prep.args, "--system-prompt-override");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("You are a tester");
  });

  it("emits two ['--allow','<rule>'] instances (NOT comma-joined like --tools)", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, allow: ["bash", "edit"] });
    if (!("args" in prep)) throw new Error("expected args");
    const values = allAdjacentValues(prep.args, "--allow");
    expect(values).toEqual(["bash", "edit"]);
  });

  it("emits two ['--deny','<rule>'] instances (NOT comma-joined like --disallowed-tools)", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams, deny: ["write", "kill"] });
    if (!("args" in prep)) throw new Error("expected args");
    const values = allAdjacentValues(prep.args, "--deny");
    expect(values).toEqual(["write", "kill"]);
  });

  it("emits NONE of the five flags when all are absent", () => {
    const prep = prepareGrokRequest({ ...baseGrokParams });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--sandbox");
    expect(prep.args).not.toContain("--rules");
    expect(prep.args).not.toContain("--system-prompt-override");
    expect(prep.args).not.toContain("--allow");
    expect(prep.args).not.toContain("--deny");
  });

  // REGRESSIONS D-style end-to-end: prepare → contract consistency.
  // Closes the contract-table gap that bit slices α/γ/δ.
  it("argv from prepareGrokRequest(all five) passes validateUpstreamCliArgs", () => {
    const prep = prepareGrokRequest({
      ...baseGrokParams,
      sandbox: "workspace-write",
      rules: "@./rules.md",
      systemPromptOverride: "You are a tester",
      allow: ["bash", "edit"],
      deny: ["write", "kill"],
    });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("grok", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});

// ─── REGRESSIONS Tε — UPSTREAM_CLI_CONTRACTS introspection + fixtures ─
//
// Falsifiability: removing any flag from contract.flags fails the
// matching introspection + the mechanical fixture validation in the
// same it() block.

describe("REGRESSIONS Tε — slice θ contract entries + fixtures", () => {
  it("validateUpstreamCliArgs accepts ['-p','x','--sandbox','workspace-write']", () => {
    const validation = validateUpstreamCliArgs("grok", ["-p", "x", "--sandbox", "workspace-write"]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs accepts a non-standard sandbox profile (freeform, no enum)", () => {
    // Slice-θ decision: --sandbox is freeform per `grok --help` (no
    // `[possible values: …]` listing). Adding a `values: [...]` enum
    // constraint to the contract would reject custom profile names —
    // this test catches that mistake.
    const validation = validateUpstreamCliArgs("grok", [
      "-p",
      "x",
      "--sandbox",
      "custom-test-profile",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs rejects ['-p','x','--sandbox'] (missing required value)", () => {
    const validation = validateUpstreamCliArgs("grok", ["-p", "x", "--sandbox"]);
    expect(validation.ok).toBe(false);
  });

  it("validateUpstreamCliArgs accepts ['-p','x','--rules','@./r.md']", () => {
    const validation = validateUpstreamCliArgs("grok", ["-p", "x", "--rules", "@./r.md"]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs accepts ['-p','x','--system-prompt-override','You are…']", () => {
    const validation = validateUpstreamCliArgs("grok", [
      "-p",
      "x",
      "--system-prompt-override",
      "You are a tester",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs accepts repeated --allow instances", () => {
    const validation = validateUpstreamCliArgs("grok", [
      "-p",
      "x",
      "--allow",
      "bash",
      "--allow",
      "edit",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs accepts repeated --deny instances", () => {
    const validation = validateUpstreamCliArgs("grok", [
      "-p",
      "x",
      "--deny",
      "write",
      "--deny",
      "kill",
    ]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("contract introspection: all 5 new flag entries are arity:'one' with no `values` enum on --sandbox", () => {
    const entries: ReadonlyArray<string> = [
      "--sandbox",
      "--rules",
      "--system-prompt-override",
      "--allow",
      "--deny",
    ];
    for (const flag of entries) {
      const f = UPSTREAM_CLI_CONTRACTS.grok.flags[flag];
      expect(f, `grok.flags["${flag}"] must be registered`).toBeDefined();
      expect(f.arity).toBe("one");
    }
    // --sandbox MUST be freeform (no values constraint) per the live
    // `grok --help` probe — see audit spec for slice θ.
    expect(UPSTREAM_CLI_CONTRACTS.grok.flags["--sandbox"].values).toBeUndefined();
  });

  it("contract introspection: mcpParameters contains all 5 new param names", () => {
    const params = UPSTREAM_CLI_CONTRACTS.grok.mcpParameters;
    expect(params).toContain("sandbox");
    expect(params).toContain("rules");
    expect(params).toContain("systemPromptOverride");
    expect(params).toContain("allow");
    expect(params).toContain("deny");
  });

  // Eε-pattern: fixture presence is necessary but NOT sufficient — each
  // new fixture must mechanically validate against the contract inside
  // the same it() block. Catches the slice-ε round-1 gap class.
  const newFixtures: ReadonlyArray<string> = [
    "grok-sandbox",
    "grok-rules",
    "grok-system-prompt-override",
    "grok-allow-repeated",
    "grok-deny-repeated",
  ];

  it.each(newFixtures)(
    "grok fixture '%s' exists AND mechanically validates against the contract",
    id => {
      const fixture = UPSTREAM_CLI_CONTRACTS.grok.conformanceFixtures.find(f => f.id === id);
      expect(fixture, `grok fixture '${id}' must be registered`).toBeDefined();
      expect(fixture?.expect).toBe("pass");
      const validation = validateUpstreamCliArgs("grok", fixture?.args as readonly string[]);
      expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
    }
  );
});
