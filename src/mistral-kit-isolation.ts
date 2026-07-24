import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Mistral Kit M1: the controlled-environment isolation module (the vibe analog of
 * `codex-kit-isolation.ts`). Vibe has no `--ignore-user-config` flag and no
 * prompt-inspection surface, so instead of scrubbing flags + probing the effective
 * prompt (the Codex model) the gateway CONSTRUCTS a complete, gateway-owned
 * environment: it redirects every home-relative default (`HOME` + `VIBE_HOME`) into
 * a fresh ephemeral dir, leaves the working dir UNTRUSTED so project-local config is
 * inert, disables the keyring, scrubs the bare-name env vars the `VIBE_*` lever
 * cannot reach, and asserts the constructed home's exact file manifest before launch.
 *
 * The lever set + every covered location is enumerated (source-verified against the
 * installed vibe 2.22.0) in docs/plans/mistral-kit-vibe-isolation-enumeration.md.
 *
 * DORMANT (M1): this module only BUILDS and ASSERTS a plan. No request/Kit handler
 * calls it until the M3 gate flip wires it into `prepareMistralRequest`'s mistralEnv.
 */

export class MistralKitIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MistralKitIsolationError";
  }
}

/**
 * Bare-name (un-prefixed) env vars that vibe's nested `BaseSettings` models read
 * WITHOUT the `VIBE_` prefix (ProjectContextConfig / SessionLoggingConfig /
 * ExperimentsConfig, vibe_schema models.py:39-64). The `VIBE_*` EnvironmentLayer
 * does NOT cover these, so a Kit launch must scrub them from the child env.
 */
export const MISTRAL_KIT_ENV_SCRUB: readonly string[] = [
  "SAVE_DIR",
  "SESSION_PREFIX",
  "ENABLED",
  "ENABLE",
  "API_HOST",
  "CLIENT_KEY",
  "DEFAULT_COMMIT_COUNT",
  "TIMEOUT_SECONDS",
];

/**
 * Vibe's builtin skills are always compiled in (skills/manager.py:85), so there is
 * no directory lever to empty the skill set. `enabled_skills` is an allowlist applied
 * to ALL discovered skills; a sentinel that matches nothing yields an empty set.
 */
const KIT_NO_SKILLS_SENTINEL = "__gateway_kit_no_skills__";

/** The exact relative paths the gateway writes under the constructed home. */
const HOME_MANIFEST: readonly string[] = [".vibe", ".vibe/config.toml"];

/**
 * Locations that, if present under the constructed home, mean an ambient surface
 * leaked in (the fail-closed manifest asserts NONE of these exist at build time).
 */
const HOME_FORBIDDEN: readonly string[] = [
  ".agents",
  ".vibe/skills",
  ".vibe/agents",
  ".vibe/tools",
];

export interface MistralKitIsolationPlan {
  /** Gateway-owned ephemeral home; `HOME` points here (so `~/.agents` relocates). */
  readonly home: string;
  /** `<home>/.vibe`; `VIBE_HOME` points here (config, logs/session, trust store). */
  readonly vibeHome: string;
  /** The provider working dir (the Kit scope root). Left UNTRUSTED (no `--trust`). */
  readonly cwd: string;
  /**
   * Env fragment to MERGE into the child env: the HOME/VIBE_HOME redirects, the
   * VIBE_* force-offs, keyring disable, and the api key. Applied by the M3 wiring.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Bare-name env keys to DELETE from the child env (see MISTRAL_KIT_ENV_SCRUB). */
  readonly scrubKeys: readonly string[];
  /**
   * Gateway-owned args. NOTE: `--trust` is deliberately ABSENT so the cwd stays
   * untrusted; `--enabled-tools` restriction and the forced agent mode are added by
   * the caller/M2 (this module owns the environment, not the argv).
   */
  readonly args: readonly string[];
  /** Digest of the exact gateway-owned context prefix this plan may execute. */
  readonly contextPrefixDigest: string;
}

// Plans are execution capabilities issued only by this module after a successful
// build + manifest assertion, never a forgeable request surface.
const issuedPlans = new WeakSet<MistralKitIsolationPlan>();

export interface MistralKitIsolationOptions {
  /** The provider working dir (Kit scope root); stays untrusted. */
  cwd: string;
  /** Exact gateway-owned context prefix; hashed, never retained as text here. */
  contextPrefix: string;
  /** The resolved Mistral API key, provisioned into the child env only. */
  apiKey: string;
  /** Base dir to allocate the ephemeral home under (default: os.tmpdir()). */
  homeRoot?: string;
}

function digestContextPrefix(contextPrefix: string): string {
  return createHash("sha256").update(contextPrefix).digest("hex");
}

/**
 * The gateway-owned baseline `config.toml` written into the redirected VIBE_HOME.
 * Kept minimal and field-verified: session logging ON (so meta.json is written for
 * the M0 native-id capture) and a match-nothing `enabled_skills` allowlist. The
 * boolean force-offs (include_project_context / include_prompt_detail /
 * experimental_enable_registry_skills) ride on VIBE_* env, which is the robust
 * EnvironmentLayer lever; no absolute skill/tool/agent paths are declared.
 */
