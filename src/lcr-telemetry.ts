/**
 * Least-cost-routing (LCR) per-provider telemetry-tier map (phase_2, DAG step
 * `routing-resources`; grounded in `docs/plans/least-cost-routing.dag.toml`
 * `[cost_model.*]`, whose source of truth is spec section 4.1a).
 *
 * The tier says HOW a provider's per-request economics reach the gateway, which
 * in turn tells the router how much to trust a pre-flight estimate versus a
 * reported/derived cost:
 *   - T1: provider reports a dollar cost directly (most reliable).
 *   - T2: provider reports token COUNTS only; cost is DERIVED from counts x rate.
 *   - T3: transport-conditional (usage depends on which transport carried the
 *         request); see grok below.
 *   - T4: no per-request usage at all; the router has only its pre-flight
 *         estimate (confidence: low).
 *
 * Per-provider derivation (traced to `[cost_model.<provider>].telemetry_tier`):
 *   - claude  = T1  (total_cost_usd in the stream-json result).
 *   - codex   = T2  (JSONL rarely emits cost_usd; derived from counts).
 *   - gemini  = T2  (no $cost; token counts present, cost derived).
 *   - grok    = T3  (DAG `T2_acp__T4_cli`: T2 when routed via the operator-gated
 *                    ACP transport whose _meta counts are threaded, T4 on the
 *                    default `-p` transport which emits no usage). Surfaced here
 *                    as the single conditional label T3.
 *   - mistral = T1  (off-disk vibe meta.json cost when found).
 *   - devin   = T4  (no usage; pre-flight estimate only).
 *   - cursor  = T4  (no usage; pre-flight estimate only).
 *
 * API-backed providers (`[cost_model.api_providers].telemetry_tier =
 * "T1_or_T2"`) also report either a dollar cost (T1) or token counts to derive
 * from (T2). We return T2 as the SAFE DEFAULT for any provider outside the CLI
 * set: it never over-claims a reported dollar cost the router does not have, and
 * it still lets counts-based derivation apply where usage is present.
 *
 * Pure and dependency-free apart from the CliType enum source; no I/O, no clock.
 */

import { CLI_TYPES, type CliType } from "./provider-types.js";

/** LCR telemetry tier for a provider (see module header for meaning). */
export type TelemetryTier = "T1" | "T2" | "T3" | "T4";

/**
 * Per-CLI tier, keyed by CliType so a `satisfies Record<CliType, ...>` catches a
 * missing/renamed provider at compile time. Object keys are NOT a double-quoted
 * provider-name array, so `provider:surfaces:check` stays green (it derives from
 * the CLI_TYPES enum source, never a hand-spelled parallel list).
 */
const CLI_TELEMETRY_TIERS = {
  claude: "T1",
  codex: "T2",
  gemini: "T2",
  grok: "T3",
  mistral: "T1",
  devin: "T4",
  cursor: "T4",
} satisfies Record<CliType, TelemetryTier>;

/** Safe default for API-backed / unknown providers (DAG `T1_or_T2`). */
const DEFAULT_TELEMETRY_TIER: TelemetryTier = "T2";

/**
 * The telemetry tier for a provider id. CLI providers resolve from the
 * compile-checked CLI_TELEMETRY_TIERS map; anything else (API providers such as
 * "grok-api", or an unrecognised id) falls back to the T2 counts-derivable
 * default. Accepts a plain string so a logged `requests.cli` brand can be passed
 * straight through.
 */
export function telemetryTierFor(provider: string): TelemetryTier {
  if ((CLI_TYPES as readonly string[]).includes(provider)) {
    return CLI_TELEMETRY_TIERS[provider as CliType];
  }
  return DEFAULT_TELEMETRY_TIER;
}
