import { spawnSync } from "node:child_process";
import { executeCli } from "./executor.js";
import type { Logger } from "./logger.js";
import type { CliType } from "./session-manager.js";
import { getProviderRuntimeStatus, type ProviderLoginStatus } from "./provider-status.js";
import type { ProviderLoginGuidance } from "./provider-login-guidance.js";

export interface CliVersionInfo {
  cli: CliType;
  command: string;
  args: string[];
  installed: boolean;
  version?: string;
  loginStatus?: ProviderLoginStatus;
  loginGuidance?: ProviderLoginGuidance["login"];
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CliUpgradePlan {
  cli: CliType;
  target: string;
  command: string;
  args: string[];
  strategy: "self-update" | "npm-global-install" | "pip-install" | "uv-tool-upgrade" | "brew-upgrade";
  requiresNetwork: boolean;
  note?: string;
}

export type MistralInstallMethod = "pip" | "uv" | "brew" | "unknown";

/**
 * Detect how Vibe was installed on this machine. Vibe does not self-update, so
 * cli_upgrade has to dispatch to the package manager that owns the binary.
 *
 * Probe order: pip → uv → brew. The first one that returns a positive signal
 * wins; if none do, callers should surface an actionable error rather than
 * blindly running `vibe update` (a command that does not exist).
 */
export function detectMistralInstallMethod(
  exec: (cmd: string, args: string[]) => { exitCode: number | null; stdout: string } = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return {
      exitCode: typeof result.status === "number" ? result.status : null,
      stdout: result.stdout || "",
    };
  }
): MistralInstallMethod {
  const pip = exec("pip", ["show", "vibe-cli"]);
  if (pip.exitCode === 0 && /Name:\s*vibe-cli/i.test(pip.stdout)) {
    return "pip";
  }
  const uv = exec("uv", ["tool", "list"]);
  if (uv.exitCode === 0 && /\bvibe(?:-cli)?\b/i.test(uv.stdout)) {
    return "uv";
  }
  const brew = exec("brew", ["list", "mistral-vibe"]);
  if (brew.exitCode === 0) {
    return "brew";
  }
  return "unknown";
}

