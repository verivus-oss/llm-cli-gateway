/**
 * Contract-driven provider code generation — Grok proof-of-concept (Issue:
 * provider-modernisation / CLI-upgrade ergonomics).
 *
 * Today a single new CLI flag must be hand-edited in ~5 places: the Zod tool
 * schema, the callback destructure, the handler forward, the prepare* param
 * type, and the prepare* argv block (see src/index.ts). `upstream-contracts.ts`
 * already declares each flag's spelling, arity, and enum `values`, but only for
 * validation/drift — nothing generates behaviour from it.
 *
 * This module closes the gap for one provider (grok) by deriving BOTH the Zod
 * input shape and the argv assembly from the contract plus a small table of
 * "generation metadata" — the part the contract is missing today: which MCP
 * request parameter sources a flag, how a present value becomes argv tokens,
 * and the input type. Flag spelling, arity, and enum constraints are read from
 * the contract, so they are NOT re-declared here.
 *
 * Scope: the clean, declaratively-expressible grok flags (string / enum /
 * boolean / number / list). Flags that need bespoke emit logic stay
 * hand-written in `prepareGrokRequest` and are deliberately excluded (see
 * UNGENERATED_GROK_FLAGS). The byte-parity test
 * (`provider-codegen-grok-parity.test.ts`) proves the generated argv matches
 * `prepareGrokRequest`'s hand-written output exactly for the covered flags.
 *
 * In the full refactor this metadata folds into `CliFlagContract.generation`;
 * it is kept in a co-located table here so the POC changes zero contract data
 * (no risk to the validation/drift/serialisation paths).
 */
// zod/v3 to match src/index.ts — the MCP SDK rejects a tool shape that mixes
// zod v3 and v4 field instances ("Mixed Zod versions detected in object shape").
import { z } from "zod/v3";
import type { CliContract } from "./upstream-contracts.js";

/**
 * How a present request-parameter value becomes argv tokens. Each rule mirrors
 * a conditional currently hand-written in `prepareGrokRequest`.
 */
export type FlagEmitRule =
  /** string/enum: `if (value) push(flag, String(value))` — truthy guard. */
  | "value_if_present"
  /** number: `if (value !== undefined) push(flag, String(value))` — emits 0. */
  | "value_if_defined"
  /** boolean (arity none): `if (value) push(flag)`. */
  | "flag_if_true"
  /** string[]: `if (value?.length) push(flag, value.join(","))`. */
  | "csv_if_nonempty"
  /** string[]: `if (value?.length) for (v of value) push(flag, v)` — repeats. */
  | "repeat_if_nonempty";

export interface FlagGenerationMeta {
  /** CLI flag emitted; MUST be a key in the provider's `contract.flags`. */
  flag: string;
  /** MCP request parameter that sources the value. */
  requestParameter: string;
  /** How a present value becomes argv tokens. */
  emit: FlagEmitRule;
  /**
   * Zod base type for schema derivation. The enum constraint, when present, is
   * read from `contract.flags[flag].values` — never duplicated here.
   */
  inputType: "string" | "number" | "boolean" | "string[]";
  /**
   * Tool-schema description for the derived Zod field (`.describe(...)`).
   * Carried here so the derived schema is byte-identical to the hand-written
   * one it replaces.
   */
  describe?: string;
  /** `z.string().min(n)` constraint for string fields. */
  minLength?: number;
  /**
   * Numeric bounds for `inputType: "number"` fields, applied in declaration
   * order. `{ int: true, positive: true, safe: true, max: 10000 }` reproduces
   * the shared `MAX_TURNS_SCHEMA` (asserted equivalent in the schema golden).
   */
  numeric?: { int?: boolean; positive?: boolean; safe?: boolean; max?: number; min?: number };
}

/**
 * Derive the argv tokens for the covered flags from the contract + generation
 * table. Emits in table order; the grok table is ordered to match the
 * hand-written `prepareGrokRequest` emission sequence, so output is byte-equal.
 */
