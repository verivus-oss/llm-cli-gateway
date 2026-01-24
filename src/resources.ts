import { SessionManager } from "./session-manager.js";
import { PerformanceMetrics } from "./metrics.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number;
    lastModified?: string;
  };
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

// CLI model capabilities from index.ts
const CLI_INFO = {
  claude: {
    description: "Anthropic's Claude Code CLI - best for code generation, analysis, and agentic coding tasks",
    models: {
      opus: "Most capable model. Best for: complex reasoning, nuanced analysis, difficult problems, research",
      sonnet: "Balanced performance. Best for: everyday coding, code review, general tasks (default)",
      haiku: "Fastest model. Best for: simple queries, quick answers, high-volume tasks, cost-sensitive use"
    }
  },
  codex: {
    description: "OpenAI's Codex CLI - best for code execution in sandboxed environments",
    models: {
      "o3": "Most capable reasoning model. Best for: complex multi-step problems, math, science",
      "o4-mini": "Fast reasoning model. Best for: coding tasks, quick iterations",
      "gpt-4.1": "Latest GPT-4 variant. Best for: general coding, instruction following"
    }
  },
  gemini: {
    description: "Google's Gemini CLI - best for multimodal tasks and Google ecosystem integration",
    models: {
      "gemini-2.5-pro": "Most capable model. Best for: complex reasoning, long context, multimodal",
      "gemini-2.5-flash": "Fast model. Best for: quick responses, high throughput, cost-sensitive use"
    }
  }
} as const;

export class ResourceProvider {
  constructor(
    private sessionManager: SessionManager,
    private performanceMetrics: PerformanceMetrics
  ) {}

  // List all available resources
  listResources(): ResourceDefinition[] {
    return [
      {
        uri: "sessions://all",
        name: "All Sessions",
        title: "📋 All Sessions",
        description: "List of all conversation sessions across all CLIs",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.7,
          lastModified: new Date().toISOString()
        }
      },
      {
        uri: "sessions://claude",
        name: "Claude Sessions",
        title: "🤖 Claude Sessions",
        description: "List of Claude conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6
        }
      },
      {
        uri: "sessions://codex",
        name: "Codex Sessions",
        title: "💻 Codex Sessions",
        description: "List of Codex conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6
        }
      },
      {
        uri: "sessions://gemini",
        name: "Gemini Sessions",
        title: "✨ Gemini Sessions",
        description: "List of Gemini conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6
        }
      },
      {
        uri: "models://claude",
        name: "Claude Models",
        title: "🧠 Claude Models & Capabilities",
        description: "Available Claude models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8
        }
      },
      {
        uri: "models://codex",
        name: "Codex Models",
        title: "🔧 Codex Models & Capabilities",
        description: "Available Codex models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8
        }
      },
      {
        uri: "models://gemini",
        name: "Gemini Models",
        title: "🌟 Gemini Models & Capabilities",
        description: "Available Gemini models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8
        }
      },
      {
        uri: "metrics://performance",
        name: "Performance Metrics",
        title: "📈 Performance Metrics",
        description: "Request counts, response times, and success/failure rates",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.9
        }
      }
    ];
  }

  // Read a specific resource by URI
  readResource(uri: string): ResourceContents | null {
    // Session resources
    if (uri === "sessions://all") {
      const sessions = this.sessionManager.listSessions();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          total: sessions.length,
          sessions: sessions.map(s => ({
            id: s.id,
            cli: s.cli,
            description: s.description,
            createdAt: s.createdAt,
            lastUsedAt: s.lastUsedAt
          })),
          activeSessions: {
            claude: this.sessionManager.getActiveSession("claude")?.id || null,
            codex: this.sessionManager.getActiveSession("codex")?.id || null,
            gemini: this.sessionManager.getActiveSession("gemini")?.id || null
          }
        }, null, 2)
      };
    }

    if (uri === "sessions://claude") {
      const sessions = this.sessionManager.listSessions("claude");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          cli: "claude",
          total: sessions.length,
          sessions,
          activeSession: this.sessionManager.getActiveSession("claude")?.id || null
        }, null, 2)
      };
    }

    if (uri === "sessions://codex") {
      const sessions = this.sessionManager.listSessions("codex");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          cli: "codex",
          total: sessions.length,
          sessions,
          activeSession: this.sessionManager.getActiveSession("codex")?.id || null
        }, null, 2)
      };
    }

    if (uri === "sessions://gemini") {
      const sessions = this.sessionManager.listSessions("gemini");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          cli: "gemini",
          total: sessions.length,
          sessions,
          activeSession: this.sessionManager.getActiveSession("gemini")?.id || null
        }, null, 2)
      };
    }

    // Model capability resources
    if (uri === "models://claude") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(CLI_INFO.claude, null, 2)
      };
    }

    if (uri === "models://codex") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(CLI_INFO.codex, null, 2)
      };
    }

    if (uri === "models://gemini") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(CLI_INFO.gemini, null, 2)
      };
    }

    if (uri === "metrics://performance") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(this.performanceMetrics.snapshot(), null, 2)
      };
    }

    return null;
  }
}