export interface CliUpgradeResult {
  dryRun: boolean;
  plan: CliUpgradePlan;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const VERSION_ARGS: Record<CliType, string[]> = {
  claude: ["--version"],
  codex: ["--version"],
  gemini: ["--version"],
  grok: ["--version"],
  mistral: ["--version"],
};

const NPM_PACKAGES: Record<Exclude<CliType, "claude" | "grok" | "mistral">, string> = {
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
};

export function buildCliUpgradePlan(
  cli: CliType,
  target = "latest",
  detectMistral: () => MistralInstallMethod = detectMistralInstallMethod
): CliUpgradePlan {
  const normalizedTarget = normalizeTarget(target);

  if (cli === "mistral") {
    return buildMistralUpgradePlan(normalizedTarget, detectMistral);
  }

  if (cli === "claude") {
    if (normalizedTarget === "latest") {
      return {
        cli,
        target: normalizedTarget,
        command: "claude",
        args: ["update"],
        strategy: "self-update",
        requiresNetwork: true,
      };
    }
    return {
      cli,
      target: normalizedTarget,
      command: "claude",
      args: ["install", normalizedTarget],
      strategy: "self-update",
      requiresNetwork: true,
      note: "Claude Code supports explicit install targets through 'claude install <target>'.",
    };
  }

  if (cli === "grok") {
    if (normalizedTarget === "latest") {
      return {
        cli,
        target: normalizedTarget,
        command: "grok",
        args: ["update"],
        strategy: "self-update",
        requiresNetwork: true,
      };
    }
    return {
      cli,
      target: normalizedTarget,
      command: "grok",
      args: ["update", "--version", normalizedTarget],
      strategy: "self-update",
      requiresNetwork: true,
      note: "Grok CLI supports explicit version targets via 'grok update --version <target>'.",
    };
  }

  if (cli === "codex" && normalizedTarget === "latest") {
    return {
      cli,
      target: normalizedTarget,
      command: "codex",
      args: ["update"],
      strategy: "self-update",
      requiresNetwork: true,
    };
  }

  const packageName = cli === "codex" ? NPM_PACKAGES.codex : NPM_PACKAGES.gemini;
  return {
    cli,
    target: normalizedTarget,
    command: "npm",
    args: ["install", "-g", `${packageName}@${normalizedTarget}`],
    strategy: "npm-global-install",
    requiresNetwork: true,
    note:
      cli === "codex"
        ? "Explicit Codex targets use the documented npm package path; latest can use 'codex update'."
        : "Gemini CLI does not expose a self-update command in the gateway-supported CLI surface, so upgrades use npm.",
  };
}

export async function getCliVersion(cli: CliType): Promise<CliVersionInfo> {
  const args = VERSION_ARGS[cli];
  try {
    const status = getProviderRuntimeStatus(cli);
    return {
      cli,
      command: cli,
      args,
      installed: status.installed,
      version: status.version || undefined,
      loginStatus: status.loginStatus,
      loginGuidance: status.guidance.login,
      stdout: status.version || "",
      stderr: "",
    };
  } catch (error) {
    const result = await fallbackCliVersion(cli, args);
    if (result) return result;
    const message = error instanceof Error ? error.message : String(error);
    return {
      cli,
      command: cli,
      args,
      installed: false,
      stdout: "",
      stderr: "",
      error: message,
    };
  }
}

export async function getCliVersions(cli?: CliType): Promise<CliVersionInfo[]> {
  const clis: CliType[] = cli ? [cli] : ["claude", "codex", "gemini", "grok", "mistral"];
  return Promise.all(clis.map(item => getCliVersion(item)));
}

function buildMistralUpgradePlan(
  normalizedTarget: string,
  detectMistral: () => MistralInstallMethod
): CliUpgradePlan {
  const method = detectMistral();
  // Vibe ships no self-update command. cli_upgrade dispatches to the installer
  // it detects; if none can be detected the caller gets an actionable error
  // (we surface it as a no-op plan with `command: ""` so runCliUpgrade can
  // throw before spawning anything).
  if (method === "pip") {
    const pkg = normalizedTarget === "latest" ? "vibe-cli" : `vibe-cli==${normalizedTarget}`;
    return {
      cli: "mistral",
      target: normalizedTarget,
      command: "pip",
      args: ["install", "-U", pkg],
      strategy: "pip-install",
      requiresNetwork: true,
      note: "Mistral Vibe has no self-update command; gateway detected a pip install.",
    };
  }
  if (method === "uv") {
    return {
      cli: "mistral",
      target: normalizedTarget,
      command: "uv",
      args: ["tool", "upgrade", "vibe-cli"],
      strategy: "uv-tool-upgrade",
      requiresNetwork: true,
      note:
        normalizedTarget === "latest"
          ? "Mistral Vibe has no self-update command; gateway detected a uv tool install."
          : "uv tool upgrade does not honour explicit version targets; running upgrade to latest.",
    };
  }
  if (method === "brew") {
    return {
      cli: "mistral",
      target: normalizedTarget,
      command: "brew",
      args: ["upgrade", "mistral-vibe"],
      strategy: "brew-upgrade",
      requiresNetwork: true,
      note:
        normalizedTarget === "latest"
          ? "Mistral Vibe has no self-update command; gateway detected a Homebrew install."
          : "brew upgrade does not honour explicit version targets; running upgrade to latest.",
    };
  }
  throw new Error(
    "Could not detect how Mistral Vibe was installed. Install it via pip (`pip install vibe-cli`), uv (`uv tool install vibe-cli`), or Homebrew (`brew install mistral-vibe`) before running cli_upgrade."
  );
}

async function fallbackCliVersion(cli: CliType, args: string[]): Promise<CliVersionInfo | null> {
  try {
    const result = await executeCli(cli, args, { timeout: 15_000 });
    return {
      cli,
      command: cli,
      args,
      installed: true,
      version: extractVersion(result.stdout, result.stderr),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch {
    return null;
  }
}

export async function runCliUpgrade(params: {
  cli: CliType;
  target?: string;
  dryRun: boolean;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<CliUpgradeResult> {
  const plan = buildCliUpgradePlan(params.cli, params.target);
  if (params.dryRun) {
    return { dryRun: true, plan };
  }

  params.logger?.info(`Upgrading ${params.cli} CLI`, {
    target: plan.target,
    command: plan.command,
    args: plan.args,
  });
  const result = await executeCli(plan.command, plan.args, {
    timeout: params.timeoutMs ?? 600_000,
    logger: params.logger,
  });
  return {
    dryRun: false,
    plan,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

function normalizeTarget(target: string): string {
  const normalized = target.trim();
  if (!normalized || normalized.startsWith("-") || /[\u0000-\u001f\u007f\s]/.test(normalized)) {
    throw new Error(
      "Upgrade target must be a non-empty package tag or version without whitespace and cannot start with '-'"
    );
  }
  return normalized;
}

function extractVersion(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  return text || undefined;
}
