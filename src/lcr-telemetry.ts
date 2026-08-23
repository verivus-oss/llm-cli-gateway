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
 *   - gemini  = T4  (NO usage of any kind). This was T2 until 3.1.0 on the
 *                    strength of a gemini arm in `extractUsageAndCost` and a
 *                    `gemini-json-parser`. Neither is reachable: the adapter
 *                    rejects `json` and `stream-json` BEFORE spawn, because the
 *                    Antigravity `agy` headless path emits text only. Live
 *                    evidence: 0 of 2241 gemini flight-recorder rows carry token
 *                    counts. The T2 label was published through `doctor --json`,
 *                    the MCP capability resource and `provider_tool_capabilities`,
 *                    so the router and every caller were told a dollar cost could
 *                    be derived that never can be.
 *   - grok    = T3  (DAG `T2_acp__T4_cli`: T2 when routed via the operator-gated
 *                    ACP transport whose _meta counts are threaded, T4 on the
 *                    default `-p` transport which emits no usage). Surfaced here
 *                    as the single conditional label T3.
 *   - mistral = T1  (off-disk vibe meta.json cost when found), but read the
 *                    precondition: `parseVibeMetaJson` returns `{}` when the
 *                    session id is absent OR starts with `gw-`, and every FRESH
 *                    mistral request mints a `gw-` id. So T1 is reached only on a
 *                    resume carrying a real Vibe UUID. Live evidence: 0 of 1686
 *                    mistral rows carry usage. Left as T1 because the path is
 *                    genuinely reachable, unlike gemini's, but a router treating
 *                    this as unconditional will over-trust it. Tracked in
 *                    docs/plans/durable-state-remediation.dag.toml.
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
  // T4, not T2: agy headless is text-only and json/stream-json are rejected
  // before spawn, so no usage can ever be extracted. See the module header.
  gemini: "T4",
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
