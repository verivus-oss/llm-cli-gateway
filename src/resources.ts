import { ISessionManager } from "./session-manager.js";
import { PerformanceMetrics } from "./metrics.js";
import { getCliInfo } from "./model-registry.js";

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

export class ResourceProvider {
  constructor(
    private sessionManager: ISessionManager,
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
          lastModified: new Date().toISOString(),
        },
      },
      {
        uri: "sessions://claude",
        name: "Claude Sessions",
        title: "🤖 Claude Sessions",
        description: "List of Claude conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://codex",
        name: "Codex Sessions",
        title: "💻 Codex Sessions",
        description: "List of Codex conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://gemini",
        name: "Gemini Sessions",
        title: "✨ Gemini Sessions",
        description: "List of Gemini conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://grok",
        name: "Grok Sessions",
        title: "⚡ Grok Sessions",
        description: "List of Grok conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "models://claude",
        name: "Claude Models",
        title: "🧠 Claude Models & Capabilities",
        description: "Available Claude models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://codex",
        name: "Codex Models",
        title: "🔧 Codex Models & Capabilities",
        description: "Available Codex models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://gemini",
        name: "Gemini Models",
        title: "🌟 Gemini Models & Capabilities",
        description: "Available Gemini models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://grok",
        name: "Grok Models",
        title: "⚡ Grok Models & Capabilities",
        description: "Available Grok models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "metrics://performance",
        name: "Performance Metrics",
        title: "📈 Performance Metrics",
        description: "Request counts, response times, and success/failure rates",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.9,
        },
      },
    ];
  }

  // Read a specific resource by URI
  async readResource(uri: string): Promise<ResourceContents | null> {
    // Session resources
    if (uri === "sessions://all") {
      const sessions = await this.sessionManager.listSessions();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            total: sessions.length,
            sessions: sessions.map(s => ({
              id: s.id,
              cli: s.cli,
              description: s.description,
              createdAt: s.createdAt,
              lastUsedAt: s.lastUsedAt,
            })),
            activeSessions: {
              claude: (await this.sessionManager.getActiveSession("claude"))?.id || null,
              codex: (await this.sessionManager.getActiveSession("codex"))?.id || null,
              gemini: (await this.sessionManager.getActiveSession("gemini"))?.id || null,
              grok: (await this.sessionManager.getActiveSession("grok"))?.id || null,
            },
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://claude") {
      const sessions = await this.sessionManager.listSessions("claude");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "claude",
            total: sessions.length,
            sessions,
            activeSession: (await this.sessionManager.getActiveSession("claude"))?.id || null,
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://codex") {
      const sessions = await this.sessionManager.listSessions("codex");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "codex",
            total: sessions.length,
            sessions,
            activeSession: (await this.sessionManager.getActiveSession("codex"))?.id || null,
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://gemini") {
      const sessions = await this.sessionManager.listSessions("gemini");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "gemini",
            total: sessions.length,
            sessions,
            activeSession: (await this.sessionManager.getActiveSession("gemini"))?.id || null,
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://grok") {
      const sessions = await this.sessionManager.listSessions("grok");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "grok",
            total: sessions.length,
            sessions,
            activeSession: (await this.sessionManager.getActiveSession("grok"))?.id || null,
          },
          null,
          2
        ),
      };
    }

    // Model capability resources
    if (uri === "models://claude") {
      const cliInfo = getCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.claude, null, 2),
      };
    }

    if (uri === "models://codex") {
      const cliInfo = getCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.codex, null, 2),
      };
    }

    if (uri === "models://gemini") {
      const cliInfo = getCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.gemini, null, 2),
      };
    }

    if (uri === "models://grok") {
      const cliInfo = getCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.grok, null, 2),
      };
    }

    if (uri === "metrics://performance") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(this.performanceMetrics.snapshot(), null, 2),
      };
    }

    return null;
  }
}