export function buildArgvFromGeneration(
  contract: CliContract,
  generation: readonly FlagGenerationMeta[],
  params: Record<string, unknown>
): string[] {
  const args: string[] = [];
  for (const gen of generation) {
    if (!contract.flags[gen.flag]) {
      throw new Error(
        `provider-codegen: generation references flag '${gen.flag}' absent from ${contract.cli} contract.flags`
      );
    }
    const value = params[gen.requestParameter];
    switch (gen.emit) {
      case "value_if_present":
        if (value) args.push(gen.flag, String(value));
        break;
      case "value_if_defined":
        if (value !== undefined && value !== null) args.push(gen.flag, String(value));
        break;
      case "flag_if_true":
        if (value) args.push(gen.flag);
        break;
      case "csv_if_nonempty":
        if (Array.isArray(value) && value.length > 0) {
          args.push(gen.flag, value.map(String).join(","));
        }
        break;
      case "repeat_if_nonempty":
        if (Array.isArray(value) && value.length > 0) {
          for (const item of value) args.push(gen.flag, String(item));
        }
        break;
    }
  }
  return args;
}

/**
 * Derive a Zod input shape (one optional field per covered flag) from the
 * contract + generation table. Enum fields take their values from
 * `contract.flags[flag].values`, so the enum constraint has a single source.
 */
export function deriveZodShapeFromGeneration(
  contract: CliContract,
  generation: readonly FlagGenerationMeta[]
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const gen of generation) {
    const flagContract = contract.flags[gen.flag];
    if (!flagContract) {
      throw new Error(
        `provider-codegen: generation references flag '${gen.flag}' absent from ${contract.cli} contract.flags`
      );
    }
    let field: z.ZodTypeAny;
    switch (gen.inputType) {
      case "string": {
        if (flagContract.values && flagContract.values.length > 0) {
          field = z.enum(flagContract.values as [string, ...string[]]);
        } else {
          let s = z.string();
          if (gen.minLength !== undefined) s = s.min(gen.minLength);
          field = s;
        }
        break;
      }
      case "number": {
        let n = z.number();
        if (gen.numeric?.int) n = n.int();
        if (gen.numeric?.positive) n = n.positive();
        if (gen.numeric?.safe) n = n.safe();
        if (gen.numeric?.min !== undefined) n = n.min(gen.numeric.min);
        if (gen.numeric?.max !== undefined) n = n.max(gen.numeric.max);
        field = n;
        break;
      }
      case "boolean":
        field = z.boolean();
        break;
      case "string[]":
        field = z.array(z.string());
        break;
    }
    let optional: z.ZodTypeAny = field.optional();
    if (gen.describe !== undefined) optional = optional.describe(gen.describe);
    shape[gen.requestParameter] = optional;
  }
  return shape;
}

/**
 * Grok generation table, split into the contiguous runs that appear BETWEEN the
 * hand-written special flags in `prepareGrokRequest`'s argv block. Splitting
 * this way lets the prepare function interleave the generated runs with the
 * five special pushes (`--model`, permission, `--agents`, `--prompt-json`,
 * `--worktree`) at their exact original positions, so the cutover is
 * byte-for-byte order-preserving. Flag spelling + enum values come from
 * `UPSTREAM_CLI_CONTRACTS.grok.flags`.
 */

/** Emitted after `--model`, before the permission flags. */
export const GROK_GEN_OUTPUT_FORMAT: readonly FlagGenerationMeta[] = [
  {
    flag: "--output-format",
    requestParameter: "outputFormat",
    emit: "value_if_present",
    inputType: "string",
    describe: "Output format (plain|json|streaming-json). Grok default is plain.",
  },
];

const MAX_TURNS_NUMERIC = { int: true, positive: true, safe: true, max: 10_000 } as const;

