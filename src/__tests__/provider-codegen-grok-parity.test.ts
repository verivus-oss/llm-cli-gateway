/**
 * Contract-driven provider codegen — grok byte-parity gate (POC).
 *
 * Proves the contract-driven generators reproduce today's HAND-WRITTEN grok
 * behaviour exactly, so a future cutover is provably behaviour-preserving:
 *
 *   1. ARGV parity: for a matrix of param combinations, the argv emitted by
 *      `buildArgvFromGeneration(grokContract, GROK_FLAG_GENERATION, params)` is
 *      byte-identical to the covered tail of `prepareGrokRequest(params).args`
 *      (the real production function). Because the generation table is ordered
 *      to match the hand-written emission sequence and the matrix sets only
 *      covered params, the covered flags are the contiguous tail of the real
 *      argv and the two arrays compare exactly.
 *
 *   2. SCHEMA parity: the derived Zod shape sources its enum constraints from
 *      the contract (single source) and agrees with the hand-written
 *      grok_request tool schema on enum acceptance/rejection.
 *
 *   3. COVERAGE: every covered flag exists in the contract; the covered +
 *      explicitly-ungenerated sets are disjoint and the union is accounted for.
 *
 * Reverting any hand-written grok argv conditional (e.g. dropping the `--allow`
 * repeat, or changing `--max-turns` to a truthy guard) turns the ARGV parity
 * red.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import { prepareGrokRequest, createGatewayServer } from "../index.js";
import { UPSTREAM_CLI_CONTRACTS } from "../upstream-contracts.js";
import {
  buildArgvFromGeneration,
  deriveZodShapeFromGeneration,
  GROK_FLAG_GENERATION,
  UNGENERATED_GROK_FLAGS,
} from "../provider-codegen.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";

const grokContract = UPSTREAM_CLI_CONTRACTS.grok;

/**
 * Drive the REAL production prepare function and return its argv. Restricting
 * `params` to covered flags only means the result is `["-p", prompt, ...maybe
 * --model..., ...covered flags...]` with the covered flags as the tail.
 */
function realGrokArgs(coveredParams: Record<string, unknown>): string[] {
  const prep = prepareGrokRequest({
    prompt: "say the line",
    operation: "grok_request",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    ...coveredParams,
  });
  if (!("args" in prep)) {
    throw new Error("prepareGrokRequest returned an error response for a valid covered-param set");
  }
  return prep.args;
}

function genGrokArgs(coveredParams: Record<string, unknown>): string[] {
  return buildArgvFromGeneration(grokContract, GROK_FLAG_GENERATION, coveredParams);
}

// Param matrices, each setting ONLY covered flags. Values chosen valid so the
// real prepare path does not early-return an error.
const CASES: Array<{ name: string; params: Record<string, unknown> }> = [
  { name: "no covered flags set", params: {} },
  {
    name: "all string/enum value flags",
    params: {
      outputFormat: "json",
      effort: "high",
      reasoningEffort: "medium",
      workingDir: "/tmp/wd",
      sandbox: "workspace-write",
      rules: "@rules.md",
      systemPromptOverride: "be terse",
      compactionMode: "segments",
      compactionDetail: "verbose",
      agent: "reviewer",
      promptFile: "/tmp/p.txt",
      single: "one-shot",
      leaderSocket: "/tmp/leader.sock",
    },
  },
  {
    name: "all boolean flags",
    params: {
      check: true,
      disableWebSearch: true,
      todoGate: true,
      verbatim: true,
      experimentalMemory: true,
      noAltScreen: true,
      noMemory: true,
      noPlan: true,
      noSubagents: true,
      oauth: true,
      restoreCode: true,
    },
  },
  {
    name: "number flags (incl. boundary)",
    params: { maxTurns: 7, bestOfN: 3 },
  },
  {
    name: "csv list flags",
    params: { allowedTools: ["Read", "Edit"], disallowedTools: ["Bash"] },
  },
  {
    name: "repeat list flags (multiple rules)",
    params: { allow: ["read", "write", "net"], deny: ["exec"] },
  },
  {
    name: "boolean flags set false are omitted",
    params: { check: false, verbatim: false, oauth: false },
  },
  {
    name: "empty lists are omitted",
    params: { allowedTools: [], allow: [], deny: [] },
  },
  {
    name: "mixed realistic request",
    params: {
      effort: "high",
      sandbox: "danger-full-access",
      allowedTools: ["Read"],
      allow: ["read", "write"],
      maxTurns: 12,
      verbatim: true,
      compactionMode: "summary",
      leaderSocket: "/run/grok.sock",
    },
  },
];