function buildKitVibeConfigToml(): string {
  return [
    "# Gateway-owned Personal Agent Config Kit baseline (mistral). Constructed per",
    "# attempt under a redirected VIBE_HOME; never the user's real ~/.vibe.",
    `enabled_skills = ["${KIT_NO_SKILLS_SENTINEL}"]`,
    "",
    "[session_logging]",
    "enabled = true",
    "",
  ].join("\n");
}

/**
 * Build the env fragment. HOME + VIBE_HOME are the redirects; the VIBE_* keys force
 * vibe config fields off via the EnvironmentLayer; VIBE_TEST_DISABLE_KEYRING forbids
 * keyring fallback; MISTRAL_API_KEY is the sole credential channel.
 */
function buildKitEnv(home: string, vibeHome: string, apiKey: string): Record<string, string> {
  return {
    HOME: home,
    VIBE_HOME: vibeHome,
    MISTRAL_API_KEY: apiKey,
    VIBE_TEST_DISABLE_KEYRING: "1",
    VIBE_INCLUDE_PROJECT_CONTEXT: "false",
    VIBE_INCLUDE_PROMPT_DETAIL: "false",
    VIBE_EXPERIMENTAL_ENABLE_REGISTRY_SKILLS: "false",
    VIBE_ACP_LOGGING_ENABLED: "false",
  };
}

/**
 * Construct the gateway-owned home and return an asserted isolation plan. Fails
 * closed (MistralKitIsolationError) if the constructed home does not match the exact
 * manifest, if any forbidden ambient surface is present, or if the api key is empty.
 */
export function createMistralKitIsolationPlan(
  options: MistralKitIsolationOptions
): MistralKitIsolationPlan {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new MistralKitIsolationError(
      "mistral Kit isolation requires a non-empty MISTRAL_API_KEY (keyring fallback is forbidden)"
    );
  }

  const base = options.homeRoot ?? tmpdir();
  const home = mkdtempSync(join(base, "gw-mistral-kit-home-"));
  const vibeHome = join(home, ".vibe");
  mkdirSync(vibeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(vibeHome, "config.toml"), buildKitVibeConfigToml(), { mode: 0o600 });

  const plan: MistralKitIsolationPlan = {
    home,
    vibeHome,
    cwd: options.cwd,
    env: Object.freeze(buildKitEnv(home, vibeHome, options.apiKey)),
    scrubKeys: MISTRAL_KIT_ENV_SCRUB,
    args: Object.freeze([] as string[]),
    contextPrefixDigest: digestContextPrefix(options.contextPrefix),
  };

  assertMistralKitIsolationManifest(plan);
  issuedPlans.add(plan);
  return plan;
}

/**
 * Fail-closed assertion that the constructed home is EXACTLY what the gateway wrote:
 * the manifest files are present, no forbidden ambient surface exists, and the env
 * fragment carries the full lever set. This positive construction guarantee is the
 * substitute for vibe's absent effective-prompt inspection.
 */
export function assertMistralKitIsolationManifest(plan: MistralKitIsolationPlan): void {
  for (const rel of HOME_MANIFEST) {
    if (!existsSync(join(plan.home, rel))) {
      throw new MistralKitIsolationError(`mistral Kit home missing required file: ${rel}`);
    }
  }
  for (const rel of HOME_FORBIDDEN) {
    if (existsSync(join(plan.home, rel))) {
      throw new MistralKitIsolationError(
        `mistral Kit home leaked an ambient surface: ${rel} must not exist`
      );
    }
  }
  // The home must contain ONLY the single `.vibe` entry the gateway created.
  const topLevel = readdirSync(plan.home);
  const unexpected = topLevel.filter(name => name !== ".vibe");
  if (unexpected.length > 0) {
    throw new MistralKitIsolationError(
      `mistral Kit home contains unexpected entries: ${unexpected.join(", ")}`
    );
  }
  // The env fragment must carry the exact redirect + hardening lever set.
  const required = [
    "HOME",
    "VIBE_HOME",
    "MISTRAL_API_KEY",
    "VIBE_TEST_DISABLE_KEYRING",
    "VIBE_INCLUDE_PROJECT_CONTEXT",
    "VIBE_INCLUDE_PROMPT_DETAIL",
    "VIBE_EXPERIMENTAL_ENABLE_REGISTRY_SKILLS",
    "VIBE_ACP_LOGGING_ENABLED",
  ];
  for (const key of required) {
    if (!plan.env[key]) {
      throw new MistralKitIsolationError(`mistral Kit env fragment missing lever: ${key}`);
    }
  }
  if (plan.env.HOME !== plan.home || plan.env.VIBE_HOME !== plan.vibeHome) {
    throw new MistralKitIsolationError(
      "mistral Kit env redirects do not match the constructed home"
    );
  }
}

/** True only for a plan this module issued after a successful manifest assertion. */
export function isIssuedMistralKitIsolationPlan(plan: MistralKitIsolationPlan): boolean {
  return issuedPlans.has(plan);
}
