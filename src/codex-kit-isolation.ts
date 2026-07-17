import { createHash } from "crypto";
import type { ChildProcess } from "child_process";
import { isAbsolute, resolve } from "path";
import { realpath } from "fs/promises";
import {
  createProcessGroupTerminationFence,
  envWithExtendedPath,
  getExtendedPath,
  spawnCliProcess,
  unregisterProcessGroup,
} from "./executor.js";
import { isRedirectionEnvKey } from "./spawn-env-isolation.js";

const CODEX_KIT_PROBE_PROMPT = "__gateway_personal_config_skill_probe__";
const MAX_SKILL_PATHS = 512;
const MAX_SKILL_CONFIG_BYTES = 128 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 2_000;

/**
 * Every item here is verified by the installed Codex CLI contract. These
 * controls remove mutable local instruction and tool surfaces for a Kit turn;
 * they do not override provider built-ins or administrator-enforced policy.
 */
const CODEX_KIT_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "multi_agent",
  "memories",
] as const;

export class CodexKitIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexKitIsolationError";
  }
}

export interface CodexKitPromptInspection {
  /** Evidence that the installed CLI exposed a developer-prompt surface. */
  developerMessageCount: number;
  skillPaths: string[];
  skillsBlockCount: number;
  appsBlockCount: number;
}

export interface CodexKitIsolationPlan {
  /** Canonical provider cwd used by both the preflight and the real execution. */
  cwd: string;
  /**
   * Codex is forced to treat `cwd` as its project root, so this is also the
   * only project trust target. This prevents a parent repository's `.codex`
   * layer from being discovered when the selected scope is a nested folder.
   */
  projectRoot: string;
  /** Gateway-owned flags appended after every public Codex override. */
  args: readonly string[];
  /** Explicit removals merged into the inherited provider environment. */
  env: NodeJS.ProcessEnv;
  /** Exact skills disabled after discovery, retained only in process memory. */
  skillPaths: readonly string[];
  /** Digest of the exact gateway-owned context prefix this plan may execute. */
  contextPrefixDigest: string;
  /** Gateway-resolved sandbox control that must match argv preparation. */
  sandboxMode: "read-only" | "workspace-write";
  /** Gateway-resolved caller-facing output format that must match preparation. */
  outputFormat: "text" | "json";
}

/**
 * Pure, non-executable projection of the gateway-owned Codex Kit controls.
 * Request handlers use this only to admit caller-controlled argv before the
 * provider probes run. It is deliberately issued from a separate capability
 * set, so it can never satisfy the verified execution-plan assertion.
 */
export interface CodexKitIsolationProjection extends CodexKitIsolationPlan {
  readonly projectionOnly: true;
}

// Plans are execution capabilities, not a serializable request surface. The
// synchronous argv builder must accept only plans issued by this module after
// a successful two-pass probe, even if another internal caller constructs a
// structurally convincing object.
const issuedPlans = new WeakSet<CodexKitIsolationPlan>();
const issuedProjections = new WeakSet<CodexKitIsolationProjection>();

export type CodexKitPromptProbe = (input: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}) => string | Promise<string>;

export interface CodexKitIsolationOptions {
  /** Exact gateway-owned context prefix, hashed but never retained as text. */
  contextPrefix: string;
  sandboxMode: "read-only" | "workspace-write";
  outputFormat: "text" | "json";
  probe?: CodexKitPromptProbe;
  baseEnv?: NodeJS.ProcessEnv;
}

export type CodexKitIsolationProjectionOptions = Pick<
  CodexKitIsolationOptions,
  "contextPrefix" | "sandboxMode" | "outputFormat"
>;

function digestContextPrefix(contextPrefix: string): string {
  return createHash("sha256").update(contextPrefix).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectInputText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectInputText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "input_text" && typeof value.text === "string") {
    output.push(value.text);
    return;
  }
  for (const nested of Object.values(value)) collectInputText(nested, output);
}

/**
 * Only developer messages can contain a discovered capability block. Limiting
 * parsing to that role prevents a changed fixed probe prompt or provider user
 * echo from being interpreted as a local skill declaration.
 */
function collectDeveloperInputText(value: unknown, output: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + collectDeveloperInputText(item, output), 0);
  }
  if (!isRecord(value)) return 0;
  if (value.type === "message" && value.role === "developer") {
    collectInputText(value.content, output);
    return 1;
  }
  return Object.values(value).reduce<number>(
    (count, nested) => count + collectDeveloperInputText(nested, output),
    0
  );
}

/**
 * Parse the JSON emitted by `codex debug prompt-input` without retaining or
 * logging its raw developer content. The probe uses a fixed gateway string,
 * never a caller task or Kit instruction text.
 */
