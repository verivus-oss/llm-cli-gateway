import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { CliType } from "./session-manager.js";
import { getProviderLoginGuidance, type ProviderLoginGuidance } from "./provider-login-guidance.js";
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

const PROVIDERS: CliType[] = ["claude", "codex", "gemini", "grok", "mistral"];
const VERSION_ARGS: Record<CliType, string[]> = {
  claude: ["--version"],
  codex: ["--version"],
  gemini: ["--version"],
  grok: ["--version"],
  mistral: ["--version"],
};

// Mistral Vibe ships as the `vibe` binary (PyPI package mistral-vibe); the gateway
// uses `mistral` as the provider key but invokes `vibe` on the shell.
export const PROVIDER_COMMANDS: Record<CliType, string> = {
  claude: "claude",
  codex: "codex",
  gemini: providerCommandName("gemini"),
  grok: "grok",
  mistral: providerCommandName("mistral"),
};

const LOGIN_CHECKS: Partial<Record<CliType, string[]>> = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
  grok: ["inspect", "--json"],
  mistral: ["auth", "status"],
};

export function listProviderRuntimeStatuses(): Record<CliType, ProviderRuntimeStatus> {
  return Object.fromEntries(
    PROVIDERS.map(provider => [provider, getProviderRuntimeStatus(provider)])
  ) as Record<CliType, ProviderRuntimeStatus>;
}

export function getProviderRuntimeStatus(provider: CliType): ProviderRuntimeStatus {
  const guidance = getProviderLoginGuidance(provider);
  const command = PROVIDER_COMMANDS[provider];
  const version = runCommand(command, VERSION_ARGS[provider], 5_000);
  const installed = version.exitCode === 0 || Boolean(version.output);
  const versionText = installed ? firstLine(version.output) : null;

  const base: ProviderRuntimeStatus = {
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

  if (!installed) return base;

  if (provider === "gemini") {
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

  const args = LOGIN_CHECKS[provider];
  if (!args) return base;

  const login = runCommand(command, args, 5_000);
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
      command: [command, ...args],
      credentialStore,
      detail: loginCheckDetail(provider, status, login.exitCode),
    },
  };
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
