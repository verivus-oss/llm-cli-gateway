// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { describe, expect, it } from "vitest";
import { PrepPhase, PrepPipeline, type PrepStage } from "../prep-pipeline.js";

type Ctx = { trace: string[] };
type Resp = { error: string };

function stage(
  name: string,
  phase: PrepPhase,
  opts: { provider?: string; haltWith?: string } = {}
): PrepStage<Ctx, Resp> {
  return {
    name,
    phase,
    provider: opts.provider,
    run(ctx) {
      ctx.trace.push(name);
      return opts.haltWith
        ? { kind: "halt", response: { error: opts.haltWith } }
        : { kind: "continue" };
    },
  };
}

describe("PrepPipeline", () => {
  it("runs stages in ascending phase order, not registration order", () => {
    const ctx: Ctx = { trace: [] };
    const pipeline = new PrepPipeline<Ctx, Resp>()
      .register(stage("policy", PrepPhase.Policy))
      .register(stage("guards", PrepPhase.InputGuards))
      .register(stage("shape", PrepPhase.PromptShape))
      .register(stage("integrity", PrepPhase.Integrity));

    const result = pipeline.run(ctx, "claude");

    expect(result.kind).toBe("completed");
    expect(ctx.trace).toEqual(["guards", "integrity", "shape", "policy"]);
    expect(pipeline.orderedPhases("claude")).toEqual([
      PrepPhase.InputGuards,
      PrepPhase.Integrity,
      PrepPhase.PromptShape,
      PrepPhase.Policy,
    ]);
  });

  it("halts on the first halting stage and skips the rest", () => {
    const ctx: Ctx = { trace: [] };
    const pipeline = new PrepPipeline<Ctx, Resp>()
      .register(stage("guards", PrepPhase.InputGuards))
      .register(stage("integrity", PrepPhase.Integrity, { haltWith: "bad-prompt" }))
      .register(stage("shape", PrepPhase.PromptShape));

    const result = pipeline.run(ctx, "claude");

    expect(result).toEqual({
      kind: "halted",
      response: { error: "bad-prompt" },
      haltedBy: "integrity",
    });
    // The PromptShape stage after the halt must not have run.
    expect(ctx.trace).toEqual(["guards", "integrity"]);
  });

  it("lets a provider-specific stage replace the default at the same phase", () => {
    const ctx: Ctx = { trace: [] };
    const pipeline = new PrepPipeline<Ctx, Resp>()
      .register(stage("shape-default", PrepPhase.PromptShape))
      .register(stage("shape-grok", PrepPhase.PromptShape, { provider: "grok" }));

    pipeline.run(ctx, "grok");
    expect(ctx.trace).toEqual(["shape-grok"]);

    const ctx2: Ctx = { trace: [] };
    pipeline.run(ctx2, "claude");
    expect(ctx2.trace).toEqual(["shape-default"]);
  });

  it("throws on two default stages at the same phase (loud mis-wiring)", () => {
    const pipeline = new PrepPipeline<Ctx, Resp>()
      .register(stage("a", PrepPhase.Integrity))
      .register(stage("b", PrepPhase.Integrity));
    expect(() => pipeline.run({ trace: [] }, "claude")).toThrow(/two default stages/);
  });

  it("throws on two same-provider stages at the same phase", () => {
    const pipeline = new PrepPipeline<Ctx, Resp>()
      .register(stage("a", PrepPhase.Integrity, { provider: "codex" }))
      .register(stage("b", PrepPhase.Integrity, { provider: "codex" }));
    expect(() => pipeline.run({ trace: [] }, "codex")).toThrow(/two 'codex' stages/);
  });

  it("rejects a stage registered at the fixed ArgvAndMcp phase (design 5.1.1)", () => {
    const pipeline = new PrepPipeline<Ctx, Resp>().register(stage("argv", PrepPhase.ArgvAndMcp));
    expect(() => pipeline.run({ trace: [] }, "claude")).toThrow(/ArgvAndMcp is a fixed sub-block/);
    expect(() => pipeline.orderedPhases("claude")).toThrow(/ArgvAndMcp is a fixed sub-block/);
  });

  it("keeps PromptShape (optimize) strictly before Policy (approval)", () => {
    // Guards the design's load-bearing ordinal: optimize before approval.
    expect(PrepPhase.PromptShape).toBeLessThan(PrepPhase.Policy);
    expect(PrepPhase.Integrity).toBeLessThan(PrepPhase.PromptShape);
    expect(PrepPhase.ArgvAndMcp).toBeGreaterThan(PrepPhase.Policy);
  });
});
