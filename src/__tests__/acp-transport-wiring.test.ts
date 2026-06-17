/**
 * ACP transport selector wiring tests (Slice B7).
 *
 * Proves the `transport: "acp"` branch in the request handlers routes to the
 * ACP runtime and fails closed against the config gates — without spawning any
 * process. The happy path (real provider) is covered by the runtime unit tests
 * (acp-runtime.test.ts) and the live end-to-end smoke.
 */
import { describe, expect, it } from "vitest";

import { handleDevinRequest, type GatewayServerRuntime } from "../index.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";
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
});
