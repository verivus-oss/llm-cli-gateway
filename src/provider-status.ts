import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CLI_TYPES, type CliType } from "./provider-types.js";
import { getProviderLoginGuidance, type ProviderLoginGuidance } from "./provider-login-guidance.js";
import { apiProviderKeyPresent, isApiProviderEnabled, type ApiProviderConfig } from "./config.js";
import { redactDiagnosticUrl } from "./endpoint-exposure.js";
import {
  envWithExtendedPath,
  getExtendedPath,
  providerCommandName,
  resolveCommandForSpawn,
} from "./executor.js";

export type ProviderLoginStatus = "authenticated" | "not_authenticated" | "unknown" | "not_checked";

export interface ProviderRuntimeStatus {
  provider: CliType;
  displayName: string;
  command: string;
  installed: boolean;
  version: string | null;
  versionCommand: string[];
  loginStatus: ProviderLoginStatus;
  loginCheck: {
    method: "cli" | "credential_store" | "not_checked";
    command: string[] | null;
    credentialStore: "present" | "not_found" | "not_checked";
    detail: string;
  };
  guidance: ProviderLoginGuidance;
}

/**
 * Slice 6: status of a generic `[providers.<name>]` (kind:"api") provider.
 * Unlike a CLI provider there is no spawnable binary or version, so "status" is
 * whether the provider is enabled and whether its API key resolves. Reachability
 * is layered on top by the opt-in doctor probe (kept out of this pure projection
 * so it spends no network). The key value is never exposed, only its presence.
 */
export interface ApiProviderRuntimeStatus {
  provider: string;
  kind: ApiProviderConfig["kind"];
  baseUrl: string;
  defaultModel: string;
  models: string[] | null;
  /** Env var the key is read from, or null for a keyless-local provider. */
  apiKeyEnv: string | null;
  /** Whether the configured key env var resolves to a non-empty value. */
  apiKeyPresent: boolean;
  /** Whether the provider is enabled (key present, or keyless-local loopback). */
  enabled: boolean;
}

export function getApiProviderStatus(
  provider: ApiProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): ApiProviderRuntimeStatus {
  return {
    provider: provider.name,
    kind: provider.kind,
    // Redact any userinfo / sensitive query params before surfacing the URL on a
    // diagnostic surface: base_url is config-supplied and could carry credentials.
    baseUrl: redactDiagnosticUrl(provider.baseUrl) ?? provider.baseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models ?? null,
    apiKeyEnv: provider.apiKeyEnv,
    apiKeyPresent: apiProviderKeyPresent(provider, env),
    enabled: isApiProviderEnabled(provider, env),
  };
}

const VERSION_ARGS = Object.fromEntries(
  CLI_TYPES.map(provider => [provider, ["--version"]])
) as Record<CliType, string[]>;

// Mistral Vibe ships as the `vibe` binary (PyPI package mistral-vibe); the gateway
// uses `mistral` as the provider key but invokes `vibe` on the shell.
export const PROVIDER_COMMANDS: Record<CliType, string> = {
  claude: providerCommandName("claude"),
  codex: providerCommandName("codex"),
  gemini: providerCommandName("gemini"),
  grok: providerCommandName("grok"),
  mistral: providerCommandName("mistral"),
  devin: providerCommandName("devin"),
  cursor: providerCommandName("cursor"),
};

const LOGIN_CHECKS: Partial<Record<CliType, string[]>> = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
  grok: ["inspect", "--json"],
  mistral: ["auth", "status"],
  // `devin auth status` — non-interactive auth check (cli.devin.ai).
  devin: ["auth", "status"],
  cursor: ["status"],
};

export function listProviderRuntimeStatuses(): Record<CliType, ProviderRuntimeStatus> {
  return Object.fromEntries(
    CLI_TYPES.map(provider => [provider, getProviderRuntimeStatus(provider)])
  ) as Record<CliType, ProviderRuntimeStatus>;
}