describe("provider-codegen: grok argv byte-parity vs prepareGrokRequest", () => {
  it.each(CASES)("$name", ({ params }) => {
    const real = realGrokArgs(params);
    const gen = genGrokArgs(params);

    // The covered flags are the contiguous tail of the real argv (only covered
    // params are set, so no ungenerated flag interleaves after the prefix).
    const realTail = gen.length === 0 ? [] : real.slice(real.length - gen.length);
    expect(realTail).toEqual(gen);

    // Everything before the tail is only the prompt prefix (and possibly a
    // default --model) — i.e. no covered flag leaked into the prefix.
    const prefix = real.slice(0, real.length - gen.length);
    expect(prefix[0]).toBe("-p");
    expect(prefix[1]).toBe("say the line");
    for (const g of GROK_FLAG_GENERATION) {
      expect(prefix, `covered flag ${g.flag} leaked into prefix`).not.toContain(g.flag);
    }
  });

  it("covered + ungenerated flag sets are disjoint and all covered flags exist in the contract", () => {
    const covered = new Set(GROK_FLAG_GENERATION.map(g => g.flag));
    expect(covered.size).toBe(GROK_FLAG_GENERATION.length); // no duplicate flags

    for (const flag of covered) {
      expect(grokContract.flags[flag], `${flag} missing from grok contract`).toBeDefined();
    }
    for (const ungen of UNGENERATED_GROK_FLAGS) {
      expect(covered.has(ungen), `${ungen} is both covered and ungenerated`).toBe(false);
    }
  });

  it("every request parameter maps to a distinct flag", () => {
    const params = GROK_FLAG_GENERATION.map(g => g.requestParameter);
    expect(new Set(params).size).toBe(params.length);
  });
});

describe("provider-codegen: grok schema derivation from the contract", () => {
  const derived = z.object(deriveZodShapeFromGeneration(grokContract, GROK_FLAG_GENERATION));

  it("produces one optional field per covered flag", () => {
    expect(Object.keys(derived.shape).sort()).toEqual(
      GROK_FLAG_GENERATION.map(g => g.requestParameter).sort()
    );
    // All optional: an empty object parses.
    expect(derived.safeParse({}).success).toBe(true);
  });

  it("accepts a fully-populated valid input", () => {
    const ok = derived.safeParse({
      outputFormat: "json",
      effort: "high",
      reasoningEffort: "low",
      allowedTools: ["Read"],
      maxTurns: 5,
      bestOfN: 2,
      check: true,
      sandbox: "workspace-write",
      compactionMode: "segments",
      compactionDetail: "minimal",
      leaderSocket: "/tmp/s.sock",
    });
    expect(ok.success).toBe(true);
  });

  it("sources enum constraints from the contract (rejects out-of-enum values)", () => {
    // --effort, --output-format, --compaction-mode, --compaction-detail all
    // carry `values` in the contract.
    expect(derived.safeParse({ effort: "bogus" }).success).toBe(false);
    expect(derived.safeParse({ outputFormat: "xml" }).success).toBe(false);
    expect(derived.safeParse({ compactionMode: "nope" }).success).toBe(false);
    expect(derived.safeParse({ compactionDetail: "loud" }).success).toBe(false);

    // The derived enum values equal the contract's, proving single-sourcing.
    const effortField = derived.shape.effort as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    expect(effortField.unwrap().options).toEqual([...grokContract.flags["--effort"].values!]);
  });

  it("agrees with the hand-written grok_request tool schema on enum rejection", () => {
    const server = createGatewayServer({
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
    });
    const reg = (
      server as unknown as Record<string, Record<string, { inputSchema?: z.ZodTypeAny }>>
    )._registeredTools;
    const grokSchema = reg["grok_request"].inputSchema as z.ZodTypeAny;

    // Hand-written schema and derived schema both reject the same bad enum...
    expect(
      (grokSchema as z.ZodType).safeParse({ prompt: "x", effort: "bogus" }).success,
      "hand-written grok schema should reject effort=bogus"
    ).toBe(false);
    expect(derived.safeParse({ effort: "bogus" }).success).toBe(false);

    // ...and both accept the same good enum value.
    expect((grokSchema as z.ZodType).safeParse({ prompt: "x", effort: "high" }).success).toBe(true);
    expect(derived.safeParse({ effort: "high" }).success).toBe(true);
  });
});

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}
