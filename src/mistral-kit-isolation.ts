import { createHash } from "crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from "fs";
import { isAbsolute, join } from "path";
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
  /** `<home>/.vibe`; `VIBE_HOME` points here (config, trust store). */
  readonly vibeHome: string;
  /**
   * Gateway-owned STABLE session-log dir written into the config as
   * `[session_logging] save_dir`. Unlike the ephemeral `home`, this persists across
   * requests for the same Kit execution so `vibe --resume <uuid>` (which globs
   * `config.save_dir`) finds a prior turn. It is the disk-capture source for the
   * native handle. Keeping it OUTSIDE the ephemeral home is what lets the home stay
   * strictly manifested (vibe writes session logs here, not into VIBE_HOME).
   */
  readonly sessionDir: string;
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
  /**
   * Absolute, gateway-owned STABLE session-log dir keyed by the Kit execution.
   * Created (0700) and asserted here, then written into the config as
   * `[session_logging] save_dir`. Enables native `--resume` continuity while the
   * home stays ephemeral. Must be an absolute path.
   */
  sessionDir: string;
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
function buildKitVibeConfigToml(sessionDir: string): string {
  return [
    "# Gateway-owned Personal Agent Config Kit baseline (mistral). Constructed per",
    "# attempt under a redirected VIBE_HOME; never the user's real ~/.vibe.",
    `enabled_skills = ["${KIT_NO_SKILLS_SENTINEL}"]`,
    "",
    "[session_logging]",
    "enabled = true",
    // Relocate session logs OUT of the ephemeral VIBE_HOME into a stable
    // gateway-owned dir so `vibe --resume <uuid>` finds prior turns. The value is a
    // gateway-derived path (layout dir + hex), emitted as a TOML basic string.
    `save_dir = ${JSON.stringify(sessionDir)}`,
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
  if (!options.sessionDir || !isAbsolute(options.sessionDir)) {
    throw new MistralKitIsolationError(
      "mistral Kit isolation requires an absolute gateway-owned sessionDir"
    );
  }

  // Create + assert the STABLE session-log dir. It is gateway-owned (0700) and must
  // resolve to a real directory (a pre-existing non-dir or symlink-to-non-dir fails
  // closed). Unlike the home it persists across requests for native --resume.
  const sessionDir = options.sessionDir;
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  let realSessionDir: string;
  try {
    realSessionDir = realpathSync(sessionDir);
  } catch {
    throw new MistralKitIsolationError(`mistral Kit sessionDir is not resolvable: ${sessionDir}`);
  }
  if (!statSync(realSessionDir).isDirectory()) {
    throw new MistralKitIsolationError(`mistral Kit sessionDir is not a directory: ${sessionDir}`);
  }

  const base = options.homeRoot ?? tmpdir();
  const home = mkdtempSync(join(base, "gw-mistral-kit-home-"));
  const vibeHome = join(home, ".vibe");
  mkdirSync(vibeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(vibeHome, "config.toml"), buildKitVibeConfigToml(sessionDir), { mode: 0o600 });

  const plan: MistralKitIsolationPlan = {
    home,
    vibeHome,
    sessionDir,
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

/**
 * Build the final Kit child env from an inherited base. This is the ONLY safe way to
 * apply a plan to a spawn: it STRIPS every ambient `VIBE_*` key and the bare-name
 * scrub vars, THEN applies the gateway env fragment (which re-adds only the gateway's
 * own `VIBE_*`). Merging `plan.env` on top of an inherited env is NOT sufficient,
 * because vibe's EnvironmentLayer applies ambient `VIBE_*` ABOVE the gateway
 * config.toml and `enabled_skills` is ConcatMerge (vibe_schema.py:379): an ambient
 * `VIBE_ENABLED_SKILLS` / `VIBE_SKILL_PATHS` / `VIBE_TOOL_PATHS` / `VIBE_AGENT_PATHS`
 * would re-inject skills/paths and defeat the match-nothing lever (verified on vibe
 * 2.22.0). The M3 spawn wiring MUST route the child env through here.
 */
export function applyMistralKitIsolationEnv(
  baseEnv: NodeJS.ProcessEnv,
  plan: MistralKitIsolationPlan
): NodeJS.ProcessEnv {
  const scrub = new Set(plan.scrubKeys);
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    // Drop ambient VIBE_* injectors (the gateway re-adds only its own below) and the
    // bare-name BaseSettings vars the VIBE_* lever cannot reach.
    if (/^VIBE_/i.test(key)) continue;
    if (scrub.has(key)) continue;
    child[key] = value;
  }
  // Gateway levers win, incl. the gateway's own VIBE_* and the redirected HOME.
  Object.assign(child, plan.env);
  return child;
}

/**
 * Mistral Kit (M3): the executor-compatible projection of {@link applyMistralKitIsolationEnv}.
 *
 * The gateway executor merges the per-request env fragment OVER the (extended-PATH)
 * inherited process env (`{ ...baseEnv, ...extraEnv }`); it never replaces the env
 * wholesale, and `assertUpstreamCliEnv` allowlists every REAL key in the fragment. So
 * the full controlled env that `applyMistralKitIsolationEnv` returns is the wrong shape
 * for the spawn: passing it would (a) re-inherit ambient `VIBE_*`/scrub keys that the
 * merge does not delete, and (b) present every inherited key to the env allowlist.
 *
 * This returns a DELETE-FRAGMENT instead: `undefined` for every ambient `VIBE_*` and
 * bare-name scrub key (the executor drops `undefined` at the spawn boundary, and the
 * env-contract validator skips them), plus the gateway lever set from `plan.env` as the
 * only real values. Merged over the extended-PATH base it yields exactly the controlled
 * env, while keeping the fragment's real keys inside the mistral env allowlist and
 * leaving PATH to the executor's extended-PATH logic. The gateway's own resolved
 * `VIBE_ACTIVE_MODEL` (deleted here as an ambient `VIBE_*`) is re-applied by the caller.
 */
export function mistralKitSpawnEnvFragment(
  baseEnv: NodeJS.ProcessEnv,
  plan: MistralKitIsolationPlan
): NodeJS.ProcessEnv {
  if (!isIssuedMistralKitIsolationPlan(plan)) {
    throw new MistralKitIsolationError(
      "mistral Kit spawn env fragment requires a plan issued by createMistralKitIsolationPlan"
    );
  }
  const scrub = new Set(plan.scrubKeys);
  const fragment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(baseEnv)) {
    // Delete ambient VIBE_* injectors and the bare-name BaseSettings vars the
    // VIBE_* lever cannot reach; the gateway re-adds only its own below.
    if (/^VIBE_/i.test(key) || scrub.has(key)) fragment[key] = undefined;
  }
  // Gateway levers win (HOME/VIBE_HOME redirects, keyring disable, api key, the
  // gateway's own VIBE_* force-offs). All are inside the mistral env allowlist.
  Object.assign(fragment, plan.env);
  return fragment;
}

/**
 * Mistral Kit (M2): context delivery. Vibe's VIBE_HOME-level `AGENTS.md` channel is
 * gated on `include_project_context`, which the isolation forces OFF, so the compiled
 * Kit context is delivered as a PROMPT PREFIX: the `<gateway-personal-config stamp=...>`
 * marker precedes the caller task (mirrors the Codex prompt-input delivery). Dormant
 * until the M3 gate flip wires the mistral Kit request path.
 */
export function composeMistralKitPrompt(contextPrefix: string, userPrompt: string): string {
  return `${contextPrefix}\n\n${userPrompt}`;
}

/**
 * Fail-closed drift check: the context prefix delivered at execution MUST match the
 * digest bound into the plan at build time. A mismatch means the compiled context
 * drifted from what was admitted, so the run is refused rather than executed with an
 * unverified instruction layer.
 */
export function assertMistralKitContextPrefix(
  plan: MistralKitIsolationPlan,
  contextPrefix: string
): void {
  if (digestContextPrefix(contextPrefix) !== plan.contextPrefixDigest) {
    throw new MistralKitIsolationError(
      "mistral Kit context prefix does not match the digest bound into the isolation plan"
    );
  }
}
