/**
 * ACP transport selector wiring tests (Slice B7).
 *
 * Proves the `transport: "acp"` branch in the request handlers routes to the
 * ACP runtime and fails closed against the config gates — without spawning any
 * process. The happy path (real provider) is covered by the runtime unit tests
 * (acp-runtime.test.ts) and the live end-to-end smoke.
 */
import { describe, expect, it } from "vitest";

import {
  handleCursorRequest,
  handleDevinRequest,
  handleGrokRequest,
  handleMistralRequest,
  type GatewayServerRuntime,
} from "../index.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";
import { PersonalConfigManager } from "../personal-config.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

class FakeSessionManager implements Partial<ISessionManager> {
  readonly sessions = new Map<string, Session>();
  createSession(cli: ProviderType, description?: string, sessionId?: string): Session {
    const id = sessionId ?? `s${this.sessions.size}`;
    const s: Session = { id, cli, createdAt: "t", lastUsedAt: "t", description };
    this.sessions.set(id, s);
    return s;
  }
  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }
  updateSessionMetadata(): boolean {
    return true;
  }
}

function acpConfig(over: Partial<AcpConfig> = {}): AcpConfig {
  const dev: AcpProviderConfig = {
    enabled: true,
    command: "devin",
    args: ["acp"],
    runtimeEnabled: false,
    isolatedLeaderSocket: false,
  };
  return {
    enabled: true,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: 600000,
    initializeTimeoutMs: 10000,
    sessionNewTimeoutMs: 10000,
    promptTimeoutMs: 600000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    fallbackToCliWhenUnhealthy: true,
    providers: { devin: dev },
    ...over,
  };
}

function runtimeWith(cfg: AcpConfig): GatewayServerRuntime {
  return {
    acpConfig: cfg,
    sessionManager: new FakeSessionManager(),
    approvalManager: { decide: () => ({ status: "approved" }) },
    flightRecorder: { logStart() {}, logComplete() {} },
    logger: noopLog,
    personalConfig: new PersonalConfigManager({
      enabled: false,
      baselinePath: "/unused",
      maxStaleHours: 168,
    }),
  } as unknown as GatewayServerRuntime;
}

function deps(cfg: AcpConfig) {
  const runtime = runtimeWith(cfg);
  return { sessionManager: runtime.sessionManager, logger: noopLog, runtime } as never;
}

describe("ACP transport wiring — fail closed", () => {
  it("transport=acp fails closed with a clear error when [acp].enabled is off", async () => {
    const res = await handleDevinRequest(deps(acpConfig({ enabled: false })), {
      transport: "acp",
      prompt: "hi",
      optimizePrompt: false,
    });
    expect(JSON.stringify(res)).toContain("ACP transport is disabled");
  });

  it("transport=acp fails closed when the provider runtime is not enabled", async () => {
    // [acp].enabled true, but devin.runtimeEnabled stays false (default config).
    const res = await handleDevinRequest(deps(acpConfig()), {
      transport: "acp",
      prompt: "hi",
      optimizePrompt: false,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("runtime routing is not enabled");
    expect(text).toContain("devin");
  });

  it("rejects an empty prompt on the acp path before any gate work", async () => {
    const res = await handleDevinRequest(deps(acpConfig({ enabled: true })), {
      transport: "acp",
      prompt: "   ",
      optimizePrompt: false,
    });
    expect(JSON.stringify(res)).toContain("prompt is required");
  });

  it("wires cursor_request transport=acp through the same closed provider gate", async () => {
    const cursor: AcpProviderConfig = {
      enabled: true,
      command: "cursor-agent",
      args: ["acp"],
      runtimeEnabled: false,
      isolatedLeaderSocket: false,
    };
    const res = await handleCursorRequest(deps(acpConfig({ providers: { cursor } })), {
      transport: "acp",
      prompt: "hi",
      optimizePrompt: false,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("runtime routing is not enabled");
    expect(text).toContain("cursor");
  });

  it("rejects CLI managed approval strategy on ACP instead of silently ignoring it", async () => {
    const res = await handleCursorRequest(deps(acpConfig()), {
      transport: "acp",
      prompt: "hi",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("does not support approvalStrategy:mcp_managed");
    expect(text).toContain("transport=cli");
  });

  it("rejects Grok ACP CLI-only continuation controls instead of dropping them", async () => {
    const res = await handleGrokRequest(deps(acpConfig()), {
      transport: "acp",
      prompt: "hi",
      resumeLatest: true,
      createNewSession: false,
      approvalStrategy: "legacy",
      optimizePrompt: false,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("transport=acp does not support");
    expect(text).toContain("resumeLatest");
  });

  it("rejects Mistral ACP gateway worktree controls instead of dropping them", async () => {
    const res = await handleMistralRequest(deps(acpConfig()), {
      transport: "acp",
      prompt: "hi",
      resumeLatest: false,
      createNewSession: false,
      approvalStrategy: "legacy",
      optimizePrompt: false,
      worktree: true,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("transport=acp does not support");
    expect(text).toContain("worktree");
  });

  it("rejects Devin ACP safety and execution controls instead of dropping them", async () => {
    const res = await handleDevinRequest(deps(acpConfig()), {
      transport: "acp",
      prompt: "hi",
      permissionMode: "dangerous",
      sandbox: true,
      resumeLatest: true,
      idleTimeoutMs: 30_000,
      optimizePrompt: false,
    });
    const text = JSON.stringify(res);
    expect(text).toContain("transport=acp does not support");
    expect(text).toContain("permissionMode");
    expect(text).toContain("sandbox");
    expect(text).toContain("resumeLatest");
    expect(text).toContain("idleTimeoutMs");
  });

  it.each([true, false])(
    "rejects explicit compressResponse=%s for every ACP provider instead of dropping it",
    async compressResponse => {
      const responses = await Promise.all([
        handleGrokRequest(deps(acpConfig()), {
          transport: "acp",
          prompt: "hi",
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          compressResponse,
        }),
        handleMistralRequest(deps(acpConfig()), {
          transport: "acp",
          prompt: "hi",
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          compressResponse,
        }),
        handleDevinRequest(deps(acpConfig()), {
          transport: "acp",
          prompt: "hi",
          optimizePrompt: false,
          compressResponse,
        }),
        handleCursorRequest(deps(acpConfig()), {
          transport: "acp",
          prompt: "hi",
          optimizePrompt: false,
          compressResponse,
        }),
      ]);

      for (const response of responses) {
        const text = JSON.stringify(response);
        expect(text).toContain("transport=acp does not support");
        expect(text).toContain("compressResponse");
      }
    }
  );
});