/** Result of one probe command, the only impure input to status building. */
interface ProbeResult {
  exitCode: number | null;
  output: string;
}

/**
 * Build the installed/version half of a status from the version probe.
 *
 * Pure. Shared by the sync and async orchestrations so the two can never drift
 * on what "installed" means.
 *
 * @param provider Provider key.
 * @param version Result of the version probe.
 * @returns Status with install and version fields resolved, login not yet checked.
 */
function buildBaseStatus(provider: CliType, version: ProbeResult): ProviderRuntimeStatus {
  const guidance = getProviderLoginGuidance(provider);
  const command = PROVIDER_COMMANDS[provider];
  const installed = version.exitCode === 0 || Boolean(version.output);
  const versionText = installed ? firstLine(version.output) : null;

  return {
    provider,
    displayName: guidance.displayName,
    command,
    installed,
    version: versionText,
    versionCommand: [command, ...VERSION_ARGS[provider]],
    loginStatus: installed ? "unknown" : "not_checked",
    loginCheck: {
      method: installed ? "not_checked" : "not_checked",
      command: null,
      credentialStore: "not_checked",
      detail: installed
        ? "No safe non-interactive login check is available."
        : "Runtime is not installed.",
    },
    guidance,
  };
}

/**
 * Antigravity has no safe CLI login check, so its auth state comes from
 * credential stores rather than a probe. Pure with respect to subprocesses.
 *
 * @param base Base status from the version probe.
 * @returns Status with Antigravity login state resolved.
 */
function withGeminiLoginStatus(base: ProviderRuntimeStatus): ProviderRuntimeStatus {
  const auth = geminiAuthStatus();
  const store = auth.status;
  const matchedMethods = Object.entries(auth.methods)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return {
    ...base,
    loginStatus: store === "present" ? "authenticated" : "unknown",
    loginCheck: {
      method: "credential_store",
      command: null,
      credentialStore: store,
      detail:
        store === "present"
          ? `Antigravity auth detected via Gemini-compatible stores: ${matchedMethods.join(", ")}; contents were not inspected.`
          : "Antigravity CLI is installed, but no Gemini-compatible credential store or auth env vars were found (oauth_creds.json, GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT+GOOGLE_GENAI_USE_VERTEXAI).",
    },
  };
}

/**
 * Fold a login-check probe into a status.
 *
 * Pure, and deliberately the ONLY place login status is inferred, so the sync
 * and async paths cannot disagree about whether a provider is authenticated.
 *
 * @param provider Provider key.
 * @param base Base status from the version probe.
 * @param args The login-check argv that was run.
 * @param login Result of the login probe.
 * @returns Status with login state resolved.
 */
function withLoginProbe(
  provider: CliType,
  base: ProviderRuntimeStatus,
  args: string[],
  login: ProbeResult
): ProviderRuntimeStatus {
  const status = inferLoginStatus(provider, login.exitCode, login.output);
  const credentialStore =
    provider === "grok"
      ? grokCredentialStoreStatus()
      : provider === "mistral"
        ? mistralCredentialStoreStatus()
        : "not_checked";
  return {
    ...base,
    loginStatus: status,
    loginCheck: {
      method: "cli",
      command: [base.command, ...args],
      credentialStore,
      detail: loginCheckDetail(provider, status, login.exitCode),
    },
  };
}

export function getProviderRuntimeStatus(provider: CliType): ProviderRuntimeStatus {
  const command = PROVIDER_COMMANDS[provider];
  const base = buildBaseStatus(provider, runCommand(command, VERSION_ARGS[provider], 5_000));
  if (!base.installed) return base;
  if (provider === "gemini") return withGeminiLoginStatus(base);

  const args = LOGIN_CHECKS[provider];
  if (!args) return base;
  return withLoginProbe(provider, base, args, runCommand(command, args, 5_000));
}

