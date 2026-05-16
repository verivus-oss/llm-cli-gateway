import { executeCli } from "./executor.js";
import type { Logger } from "./logger.js";
import type { CliType } from "./session-manager.js";

export interface CliVersionInfo {
  cli: CliType;
  command: string;
  args: string[];
  installed: boolean;
  version?: string;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CliUpgradePlan {
  cli: CliType;
  target: string;
  command: string;
  args: string[];
  strategy: "self-update" | "npm-global-install";
  requiresNetwork: boolean;
  note?: string;
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
};

const NPM_PACKAGES: Record<Exclude<CliType, "claude" | "grok">, string> = {
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
};

export function buildCliUpgradePlan(cli: CliType, target = "latest"): CliUpgradePlan {
  const normalizedTarget = normalizeTarget(target);

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
  } catch (error) {
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
  const clis: CliType[] = cli ? [cli] : ["claude", "codex", "gemini", "grok"];
  return Promise.all(clis.map(item => getCliVersion(item)));
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
