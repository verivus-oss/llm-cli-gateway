// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * PrepPipeline: the Tier-A (request-preparation) ordered-stage runner from the
 * approved RequestPipeline design (design draft v5, sections 5.1 / 5.1.1).
 *
 * This is generic machinery only: it holds no provider-specific logic and does
 * not import the gateway server. Provider stages are registered by the caller
 * (see the Claude prep stages wired inside `prepareClaudeRequest`).
 *
 * Load-bearing invariants this module enforces (design C1, R1):
 *  - Phases run in a pinned ascending ordinal order, never registration order.
 *  - A `halt` from any stage short-circuits the remaining stages and returns the
 *    stage's terminal response (the design's 1:1 mapping to today's early
 *    returns such as `createErrorResponse`).
 *  - `ArgvAndMcp` is the last ordinal; it is a fixed provider sub-block owned by
 *    the caller (design 5.1.1), so the pipeline itself stops before it. Callers
 *    run the argv+MCP fence after `run(...)` returns `completed`.
 */

/**
 * Pinned phase ordinals. Ordering is load-bearing: `PromptShape` (optimize) must
 * come before `Policy` (approval), matching the real Claude prep order where
 * optimize runs before `approvalManager.decide` (both still read the raw prompt
 * from the context; only `effectivePrompt` is rewritten by PromptShape).
 */
export enum PrepPhase {
  InputGuards = 10,
  InputResolve = 20,
  Integrity = 30,
  PromptShape = 40,
  Policy = 50,
  ArgvAndMcp = 60,
}

/**
 * A stage either continues (having mutated the shared context) or halts the
 * pipeline with a terminal response `H` (the provider's tool-response type).
 */
export type PrepStageOutcome<H> = { kind: "continue" } | { kind: "halt"; response: H };

export interface PrepStage<C, H> {
  /** Stable identifier for tracing and tests. */
  readonly name: string;
  /** Pinned ordinal; determines run order, never registration order. */
  readonly phase: PrepPhase;
  /**
   * Optional provider key. When set, this stage replaces the default (no
   * `provider`) stage at the same phase for that provider only. This is how the
   * design keeps provider prep exceptions first-class (e.g. Codex Kit-context,
   * Grok verbatim) without a shared hook silently applying to a provider that
   * opts out.
   */
  readonly provider?: string;
  run(ctx: C): PrepStageOutcome<H>;
}

export type PrepRunResult<H> =
  { kind: "completed" } | { kind: "halted"; response: H; haltedBy: string };

/**
 * An ordered set of prep stages for one provider family. Register stages in any
 * order; the pipeline sorts and validates them. `run` resolves provider
 * overrides, then executes the resolved stages in ascending phase order.
 */
export class PrepPipeline<C, H> {
  private readonly stages: PrepStage<C, H>[] = [];

  register(stage: PrepStage<C, H>): this {
    this.stages.push(stage);
    return this;
  }

  registerAll(stages: readonly PrepStage<C, H>[]): this {
    for (const stage of stages) this.register(stage);
    return this;
  }

  /**
   * Resolve the active stages for `provider`: a provider-specific stage at a
   * phase wins over a default stage at the same phase. Throws if the resolution
   * is ambiguous (two defaults, or two same-provider stages, at one phase) so a
   * mis-wiring fails loudly at construction/first-run rather than silently
   * dropping or double-running a phase.
   */
  resolve(provider: string): PrepStage<C, H>[] {
    const byPhase = new Map<PrepPhase, PrepStage<C, H>>();
    // Two passes so a provider-specific stage always wins regardless of
    // registration order: seed defaults first, then let provider stages
    // overwrite. Duplicate defaults / duplicate provider stages are errors.
    const seenDefault = new Set<PrepPhase>();
    const seenProvider = new Set<PrepPhase>();
    for (const stage of this.stages) {
      if (stage.provider === undefined) {
        if (seenDefault.has(stage.phase)) {
          throw new Error(
            `PrepPipeline: two default stages registered at phase ${PrepPhase[stage.phase]}`
          );
        }
        seenDefault.add(stage.phase);
      }
    }
    for (const stage of this.stages) {
      if (stage.provider === undefined) byPhase.set(stage.phase, stage);
    }
    for (const stage of this.stages) {
      if (stage.provider === provider) {
        if (seenProvider.has(stage.phase)) {
          throw new Error(
            `PrepPipeline: two '${provider}' stages registered at phase ${PrepPhase[stage.phase]}`
          );
        }
        seenProvider.add(stage.phase);
        byPhase.set(stage.phase, stage);
      }
    }
    return [...byPhase.values()].sort((a, b) => a.phase - b.phase);
  }

  /** The ascending ordinal order the resolved stages will run in (for tests). */
  orderedPhases(provider: string): PrepPhase[] {
    return this.resolve(provider).map(s => s.phase);
  }

  /**
   * Run the resolved stages in ascending phase order. The first `halt` returns
   * immediately with the terminal response; otherwise returns `completed` and
   * the caller proceeds to the fixed ArgvAndMcp sub-block.
   */
  run(ctx: C, provider: string): PrepRunResult<H> {
    for (const stage of this.resolve(provider)) {
      const outcome = stage.run(ctx);
      if (outcome.kind === "halt") {
        return { kind: "halted", response: outcome.response, haltedBy: stage.name };
      }
    }
    return { kind: "completed" };
  }
}