export function inspectCodexKitPromptInput(raw: string): CodexKitPromptInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexKitIsolationError("Codex Kit isolation probe returned invalid prompt JSON");
  }
  const texts: string[] = [];
  const developerMessageCount = collectDeveloperInputText(parsed, texts);
  let skillsBlockCount = 0;
  let appsBlockCount = 0;
  const paths = new Set<string>();
  const skillPathPattern = /\(file:\s*([^()\r\n]+?[\\/]SKILL\.md)\)/g;
  for (const text of texts) {
    if (text.includes("<skills_instructions>")) {
      skillsBlockCount++;
      for (const match of text.matchAll(skillPathPattern)) {
        const candidate = match[1]?.trim();
        if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) {
          throw new CodexKitIsolationError(
            "Codex Kit isolation probe reported an invalid skill path"
          );
        }
        paths.add(resolve(candidate));
      }
    }
    if (text.includes("<apps_instructions>")) appsBlockCount++;
  }
  if (skillsBlockCount > 0 && paths.size === 0) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation probe found an unparseable discovered-skills block"
    );
  }
  if (paths.size > MAX_SKILL_PATHS) {
    throw new CodexKitIsolationError("Codex Kit isolation probe found too many discovered skills");
  }
  return {
    developerMessageCount,
    skillPaths: [...paths].sort(),
    skillsBlockCount,
    appsBlockCount,
  };
}

/** Emit a TOML override which disables every exact discovered skill path. */
export function buildCodexKitSkillsOverride(skillPaths: readonly string[]): string {
  if (skillPaths.length === 0) return "skills.config=[]";
  const entries = skillPaths.map(path => `{path=${JSON.stringify(path)},enabled=false}`);
  const override = `skills.config=[${entries.join(",")}]`;
  if (Buffer.byteLength(override, "utf8") > MAX_SKILL_CONFIG_BYTES) {
    throw new CodexKitIsolationError("Codex Kit discovered-skills override is too large");
  }
  return override;
}

/**
 * Scrub inherited Codex session/control variables and provider endpoint/proxy
 * redirects. `CODEX_HOME` is retained because it contains the operator's
 * authentication and native session store; the forced flags prevent its
 * mutable config, skills, plugins, hooks, and memories from contributing to
 * the Kit turn.
 */
export function buildCodexKitEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const removals: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(baseEnv)) {
    if (
      (key.toUpperCase().startsWith("CODEX_") && key.toUpperCase() !== "CODEX_HOME") ||
      isRedirectionEnvKey(key)
    ) {
      removals[key] = undefined;
    }
  }
  return removals;
}

function projectTrustOverride(projectRoot: string): string {
  return `projects.${JSON.stringify(projectRoot)}.trust_level="untrusted"`;
}

function staticConfigOverrides(projectRoot: string): string[] {
  return [
    "project_doc_max_bytes=0",
    "project_doc_fallback_filenames=[]",
    // Avoid inherited project-root markers selecting a parent repository.
    "project_root_markers=[]",
    projectTrustOverride(projectRoot),
    'web_search="disabled"',
    "memories.use_memories=false",
    "memories.generate_memories=false",
  ];
}

function appendConfigOverrides(args: string[], overrides: readonly string[]): void {
  for (const override of overrides) args.push("-c", override);
}

function appendDisabledFeatures(args: string[]): void {
  for (const feature of CODEX_KIT_DISABLED_FEATURES) args.push("--disable", feature);
}

function probeArgs(cwd: string, projectRoot: string, configArgs: readonly string[]): string[] {
  const args = ["-C", cwd, "debug", "prompt-input"];
  appendDisabledFeatures(args);
  appendConfigOverrides(args, staticConfigOverrides(projectRoot));
  args.push(...configArgs, CODEX_KIT_PROBE_PROMPT);
  return args;
}

function actualArgs(projectRoot: string, skillsOverride: string): string[] {
  const args = ["--ignore-user-config", "--ignore-rules"];
  appendDisabledFeatures(args);
  appendConfigOverrides(args, staticConfigOverrides(projectRoot));
  args.push("-c", skillsOverride);
  return args;
}

/**
 * Defend internal callers too: a Kit prefix must never be paired with a partial
 * plan that accidentally drops one of the provider controls.
 */
