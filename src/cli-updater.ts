import { spawnSync } from "node:child_process";
import { executeCli, providerCommandName } from "./executor.js";
import type { Logger } from "./logger.js";
import { CLI_TYPES, type CliType } from "./provider-types.js";
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
  strategy:
    "self-update" | "npm-global-install" | "pip-install" | "uv-tool-upgrade" | "brew-upgrade";
  requiresNetwork: boolean;
  note?: string;
}

export type MistralInstallMethod = "pip" | "uv" | "brew" | "unknown";

const MISTRAL_VIBE_PACKAGE = "mistral-vibe";
const LEGACY_VIBE_PACKAGE = "vibe-cli";

/**
 * Detect how Vibe was installed on this machine. Vibe does not self-update, so
 * cli_upgrade has to dispatch to the package manager that owns the binary.
 *
 * Probe order: pip → uv → brew. The first one that returns a positive signal
 * wins; if none do, callers should surface an actionable error rather than
 * blindly running `vibe update` (a command that does not exist).
 */
export function detectMistralInstallMethod(
  exec: (cmd: string, args: string[]) => { exitCode: number | null; stdout: string } = (
    cmd,
    args
  ) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return {
      exitCode: typeof result.status === "number" ? result.status : null,
      stdout: result.stdout || "",
    };
  }
): MistralInstallMethod {
  const pip = exec("pip", ["show", MISTRAL_VIBE_PACKAGE]);
  if (pip.exitCode === 0 && /Name:\s*mistral-vibe/i.test(pip.stdout)) {
    return "pip";
  }
  const legacyPip = exec("pip", ["show", LEGACY_VIBE_PACKAGE]);
  if (legacyPip.exitCode === 0 && /Name:\s*vibe-cli/i.test(legacyPip.stdout)) {
    return "pip";
  }
  const uv = exec("uv", ["tool", "list"]);
  if (uv.exitCode === 0 && /\b(?:mistral-vibe|vibe-cli|vibe)\b/i.test(uv.stdout)) {
    return "uv";
  }
  const brew = exec("brew", ["list", MISTRAL_VIBE_PACKAGE]);
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

const VERSION_ARGS = Object.fromEntries(
  CLI_TYPES.map(provider => [provider, ["--version"]])
) as Record<CliType, string[]>;

const CODEX_NPM_PACKAGE = "@openai/codex";

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

  if (cli === "devin") {
    if (normalizedTarget !== "latest") {
      throw new Error("Devin CLI upgrades support only the 'latest' target via 'devin update'.");
    }
    return {
      cli,
      target: normalizedTarget,
      command: "devin",
      args: ["update"],
      strategy: "self-update",
      requiresNetwork: true,
      note: "Devin CLI self-updates via 'devin update' (use --force to reinstall the latest).",
    };
  }

  if (cli === "cursor") {
    if (normalizedTarget !== "latest") {
      throw new Error(
        "Cursor Agent CLI upgrades support only the 'latest' target via 'cursor-agent update'."
      );
    }
    return {
      cli,
      target: normalizedTarget,
      command: providerCommandName("cursor"),
      args: ["update"],
      strategy: "self-update",
      requiresNetwork: true,
      note: "Cursor Agent CLI self-updates via 'cursor-agent update'.",
    };
  }

  if (cli === "gemini") {
    if (normalizedTarget !== "latest") {
      throw new Error(
        "Antigravity CLI upgrades support only the 'latest' target via 'agy update'."
      );
    }
    return {
      cli,
      target: normalizedTarget,
      command: "agy",
      args: ["update"],
      strategy: "self-update",
      requiresNetwork: true,
      note: "Gemini provider requests now run through Google Antigravity CLI (`agy`).",
    };
  }

  return {
    cli,
    target: normalizedTarget,
    command: "npm",
    args: ["install", "-g", `${CODEX_NPM_PACKAGE}@${normalizedTarget}`],
    strategy: "npm-global-install",
    requiresNetwork: true,
    note: "Explicit Codex targets use the documented npm package path; latest can use 'codex update'.",
  };
}

export async function getCliVersion(cli: CliType): Promise<CliVersionInfo> {
  const args = VERSION_ARGS[cli];
  try {
    const status = getProviderRuntimeStatus(cli);
    return {
      cli,
      command: status.command,
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
  const clis: readonly CliType[] = cli ? [cli] : CLI_TYPES;
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
    const pkg =
      normalizedTarget === "latest"
        ? MISTRAL_VIBE_PACKAGE
        : `${MISTRAL_VIBE_PACKAGE}==${normalizedTarget}`;
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
      args: ["tool", "upgrade", MISTRAL_VIBE_PACKAGE],
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
      args: ["upgrade", MISTRAL_VIBE_PACKAGE],
      strategy: "brew-upgrade",
      requiresNetwork: true,
      note:
        normalizedTarget === "latest"
          ? "Mistral Vibe has no self-update command; gateway detected a Homebrew install."
          : "brew upgrade does not honour explicit version targets; running upgrade to latest.",
    };
  }
  throw new Error(
    "Could not detect how Mistral Vibe was installed. Install it via pip (`pip install mistral-vibe`), uv (`uv tool install mistral-vibe`), or Homebrew (`brew install mistral-vibe`) before running cli_upgrade."
  );
}

async function fallbackCliVersion(cli: CliType, args: string[]): Promise<CliVersionInfo | null> {
  try {
    const command = providerCommandName(cli);
    const result = await executeCli(command, args, { timeout: 15_000 });
    return {
      cli,
      command,
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

// Allow only a bare semver-ish version or a simple dist-tag. The target is
// interpolated into package-manager install specs (e.g. `@openai/codex@<target>`
// for `npm install -g`), so characters that change *which* package resolves --
// `:` (npm alias `pkg@npm:other`, git+ssh), `/` (scoped names, URLs/paths),
// `@` (alias separators) -- must be rejected to prevent arbitrary-package
// installation via cli_upgrade.
const UPGRADE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeTarget(target: string): string {
  const normalized = target.trim();
  if (!UPGRADE_TARGET_PATTERN.test(normalized)) {
    throw new Error(
      "Upgrade target must be a bare version or dist-tag (letters, digits, '.', '_', '-'; " +
        "1-64 chars; must start alphanumeric). Package specifiers, aliases, URLs, and paths " +
        "(containing ':', '/', or '@') are not allowed."
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
