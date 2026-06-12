/**
 * Grok schema fidelity golden — lossless-cutover gate for the grok_request
 * input schema.
 *
 * Captures, from the REGISTERED grok_request tool schema, the exact
 * `.describe()` text of every covered field plus its validation behaviour
 * (enum acceptance, `.min(1)` on strings, MAX_TURNS_SCHEMA bounds on numbers).
 * The describe snapshot is written against the hand-written schema, then must
 * remain identical after the covered fields are replaced by
 * `deriveZodShapeFromGeneration`. The validation assertions encode the required
 * behaviour and must hold before AND after the cutover.
 *
 * A dropped `.min(1)`, a changed describe string, a missing field, or weakened
 * numeric bounds all fail this gate.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import { createGatewayServer } from "../index.js";
import { deriveZodShapeFromGeneration, GROK_FLAG_GENERATION } from "../provider-codegen.js";
import { UPSTREAM_CLI_CONTRACTS } from "../upstream-contracts.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function grokSchema(): z.ZodObject<z.ZodRawShape> {
  const server = createGatewayServer({
    asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
    persistence: mkPersistence(),
  });
  const reg = (
    server as unknown as Record<
      string,
      Record<string, { inputSchema?: z.ZodObject<z.ZodRawShape> }>
    >
  )._registeredTools;
  const schema = reg["grok_request"].inputSchema;
  if (!schema) throw new Error("grok_request has no inputSchema");
  return schema;
}

const COVERED = GROK_FLAG_GENERATION.map(g => g.requestParameter);
const MIN1_STRINGS = [
  "workingDir",
  "sandbox",
  "rules",
  "systemPromptOverride",
  "agent",
  "promptFile",
  "single",
  "leaderSocket",
];
const ENUMS: Array<[string, string, string]> = [
  ["outputFormat", "xml", "json"],
  ["effort", "bogus", "high"],
  ["compactionMode", "nope", "summary"],
  ["compactionDetail", "loud", "verbose"],
];

describe("grok schema fidelity (pre/post cutover)", () => {
  it("covered-field describe text is preserved", () => {
    const schema = grokSchema();
    const shape = schema.shape;
    const describes: Record<string, string | undefined> = {};
    for (const p of COVERED) {
      expect(shape[p], `covered field ${p} missing from grok_request schema`).toBeDefined();
      describes[p] = shape[p].description;
    }
    expect(describes).toMatchSnapshot();
  });

  it("string min(1) constraints reject empty, accept non-empty", () => {
    const schema = grokSchema();
    for (const f of MIN1_STRINGS) {
      expect(schema.safeParse({ prompt: "x", [f]: "" }).success, `${f} must reject empty`).toBe(
        false
      );
      expect(schema.safeParse({ prompt: "x", [f]: "v" }).success, `${f} must accept value`).toBe(
        true
      );
    }
    // reasoningEffort intentionally has NO min(1).
    expect(schema.safeParse({ prompt: "x", reasoningEffort: "" }).success).toBe(true);
  });

  it("enum constraints reject out-of-enum, accept valid", () => {
    const schema = grokSchema();
    for (const [f, bad, good] of ENUMS) {
      expect(schema.safeParse({ prompt: "x", [f]: bad }).success, `${f} must reject ${bad}`).toBe(
        false
      );
      expect(schema.safeParse({ prompt: "x", [f]: good }).success, `${f} must accept ${good}`).toBe(
        true
      );
    }
  });

  it("numeric fields keep MAX_TURNS_SCHEMA bounds (int, positive, safe, max 10000)", () => {
    const schema = grokSchema();
    for (const f of ["maxTurns", "bestOfN"]) {
      expect(schema.safeParse({ prompt: "x", [f]: 5 }).success, `${f} accepts 5`).toBe(true);
      expect(schema.safeParse({ prompt: "x", [f]: 10_000 }).success, `${f} accepts 10000`).toBe(
        true
      );
      expect(schema.safeParse({ prompt: "x", [f]: 0 }).success, `${f} rejects 0`).toBe(false);
      expect(schema.safeParse({ prompt: "x", [f]: -1 }).success, `${f} rejects -1`).toBe(false);
      expect(schema.safeParse({ prompt: "x", [f]: 1.5 }).success, `${f} rejects 1.5`).toBe(false);
      expect(schema.safeParse({ prompt: "x", [f]: 10_001 }).success, `${f} rejects 10001`).toBe(
        false
      );
      expect(
        schema.safeParse({ prompt: "x", [f]: Number.MAX_SAFE_INTEGER + 1 }).success,
        `${f} rejects unsafe`
      ).toBe(false);
    }
  });

  it("derived shape equals the hand-written schema field-for-field (describe + validation)", () => {
    const shape = grokSchema().shape;
    const derived = deriveZodShapeFromGeneration(UPSTREAM_CLI_CONTRACTS.grok, GROK_FLAG_GENERATION);
    const derivedObj = z.object(derived);

    // Describe text identical for every covered field.
    for (const p of COVERED) {
      expect(derived[p], `derived missing ${p}`).toBeDefined();
      expect(derived[p].description, `${p} describe mismatch`).toBe(shape[p].description);
    }
    // min(1) string constraints reproduced.
    for (const f of MIN1_STRINGS) {
      expect(derivedObj.safeParse({ [f]: "" }).success, `${f} reject empty`).toBe(false);
      expect(derivedObj.safeParse({ [f]: "v" }).success, `${f} accept value`).toBe(true);
    }
    expect(derivedObj.safeParse({ reasoningEffort: "" }).success).toBe(true);
    // enum constraints reproduced.
    for (const [f, bad, good] of ENUMS) {
      expect(derivedObj.safeParse({ [f]: bad }).success, `${f} reject ${bad}`).toBe(false);
      expect(derivedObj.safeParse({ [f]: good }).success, `${f} accept ${good}`).toBe(true);
    }
    // numeric bounds reproduced (== MAX_TURNS_SCHEMA).
    for (const f of ["maxTurns", "bestOfN"]) {
      expect(derivedObj.safeParse({ [f]: 5 }).success).toBe(true);
      expect(derivedObj.safeParse({ [f]: 0 }).success).toBe(false);
      expect(derivedObj.safeParse({ [f]: 1.5 }).success).toBe(false);
      expect(derivedObj.safeParse({ [f]: 10_001 }).success).toBe(false);
      expect(derivedObj.safeParse({ [f]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    }
  });

  it("boolean + array covered fields accept their types", () => {
    const schema = grokSchema();
    for (const f of ["check", "verbatim", "oauth", "experimentalMemory", "noPlan"]) {
      expect(schema.safeParse({ prompt: "x", [f]: true }).success, `${f} accepts true`).toBe(true);
      expect(schema.safeParse({ prompt: "x", [f]: false }).success, `${f} accepts false`).toBe(
        true
      );
    }
    for (const f of ["allowedTools", "disallowedTools", "allow", "deny"]) {
      expect(schema.safeParse({ prompt: "x", [f]: ["a", "b"] }).success, `${f} accepts array`).toBe(
        true
      );
    }
  });
});