export function assertCodexKitIsolationPlan(
  plan: CodexKitIsolationPlan,
  contextPrefix?: string
): void {
  if (!issuedPlans.has(plan) || !Object.isFrozen(plan)) {
    throw new CodexKitIsolationError("Codex Kit isolation plan was not issued by the gateway");
  }
  if (!isAbsolute(plan.cwd) || !isAbsolute(plan.projectRoot) || plan.cwd !== plan.projectRoot) {
    throw new CodexKitIsolationError("Codex Kit isolation plan has an invalid project root");
  }
  if (!/^[a-f0-9]{64}$/.test(plan.contextPrefixDigest)) {
    throw new CodexKitIsolationError("Codex Kit isolation plan has an invalid context binding");
  }
  if (plan.sandboxMode !== "read-only" && plan.sandboxMode !== "workspace-write") {
    throw new CodexKitIsolationError("Codex Kit isolation plan has an invalid sandbox control");
  }
  if (plan.outputFormat !== "text" && plan.outputFormat !== "json") {
    throw new CodexKitIsolationError("Codex Kit isolation plan has an invalid output control");
  }
  if (
    contextPrefix !== undefined &&
    digestContextPrefix(contextPrefix) !== plan.contextPrefixDigest
  ) {
    throw new CodexKitIsolationError("Codex Kit context does not match its isolation plan");
  }
  const expected = actualArgs(plan.projectRoot, buildCodexKitSkillsOverride(plan.skillPaths));
  if (
    plan.args.length !== expected.length ||
    plan.args.some((arg, index) => arg !== expected[index])
  ) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation plan is missing a required gateway control"
    );
  }
  for (const [key, value] of Object.entries(plan.env)) {
    if (
      (!key.toUpperCase().startsWith("CODEX_") && !isRedirectionEnvKey(key)) ||
      value !== undefined
    ) {
      throw new CodexKitIsolationError("Codex Kit isolation plan has an invalid environment scrub");
    }
  }
}

/**
 * Validate a pure argv-admission projection. A projection contains no probe
 * result and is therefore never valid for provider execution.
 */
export function assertCodexKitIsolationProjection(
  projection: CodexKitIsolationProjection,
  contextPrefix?: string
): void {
  if (!issuedProjections.has(projection) || !Object.isFrozen(projection)) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation projection was not issued by the gateway"
    );
  }
  if (
    !isAbsolute(projection.cwd) ||
    !isAbsolute(projection.projectRoot) ||
    projection.cwd !== projection.projectRoot
  ) {
    throw new CodexKitIsolationError("Codex Kit isolation projection has an invalid project root");
  }
  if (
    contextPrefix !== undefined &&
    digestContextPrefix(contextPrefix) !== projection.contextPrefixDigest
  ) {
    throw new CodexKitIsolationError("Codex Kit context does not match its isolation projection");
  }
  const expected = actualArgs(projection.projectRoot, buildCodexKitSkillsOverride([]));
  if (
    projection.args.length !== expected.length ||
    projection.args.some((arg, index) => arg !== expected[index])
  ) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation projection is missing a required gateway control"
    );
  }
  if (
    projection.env !== EMPTY_CODEX_KIT_PROJECTION_ENV ||
    projection.skillPaths !== EMPTY_CODEX_KIT_PROJECTION_SKILLS ||
    projection.projectionOnly !== true
  ) {
    throw new CodexKitIsolationError("Codex Kit isolation projection is executable or mutable");
  }
}

const EMPTY_CODEX_KIT_PROJECTION_ENV = Object.freeze({}) as NodeJS.ProcessEnv;
const EMPTY_CODEX_KIT_PROJECTION_SKILLS = Object.freeze([]) as readonly string[];

/**
 * Build the complete static Codex Kit argv surface without filesystem reads or
 * provider probes. The dynamic discovered-skills override is represented by
 * its empty form here and is admitted again at its exact post-probe width by
 * the verified execution preparation.
 */
export function createCodexKitIsolationProjection(
  cwd: string,
  options: CodexKitIsolationProjectionOptions
): CodexKitIsolationProjection {
  if (!options.contextPrefix) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation projection requires a non-empty gateway context prefix"
    );
  }
  if (!isAbsolute(cwd)) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation projection requires an absolute execution directory"
    );
  }
  const projection = Object.freeze({
    projectionOnly: true as const,
    cwd,
    projectRoot: cwd,
    args: Object.freeze(actualArgs(cwd, buildCodexKitSkillsOverride([]))),
    env: EMPTY_CODEX_KIT_PROJECTION_ENV,
    skillPaths: EMPTY_CODEX_KIT_PROJECTION_SKILLS,
    contextPrefixDigest: digestContextPrefix(options.contextPrefix),
    sandboxMode: options.sandboxMode,
    outputFormat: options.outputFormat,
  }) as CodexKitIsolationProjection;
  issuedProjections.add(projection);
  assertCodexKitIsolationProjection(projection);
  return projection;
}