/**
 * Async twin of `getProviderRuntimeStatus`.
 *
 * Same decisions, same shared interpretation helpers, but the probes are
 * spawned asynchronously so the caller does not stall the event loop.
 * `getProviderRuntimeStatus` performs up to TWO `spawnSync` calls per provider
 * with 5s timeouts each, so collecting all seven blocked for ~5.3 s measured on
 * a dev host. That is tolerable in `doctor`, a one-shot CLI, and not tolerable
 * in an MCP tool handler, where it freezes the gateway for every other
 * in-flight request.
 *
 * @param provider Provider key.
 * @returns Runtime status, identical in shape and meaning to the sync variant.
 */
export async function getProviderRuntimeStatusAsync(
  provider: CliType
): Promise<ProviderRuntimeStatus> {
  const command = PROVIDER_COMMANDS[provider];
  const base = buildBaseStatus(
    provider,
    await runCommandAsync(command, VERSION_ARGS[provider], 5_000)
  );
  if (!base.installed) return base;
  if (provider === "gemini") return withGeminiLoginStatus(base);

  const args = LOGIN_CHECKS[provider];
  if (!args) return base;
  return withLoginProbe(provider, base, args, await runCommandAsync(command, args, 5_000));
}

/**
 * List every provider's runtime status without blocking the event loop.
 *
 * @returns Status per provider, probed concurrently.
 */
export async function listProviderRuntimeStatusesAsync(): Promise<
  Record<CliType, ProviderRuntimeStatus>
> {
  const entries = await Promise.all(
    CLI_TYPES.map(async provider => [provider, await getProviderRuntimeStatusAsync(provider)])
  );
  return Object.fromEntries(entries) as Record<CliType, ProviderRuntimeStatus>;
}

/**
 * Async twin of `runCommand`.
 *
 * Mirrors it exactly: same resolved command, same extended PATH env, empty
 * stdin, same timeout, same output sanitisation, and the same
 * exitCode/output shape. The only difference is that it does not block the
 * event loop while the child runs.
 *
 * Never rejects. A spawn failure or timeout yields a null exit code and
 * whatever output was captured, which `buildBaseStatus` reads as "not
 * installed", matching the sync path's behaviour on the same failure.
 *
 * @param command Provider command name.
 * @param args Argv.
 * @param timeoutMs Kill the child after this long.
 * @returns Exit code and combined sanitized output.
 */
function runCommandAsync(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ exitCode: number | null; output: string }> {
  const extendedPath = getExtendedPath();
  const env = envWithExtendedPath(process.env, extendedPath);
  const resolved = resolveCommandForSpawn(command, args, { envPath: extendedPath });

  return new Promise(resolve => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output: sanitizeOutput(`${stdout}\n${stderr}`) });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolved.command, resolved.args, {
        env,
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });
    } catch {
      // Mirrors spawnSync's error case: no exit code, no output.
      return resolve({ exitCode: null, output: sanitizeOutput("\n") });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Cap retained output: a runaway provider must not grow this unbounded.
    child.stdout?.on("data", d => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr?.on("data", d => {
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on("error", () => finish(null));
    child.on("close", code => finish(typeof code === "number" ? code : null));
    // Match spawnSync's `input: ""`: close stdin so a prompting CLI sees EOF
    // rather than hanging until the timeout.
    child.stdin?.end();
  });
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): { exitCode: number | null; output: string } {
  const extendedPath = getExtendedPath();
  const env = envWithExtendedPath(process.env, extendedPath);
  const resolved = resolveCommandForSpawn(command, args, { envPath: extendedPath });
  const result = spawnSync(resolved.command, resolved.args, {
    encoding: "utf8",
    env,
    input: "",
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });
  const output = sanitizeOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
  return {
    exitCode: typeof result.status === "number" ? result.status : null,
    output,
  };
}

function firstLine(text: string): string | null {
  return (
    text
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) || null
  );
}