/** The main run, emitted after the permission flags, before `--agents`. */
export const GROK_GEN_MAIN: readonly FlagGenerationMeta[] = [
  {
    flag: "--effort",
    requestParameter: "effort",
    emit: "value_if_present",
    inputType: "string",
    describe: "Grok effort level",
  },
  {
    flag: "--reasoning-effort",
    requestParameter: "reasoningEffort",
    emit: "value_if_present",
    inputType: "string",
    describe: "Reasoning effort for reasoning models",
  },
  {
    flag: "--tools",
    requestParameter: "allowedTools",
    emit: "csv_if_nonempty",
    inputType: "string[]",
    describe: "Allowed built-in tools (passed as --tools comma list)",
  },
  {
    flag: "--disallowed-tools",
    requestParameter: "disallowedTools",
    emit: "csv_if_nonempty",
    inputType: "string[]",
    describe: "Disallowed built-in tools (passed as --disallowed-tools comma list)",
  },
  {
    flag: "--max-turns",
    requestParameter: "maxTurns",
    emit: "value_if_defined",
    inputType: "number",
    numeric: MAX_TURNS_NUMERIC,
    describe:
      "Grok `--max-turns N`: cap on agent-loop iterations for cost / latency control (Phase 4 slice δ). Bounded to safe integers ≤ 10000.",
  },
  {
    flag: "--cwd",
    requestParameter: "workingDir",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe:
      "Grok --cwd <DIR>: working directory for this invocation. Lets headless callers run Grok against a directory other than the gateway process's cwd.",
  },
  {
    flag: "--sandbox",
    requestParameter: "sandbox",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe:
      "Grok --sandbox <PROFILE>: sandbox profile for filesystem and network access. Freeform per `grok --help` (no enum constraint on Grok 0.1.210); also settable via GROK_SANDBOX env var. Caller responsibility to pass a valid profile name.",
  },
  {
    flag: "--rules",
    requestParameter: "rules",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe:
      "Grok --rules <RULES>: extra rules to append to the system prompt. Supports `@file` prefix per `grok --help` to load from a file; gateway passes the value verbatim and lets Grok parse the prefix.",
  },
  {
    flag: "--system-prompt-override",
    requestParameter: "systemPromptOverride",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe:
      "Grok --system-prompt-override <PROMPT>: replace the agent's system prompt entirely. Distinct from Claude's --system-prompt / --append-system-prompt (Grok has only one override flag, not a pair).",
  },
  {
    flag: "--allow",
    requestParameter: "allow",
    emit: "repeat_if_nonempty",
    inputType: "string[]",
    describe:
      'Grok --allow <RULE>: permission allow rules. Each entry is emitted as its own --allow instance (per `grok --help`: "Repeat to add multiple rules").',
  },
  {
    flag: "--deny",
    requestParameter: "deny",
    emit: "repeat_if_nonempty",
    inputType: "string[]",
    describe:
      'Grok --deny <RULE>: permission deny rules. Each entry is emitted as its own --deny instance (per `grok --help`: "Repeat to add multiple rules").',
  },
  {
    flag: "--compaction-mode",
    requestParameter: "compactionMode",
    emit: "value_if_present",
    inputType: "string",
    describe:
      "Grok --compaction-mode: summary (default; no pointer) | transcript (points at the raw transcript) | segments (persists per-segment markdown to grep). Sets GROK_COMPACTION_MODE.",
  },
  {
    flag: "--compaction-detail",
    requestParameter: "compactionDetail",
    emit: "value_if_present",
    inputType: "string",
    describe:
      "Grok --compaction-detail: verbatim segment detail (none|minimal|balanced|verbose, default verbose). Only affects `--compaction-mode segments`. Sets GROK_COMPACTION_DETAIL.",
  },
  {
    flag: "--agent",
    requestParameter: "agent",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe: "Grok --agent <NAME>: agent name or definition file path.",
  },
  {
    flag: "--best-of-n",
    requestParameter: "bestOfN",
    emit: "value_if_defined",
    inputType: "number",
    numeric: MAX_TURNS_NUMERIC,
    describe:
      "Grok --best-of-n <N>: run the task N ways in parallel and pick the best (headless only).",
  },
  {
    flag: "--check",
    requestParameter: "check",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --check: append a self-verification loop to the prompt (headless only).",
  },
  {
    flag: "--disable-web-search",
    requestParameter: "disableWebSearch",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --disable-web-search: disable web search and remote retrieval tools.",
  },
  {
    flag: "--todo-gate",
    requestParameter: "todoGate",
    emit: "flag_if_true",
    inputType: "boolean",
    describe:
      "Grok --todo-gate: enable runtime turn-end TodoGate for this session (session-scoped, not persisted).",
  },
  {
    flag: "--verbatim",
    requestParameter: "verbatim",
    emit: "flag_if_true",
    inputType: "boolean",
    describe:
      "Grok --verbatim: send the prompt exactly as given. Also skips gateway optimizePrompt when true.",
  },
];