function runCodexKitPromptProbeProcess(spawnProbe: () => ChildProcess): Promise<string> {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const child = spawnProbe();
    const cleanupProcessGroup = (): void => {
      if (child.pid) unregisterProcessGroup(child.pid);
    };
    const terminationFence = createProcessGroupTerminationFence(
      child,
      cleanupProcessGroup,
      PROBE_TERMINATION_GRACE_MS
    );
    const rejectFailure = (): void => {
      rejectProbe(
        new CodexKitIsolationError(
          "Codex Kit isolation preflight failed. Verify the installed Codex CLI and retry."
        )
      );
    };
    const finishFailure = (): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      terminationFence.request("SIGTERM");
      rejectFailure();
    };
    const timeout = setTimeout(finishFailure, PROBE_TIMEOUT_MS);
    const handleOutput = (chunk: Buffer, retain: boolean): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        finishFailure();
        return;
      }
      if (retain) stdoutChunks.push(chunk);
    };
    if (!child.stdout || !child.stderr) {
      clearTimeout(timeout);
      finishFailure();
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => handleOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => handleOutput(chunk, false));
    child.once("error", finishFailure);
    child.once("close", code => {
      if (timeout) clearTimeout(timeout);
      // A leader close does not prove that its same-group descendants exited.
      // When failure termination is pending, retain group ownership until the
      // fence targets the original pgid with SIGKILL after the grace window.
      terminationFence.cleanupAfterLeaderExit();
      if (settled) return;
      if (code !== 0) {
        settled = true;
        rejectFailure();
        return;
      }
      settled = true;
      resolveProbe(Buffer.concat(stdoutChunks).toString("utf8"));
    });
  });
}

const runCodexKitPromptProbe: CodexKitPromptProbe = ({ cwd, args, env }) =>
  runCodexKitPromptProbeProcess(() =>
    spawnCliProcess("codex", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  );

/** Exercise the real probe lifecycle with a controlled executable in tests. */
export function runCodexKitPromptProbeForTest(spawnProbe: () => ChildProcess): Promise<string> {
  return runCodexKitPromptProbeProcess(spawnProbe);
}

/**
 * Discover the precise mutable skill paths that the installed Codex binary
 * would inject for this cwd, disable each one, then verify that the final
 * prompt has neither skills nor apps instructions. Raw probe output is never
 * persisted, logged, or included in an MCP response.
 *
 * This is intentionally an asynchronous execution preflight. It runs only
 * immediately before a Codex Kit turn, never for read-only context inspection,
 * and does not block other MCP requests while Codex renders its prompt input.
 */
export async function createCodexKitIsolationPlan(
  cwd: string,
  options: CodexKitIsolationOptions
): Promise<CodexKitIsolationPlan> {
  if (!options.contextPrefix) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation requires a non-empty gateway context prefix"
    );
  }
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    throw new CodexKitIsolationError("Codex Kit execution directory is not available");
  }
  // `project_root_markers=[]` below makes the selected cwd the only project
  // root Codex may inspect. It is safer than relying on a parent Git root when
  // a single developer works in nested repositories or focused subfolders.
  const projectRoot = canonicalCwd;
  const baseEnv = options.baseEnv ?? process.env;
  const removals = buildCodexKitEnvironment(baseEnv);
  const probeEnv = {
    ...envWithExtendedPath(baseEnv, getExtendedPath()),
    ...removals,
  };
  const probe = options.probe ?? runCodexKitPromptProbe;
  const discovered = inspectCodexKitPromptInput(
    await probe({
      cwd: canonicalCwd,
      args: probeArgs(canonicalCwd, projectRoot, []),
      env: probeEnv,
    })
  );
  if (discovered.developerMessageCount === 0) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation preflight could not inspect a developer prompt surface"
    );
  }
  const skillsOverride = buildCodexKitSkillsOverride(discovered.skillPaths);
  const verified = inspectCodexKitPromptInput(
    await probe({
      cwd: canonicalCwd,
      args: probeArgs(canonicalCwd, projectRoot, ["-c", skillsOverride]),
      env: probeEnv,
    })
  );
  if (verified.developerMessageCount === 0) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation preflight could not verify a developer prompt surface"
    );
  }
  if (verified.skillsBlockCount > 0 || verified.appsBlockCount > 0) {
    throw new CodexKitIsolationError(
      "Codex Kit isolation preflight could not disable all discovered skills and apps"
    );
  }
  const plan = Object.freeze({
    cwd: canonicalCwd,
    projectRoot,
    args: Object.freeze(actualArgs(projectRoot, skillsOverride)),
    env: Object.freeze({ ...removals }) as NodeJS.ProcessEnv,
    skillPaths: Object.freeze([...discovered.skillPaths]),
    contextPrefixDigest: digestContextPrefix(options.contextPrefix),
    sandboxMode: options.sandboxMode,
    outputFormat: options.outputFormat,
  }) as CodexKitIsolationPlan;
  issuedPlans.add(plan);
  assertCodexKitIsolationPlan(plan);
  return plan;
}
