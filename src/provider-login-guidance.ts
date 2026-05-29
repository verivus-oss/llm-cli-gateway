import type { CliType } from "./session-manager.js";

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
    displayName: "Gemini CLI",
    install: {
      summary: "Install Gemini CLI using Google's npm package or current official installer.",
      commands: ["npm install -g @google/gemini-cli"],
      documentationUrl: "https://github.com/google-gemini/gemini-cli",
    },
    login: {
      summary: "Run Gemini CLI and complete Google's official sign-in flow when prompted.",
      commands: ["gemini"],
      credentialHandling:
        "Let Gemini CLI store credentials in its own local store. Do not paste OAuth files or API keys into chat.",
    },
    verification: {
      command: "gemini --version",
      expected:
        "CLI is installed; doctor checks the local Gemini credential store for login evidence",
    },
  },
  grok: {
    provider: "grok",
    displayName: "Grok CLI",
    install: {
      summary: "Install Grok CLI using xAI's current official installer or managed update flow.",
      commands: ["npm install -g grok-build"],
      documentationUrl: "https://docs.x.ai/build/cli",
    },
    login: {
      summary: "Sign in through Grok's official OAuth or device-code flow.",
      commands: ["grok login --oauth", "grok login --device-auth"],
      credentialHandling:
        "Do not paste xAI API keys, OAuth tokens, or Grok auth files into the gateway or a remote chat.",
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
        "Sign in through Mistral's official auth flow. Current Vibe defaults session logging to enabled; if an older config disabled it, edit ~/.vibe/config.toml and set [session_logging] enabled = true.",
      commands: ["vibe auth login"],
      credentialHandling:
        "Do not paste Mistral API keys, OAuth tokens, or ~/.vibe/credentials into the gateway or a remote chat.",
    },
    verification: {
      command: "vibe --version",
      expected:
        "Vibe CLI is installed; doctor checks ~/.vibe/config.toml for an explicit session_logging.enabled=false override",
    },
  },
};

export function getProviderLoginGuidance(provider: CliType): ProviderLoginGuidance {
  return GUIDANCE[provider];
}

export function getAllProviderLoginGuidance(): Record<CliType, ProviderLoginGuidance> {
  return { ...GUIDANCE };
}
