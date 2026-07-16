import type { CliType } from "./session-manager.js";
import type { ApiProviderConfig } from "./config.js";
import { redactDiagnosticUrl } from "./endpoint-exposure.js";

export interface ProviderLoginGuidance {
  provider: CliType;
  displayName: string;
  install: {
    summary: string;
    commands: string[];
    documentationUrl?: string;
  };
  login: {
    summary: string;
    commands: string[];
    credentialHandling: string;
  };
  verification: {
    command: string;
    expected: string;
  };
}

const GUIDANCE: Record<CliType, ProviderLoginGuidance> = {
  claude: {
    provider: "claude",
    displayName: "Claude Code",
    install: {
      summary: "Install Claude Code using Anthropic's current official installer.",
      commands: ["npm install -g @anthropic-ai/claude-code"],
      documentationUrl: "https://docs.anthropic.com/claude-code",
    },
    login: {
      summary: "Sign in through Claude Code's official browser/device flow.",
      commands: ["claude auth login"],
      credentialHandling:
        "Do not paste Claude passwords, OAuth tokens, or credential files into the gateway or a remote chat.",
    },
    verification: {
      command: "claude auth status --json",
      expected: "loggedIn is true",
    },
  },
  codex: {
    provider: "codex",
    displayName: "Codex CLI",
    install: {
      summary: "Install Codex CLI using OpenAI's npm package or the current official installer.",
      commands: ["npm install -g @openai/codex"],
      documentationUrl: "https://developers.openai.com/codex",
    },
    login: {
      summary: "Sign in through Codex's official login flow.",
      commands: ["codex login", "codex login --device-auth"],
      credentialHandling:
        "Prefer browser or device-code login. Do not paste API keys or access tokens into assistant prompts.",
    },
    verification: {
      command: "codex login status",
      expected: "command reports that Codex is logged in",
    },
  },
  gemini: {
    provider: "gemini",
    displayName: "Google Antigravity CLI",
    install: {
      summary: "Install Google Antigravity CLI using Google's current official installer.",
      commands: ["curl -fsSL https://antigravity.google/cli/install.sh | bash"],
      documentationUrl: "https://antigravity.google/docs/cli-overview",
    },
    login: {
      summary: "Run Antigravity CLI and complete Google's official sign-in flow when prompted.",
      commands: ["agy"],
      credentialHandling:
        "Let Antigravity store credentials in its own local store. Do not paste OAuth files or API keys into chat.",
    },
    verification: {
      command: "agy --version",
      expected:
        "CLI is installed; doctor checks local Gemini-compatible credential stores for login evidence",
    },
  },
  grok: {
    provider: "grok",
    displayName: "Grok Build",
    install: {
      summary: "Install Grok Build using xAI's current official installer or managed update flow.",
      commands: ["curl -fsSL https://x.ai/cli/install.sh | bash"],
      documentationUrl: "https://docs.x.ai/build/overview",
    },
    login: {
      summary: "Sign in through Grok's official OAuth or device-code flow.",
      commands: ["grok login --oauth", "grok login --device-auth"],
      credentialHandling:
        "For headless environments, set XAI_API_KEY in the local shell. Do not paste xAI API keys, OAuth tokens, or Grok auth files into the gateway or a remote chat.",
    },
    verification: {
      command: "grok inspect --json",
      expected: "CLI can inspect local configuration and a local auth store is present",
    },
  },
  mistral: {
    provider: "mistral",
    displayName: "Mistral Vibe CLI",
    install: {
      summary:
        "Install Mistral Vibe CLI via pip, uv, or Homebrew (Vibe does not self-update; cli_upgrade dispatches to the installer it detects).",
      commands: [
        "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        "pip install mistral-vibe",
        "uv tool install mistral-vibe",
        "brew install mistral-vibe",
      ],
      documentationUrl: "https://docs.mistral.ai/mistral-vibe/overview",
    },
    login: {
      summary:
        "Run vibe --setup to configure a Mistral API key locally. Current Vibe defaults session logging to enabled; if an older config disabled it, edit ~/.vibe/config.toml and set [session_logging] enabled = true.",
      commands: ["vibe --setup"],
      credentialHandling:
        "Do not paste Mistral API keys, OAuth tokens, or ~/.vibe/credentials into the gateway or a remote chat.",
    },
    verification: {
      command: "vibe --version",
      expected:
        "Vibe CLI is installed; doctor checks ~/.vibe/config.toml for an explicit session_logging.enabled=false override",
    },
  },
  devin: {
    provider: "devin",
    displayName: "Devin CLI",
    install: {
      summary: "Install Devin CLI using Cognition's current official installer.",
      commands: [
        "curl -fsSL https://cli.devin.ai/install.sh | bash",
        "irm https://static.devin.ai/cli/setup.ps1 | iex",
      ],
      documentationUrl: "https://docs.devin.ai/cli",
    },
    login: {
      summary: "Sign in through Devin CLI's official browser OAuth flow.",
      commands: ["devin auth login", "devin auth login --force-manual-token-flow"],
      credentialHandling:
        "Let Devin store credentials via `devin auth login` (or WINDSURF_API_KEY for ACP). Do not paste Devin tokens or cog_* keys into the gateway or a remote chat.",
    },
    verification: {
      command: "devin auth status",
      expected: "CLI is installed and `devin auth status` reports an authenticated session",
    },
  },
  cursor: {
    provider: "cursor",
    displayName: "Cursor Agent CLI",
    install: {
      summary: "Install Cursor Agent CLI using Cursor's current official installer.",
      commands: ["cursor-agent update", "cursor-agent --version"],
      documentationUrl: "https://cursor.com/cli",
    },
    login: {
      summary:
        "Sign in through Cursor Agent's official login flow, or set CURSOR_API_KEY for headless automation.",
      commands: ["cursor-agent login", "cursor-agent status"],
      credentialHandling:
        "Let Cursor store credentials via `cursor-agent login`, or provide CURSOR_API_KEY in the process environment. Do not paste Cursor API keys into prompts or remote chats.",
    },
    verification: {
      command: "cursor-agent status",
      expected: "CLI is installed and `cursor-agent status` reports an authenticated account",
    },
  },
};