/** Emitted after `--agents`, before `--prompt-json`. */
export const GROK_GEN_PROMPT_FILE: readonly FlagGenerationMeta[] = [
  {
    flag: "--prompt-file",
    requestParameter: "promptFile",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe: "Grok --prompt-file <PATH>: single-turn prompt loaded from a file.",
  },
];

/** Emitted after `--prompt-json`, before the tail run. */
export const GROK_GEN_SINGLE: readonly FlagGenerationMeta[] = [
  {
    flag: "--single",
    requestParameter: "single",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe: "Grok --single <PROMPT>: single-turn prompt (in addition to gateway -p).",
  },
];

/** The tail run, emitted before the final `--worktree` special. */
export const GROK_GEN_TAIL: readonly FlagGenerationMeta[] = [
  {
    flag: "--experimental-memory",
    requestParameter: "experimentalMemory",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --experimental-memory: enable cross-session memory.",
  },
  {
    flag: "--no-alt-screen",
    requestParameter: "noAltScreen",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --no-alt-screen: run inline without alt screen.",
  },
  {
    flag: "--no-memory",
    requestParameter: "noMemory",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --no-memory: disable cross-session memory.",
  },
  {
    flag: "--no-plan",
    requestParameter: "noPlan",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --no-plan: disable plan mode.",
  },
  {
    flag: "--no-subagents",
    requestParameter: "noSubagents",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --no-subagents: disable subagent spawning.",
  },
  {
    flag: "--oauth",
    requestParameter: "oauth",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --oauth: use OAuth during authentication.",
  },
  {
    flag: "--restore-code",
    requestParameter: "restoreCode",
    emit: "flag_if_true",
    inputType: "boolean",
    describe: "Grok --restore-code: check out the original session commit when resuming.",
  },
  {
    flag: "--leader-socket",
    requestParameter: "leaderSocket",
    emit: "value_if_present",
    inputType: "string",
    minLength: 1,
    describe:
      "Grok 0.2.32+ --leader-socket <PATH>: custom leader socket path (default ~/.grok/leader.sock). Targets an isolated leader process, e.g. a local/branch Grok build; name it ~/.grok/leader-*.sock to keep `grok leader list/kill` discovery working.",
  },
];

/**
 * The full covered-flag table in emission order — the concatenation of the
 * runs above. Used by the schema-derivation + parity tests (which set only
 * covered params, so the runs are contiguous).
 */
export const GROK_FLAG_GENERATION: readonly FlagGenerationMeta[] = [
  ...GROK_GEN_OUTPUT_FORMAT,
  ...GROK_GEN_MAIN,
  ...GROK_GEN_PROMPT_FILE,
  ...GROK_GEN_SINGLE,
  ...GROK_GEN_TAIL,
];

/**
 * Grok request flags deliberately NOT generated — they need bespoke emit logic
 * that the declarative rules above cannot express. Documented so the POC's
 * coverage boundary is explicit (and so a future slice can attack them):
 *
 * - `--model`         value is `resolveModelAlias(...)`, not a raw param.
 * - `--always-approve` / `--permission-mode` mutually-exclusive, gated on the
 *                       computed `effectiveAlwaysApprove`.
 * - `--agents`        JSON string-or-map with validation.
 * - `--prompt-json`   JSON serialisation + non-empty validation.
 * - `--worktree`      boolean-or-string (bare flag vs `--worktree <name>`).
 * - `-p` / `--resume` / `--continue` prompt positional + session args, assembled
 *                       outside the flag block.
 */
export const UNGENERATED_GROK_FLAGS: readonly string[] = [
  "--model",
  "--always-approve",
  "--permission-mode",
  "--agents",
  "--prompt-json",
  "--worktree",
  "-p",
  "--resume",
  "--continue",
];