function inferLoginStatus(
  provider: CliType,
  exitCode: number | null,
  output: string
): ProviderLoginStatus {
  if (provider === "claude") {
    try {
      const parsed = JSON.parse(output) as { loggedIn?: boolean };
      if (parsed.loggedIn === true) return "authenticated";
      if (parsed.loggedIn === false) return "not_authenticated";
    } catch {
      // Fall through to text heuristics.
    }
  }

  if (
    /not\s+(logged|signed|authenticated)\s*in|unauthenticated|login required|not authorized/i.test(
      output
    )
  ) {
    return "not_authenticated";
  }
  if (/logged\s*in|signed\s*in|authenticated|authorized|using chatgpt|auth store/i.test(output)) {
    return "authenticated";
  }
  if (provider === "grok" && grokCredentialStoreStatus() === "present") {
    return "authenticated";
  }
  if (provider === "mistral" && mistralCredentialStoreStatus() === "present") {
    return "authenticated";
  }
  if (exitCode && exitCode !== 0) return "unknown";
  return "unknown";
}

function loginCheckDetail(
  provider: CliType,
  status: ProviderLoginStatus,
  exitCode: number | null
): string {
  if (status === "authenticated")
    return `${provider} login check indicates an authenticated local runtime.`;
  if (status === "not_authenticated")
    return `${provider} login check indicates the provider is not authenticated.`;
  if (exitCode && exitCode !== 0)
    return `${provider} login check exited non-zero without exposing credential material.`;
  return `${provider} login check completed, but the output did not clearly indicate login state.`;
}

export interface GeminiAuthMethods {
  oauth: boolean;
  geminiApiKey: boolean;
  googleApiKey: boolean;
  vertexAi: boolean;
}

export interface GeminiAuthStatus {
  status: "present" | "not_found";
  methods: GeminiAuthMethods;
}

/**
 * U27: Detect Gemini auth across all supported methods.
 * Returns "present" if ANY of:
 *   - OAuth credential file present (~/.gemini/oauth_creds.json, etc.)
 *   - GEMINI_API_KEY env var set and non-empty
 *   - GOOGLE_API_KEY env var set and non-empty
 *   - GOOGLE_CLOUD_PROJECT set AND GOOGLE_GENAI_USE_VERTEXAI=true
 */
export function geminiAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): GeminiAuthStatus {
  const candidates = [
    join(home, ".gemini", "oauth_creds.json"),
    join(home, ".gemini", "google_accounts.json"),
    join(home, ".config", "gemini", "oauth_creds.json"),
  ];
  const oauth = candidates.some(p => existsSync(p));
  const geminiApiKey = Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.length > 0);
  const googleApiKey = Boolean(env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.length > 0);
  const vertexAi = Boolean(
    env.GOOGLE_CLOUD_PROJECT &&
    env.GOOGLE_CLOUD_PROJECT.length > 0 &&
    env.GOOGLE_GENAI_USE_VERTEXAI === "true"
  );
  const methods: GeminiAuthMethods = { oauth, geminiApiKey, googleApiKey, vertexAi };
  const status: "present" | "not_found" =
    oauth || geminiApiKey || googleApiKey || vertexAi ? "present" : "not_found";
  return { status, methods };
}

function grokCredentialStoreStatus(): "present" | "not_found" {
  const home = homedir();
  const candidates = [join(home, ".grok", "auth.json"), join(home, ".config", "grok", "auth.json")];
  return candidates.some(path => existsSync(path)) ? "present" : "not_found";
}

function mistralCredentialStoreStatus(): "present" | "not_found" {
  const home = homedir();
  const candidates = [
    join(home, ".vibe", "credentials.json"),
    join(home, ".vibe", "auth.json"),
    join(home, ".config", "vibe", "credentials.json"),
  ];
  return candidates.some(path => existsSync(path)) ? "present" : "not_found";
}

function sanitizeOutput(output: string): string {
  return output
    .replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, "<redacted-email>")
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<redacted-id>")
    .replace(
      /((?:token|secret|credential|password|authorization|api[_-]?key|access[_-]?key)[=:]\s*)\S+/gi,
      "$1<redacted>"
    )
    .trim();
}