export function getProviderLoginGuidance(provider: CliType): ProviderLoginGuidance {
  return GUIDANCE[provider];
}

export function getAllProviderLoginGuidance(): Record<CliType, ProviderLoginGuidance> {
  return { ...GUIDANCE };
}

/**
 * Slice 6: login guidance for a generic `[providers.<name>]` (kind:"api")
 * provider. Unlike a CLI there is nothing to install or browser-login: the
 * caller just sets the configured key env var (or nothing, for a keyless-local
 * loopback provider). Reports the env var NAME and base_url only, never a key.
 */
export interface ApiProviderLoginGuidance {
  provider: string;
  displayName: string;
  kind: ApiProviderConfig["kind"];
  baseUrl: string;
  /** Env var the key is read from, or null for a keyless-local provider. */
  apiKeyEnv: string | null;
  summary: string;
  steps: string[];
  credentialHandling: string;
}

export function getApiProviderLoginGuidance(provider: ApiProviderConfig): ApiProviderLoginGuidance {
  const keyless = provider.apiKeyEnv === null;
  // Redact any userinfo / sensitive query params before surfacing the URL: this
  // guidance is a diagnostic surface and base_url is config-supplied, so it could
  // carry credentials that must not be echoed.
  const baseUrl = redactDiagnosticUrl(provider.baseUrl) ?? provider.baseUrl;
  const summary = keyless
    ? `Keyless-local API provider "${provider.name}" (kind: ${provider.kind}); no credential is required for its loopback endpoint.`
    : `API provider "${provider.name}" (kind: ${provider.kind}) authenticates with a key read from the ${provider.apiKeyEnv} environment variable.`;
  const steps = keyless
    ? [
        `Ensure the local endpoint at ${baseUrl} is running (e.g. Ollama or llama.cpp).`,
        `No API key is needed; the provider is enabled as soon as the loopback endpoint is reachable.`,
      ]
    : [
        `Obtain an API key from the provider that serves ${baseUrl}.`,
        `Export it as ${provider.apiKeyEnv} in the gateway's environment (the value is read only at request time).`,
        `Confirm [providers.${provider.name}] in the gateway config points at the intended base_url and default_model.`,
      ];
  return {
    provider: provider.name,
    displayName: provider.name,
    kind: provider.kind,
    baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    summary,
    steps,
    credentialHandling:
      "Set the API key only via the named environment variable. Do not paste the key into the gateway config, prompts, or a remote chat.",
  };
}
