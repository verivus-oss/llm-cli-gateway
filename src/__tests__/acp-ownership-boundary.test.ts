/**
 * Remote ACP resume must enforce the same per-principal boundary as the CLI
 * session paths. The transport boundary is intentionally tested with the ACP
 * runtime mocked: reaching that runtime is the point where a provider process
 * could be started, so a foreign or missing id must never reach it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAcpRequestMock } = vi.hoisted(() => ({ runAcpRequestMock: vi.fn() }));

vi.mock("../acp/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../acp/runtime.js")>("../acp/runtime.js");
  return { ...actual, runAcpRequest: runAcpRequestMock };
});

import { runAcpTransport, type GatewayServerRuntime } from "../index.js";
import type { AcpConfig } from "../config.js";
import { PersonalConfigManager } from "../personal-config.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import type {
  ISessionManager,
  Session,
  SessionCompareAndSetMutation,
  SessionGenerationIdentity,
} from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const DEFAULT_WORKSPACE_CWD = "/canonical/acp-default";
const SESSION_WORKSPACE_CWD = "/canonical/acp-session";
const ACP_PROVIDERS = ["grok", "mistral", "devin", "cursor"] as const;
type AcpProvider = (typeof ACP_PROVIDERS)[number];

function remoteWorkspaces(defaultAlias: string | null = "default-acp"): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias,
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "default-acp",
        path: DEFAULT_WORKSPACE_CWD,
        providers: [...ACP_PROVIDERS],
        allowWorktree: false,
        allowAddDir: false,
        kind: "folder",
        operatorEntry: true,
      },
      {
        alias: "session-acp",
        path: SESSION_WORKSPACE_CWD,
        providers: [...ACP_PROVIDERS],
        allowWorktree: false,
        allowAddDir: false,
        kind: "folder",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function remoteAcpMetadata(provider: AcpProvider): Record<string, unknown> {
  return {
    acp: {
      provider,
      transport: "acp",
      sessionId: "provider-session",
      workspaceAlias: "session-acp",
      cwd: SESSION_WORKSPACE_CWD,
      createdAt: "t",
      lastSeenAt: "t",
    },
  };
}

class FakeSessionManager implements Partial<ISessionManager> {
  readonly sessions = new Map<string, Session>();

  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  updateSessionMetadata(id: string, metadata: Record<string, unknown>): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.metadata = { ...session.metadata, ...metadata };
    return true;
  }

  compareAndSetSession(
    identity: SessionGenerationIdentity,
    mutation: SessionCompareAndSetMutation
  ): boolean {
    const session = this.sessions.get(identity.id);
    if (
      !session ||
      session.cli !== identity.cli ||
      (session.ownerPrincipal ?? null) !== identity.ownerPrincipal ||
      session.createdAt !== identity.createdAt ||
      session.generation !== identity.generation ||
      JSON.stringify(session.metadata ?? {}) !== JSON.stringify(mutation.expectedMetadata ?? {})
    ) {
      return false;
    }
    if (mutation.kind === "delete") {
      this.sessions.delete(identity.id);
      return true;
    }
    session.metadata = mutation.metadata ? { ...mutation.metadata } : undefined;
    return true;
  }
}

function runtimeWith(
  sessions: FakeSessionManager,
  defaultAlias: string | null = "default-acp"
): GatewayServerRuntime {
  return {
    acpConfig: {} as AcpConfig,
    sessionManager: sessions,
    approvalManager: { decide: () => ({ status: "approved" }) },
    flightRecorder: { logStart() {}, logComplete() {} },
    logger: noopLog,
    workspaces: remoteWorkspaces(defaultAlias),
    personalConfig: new PersonalConfigManager({
      enabled: false,
      baselinePath: "/unused",
      maxStaleHours: 168,
    }),
  } as unknown as GatewayServerRuntime;
}

function handlerDeps(runtime: GatewayServerRuntime): Parameters<typeof runAcpTransport>[0] {
  return { runtime, sessionManager: runtime.sessionManager, logger: noopLog } as never;
}

function responseText(result: Awaited<ReturnType<typeof runAcpTransport>>): string {
  return result.content[0]?.text ?? "";
}

function remoteAcpSession(
  provider: AcpProvider,
  id = "gw-alice",
  withWorkspaceBinding = true
): Session {
  return {
    id,
    cli: provider,
    createdAt: "t",
    lastUsedAt: "t",
    ownerPrincipal: "alice",
    generation: "generation-1",
    ...(withWorkspaceBinding ? { metadata: remoteAcpMetadata(provider) } : {}),
  };
}

const aliceRemote: GatewayRequestContext = {
  transport: "http",
  authKind: "oauth",
  authScopes: [],
  authPrincipal: "alice",
};

const bobRemote: GatewayRequestContext = {
  transport: "http",
  authKind: "oauth",
  authScopes: [],
  authPrincipal: "bob",
};

describe("ACP remote session ownership boundary", () => {
  beforeEach(() => {
    runAcpRequestMock.mockReset();
    runAcpRequestMock.mockResolvedValue({
      text: "done",
      gatewaySessionId: "gw-alice",
      protocolVersion: 1,
      durationMs: 1,
      stopReason: "end_turn",
    });
  });

  it.each(ACP_PROVIDERS)(
    "does not invoke the ACP runtime for a foreign or missing remote %s session",
    async provider => {
      const sessions = new FakeSessionManager();
      sessions.sessions.set("gw-alice", remoteAcpSession(provider));
      const deps = handlerDeps(runtimeWith(sessions));

      const foreign = await runWithRequestContext(bobRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "resume",
          sessionId: "gw-alice",
          correlationId: `acp-boundary-${provider}`,
        })
      );
      const missing = await runWithRequestContext(bobRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "resume",
          sessionId: "gw-missing",
          correlationId: `acp-boundary-${provider}`,
        })
      );

      expect(responseText(foreign)).toBe(responseText(missing));
      expect(responseText(foreign)).toContain("Requested session is not accessible");
      expect(responseText(foreign)).not.toContain("gw-alice");
      expect(responseText(foreign)).not.toContain("alice");
      expect(runAcpRequestMock).not.toHaveBeenCalled();
    }
  );

  it.each(ACP_PROVIDERS)(
    "binds an owning remote %s ACP resume to its canonical workspace alias and cwd",
    async provider => {
      const sessions = new FakeSessionManager();
      sessions.sessions.set("gw-alice", remoteAcpSession(provider));
      const deps = handlerDeps(runtimeWith(sessions));

      const result = await runWithRequestContext(aliceRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "resume",
          sessionId: "gw-alice",
          correlationId: `acp-owner-${provider}`,
        })
      );

      expect(responseText(result)).toContain("transport=acp session=gw-alice");
      expect(runAcpRequestMock).toHaveBeenCalledOnce();
      expect(runAcpRequestMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          cwd: SESSION_WORKSPACE_CWD,
          workspaceAlias: "session-acp",
        })
      );
    }
  );

  it.each(ACP_PROVIDERS)(
    "uses a registered canonical default workspace for a fresh remote %s ACP request",
    async provider => {
      const deps = handlerDeps(runtimeWith(new FakeSessionManager()));

      await runWithRequestContext(aliceRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "fresh",
          correlationId: `acp-fresh-workspace-${provider}`,
        })
      );

      expect(runAcpRequestMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          cwd: DEFAULT_WORKSPACE_CWD,
          workspaceAlias: "default-acp",
        })
      );
      expect(JSON.stringify(runAcpRequestMock.mock.calls)).not.toContain(
        `/tmp/llm-gateway-acp-${provider}`
      );
    }
  );

  it.each(ACP_PROVIDERS)(
    "does not let a remote %s ACP resume switch from its recorded workspace alias to the default",
    async provider => {
      const sessions = new FakeSessionManager();
      sessions.sessions.set("gw-alice", remoteAcpSession(provider));
      const deps = handlerDeps(runtimeWith(sessions));

      const result = await runWithRequestContext(aliceRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "resume",
          sessionId: "gw-alice",
          workspace: "default-acp",
          correlationId: `acp-workspace-switch-${provider}`,
        })
      );

      expect(responseText(result)).toContain("Requested session is not accessible");
      expect(runAcpRequestMock).not.toHaveBeenCalled();
    }
  );

  it.each(ACP_PROVIDERS)(
    "rejects a remote %s ACP resume without a recorded canonical workspace binding",
    async provider => {
      const sessions = new FakeSessionManager();
      sessions.sessions.set("gw-legacy", remoteAcpSession(provider, "gw-legacy", false));
      const deps = handlerDeps(runtimeWith(sessions));

      const result = await runWithRequestContext(aliceRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "resume",
          sessionId: "gw-legacy",
          correlationId: `acp-unbound-session-${provider}`,
        })
      );

      expect(responseText(result)).toContain("Requested session is not accessible");
      expect(runAcpRequestMock).not.toHaveBeenCalled();
    }
  );

  it.each(ACP_PROVIDERS)(
    "rejects a fresh remote %s ACP request when neither an alias nor a default is configured",
    async provider => {
      const deps = handlerDeps(runtimeWith(new FakeSessionManager(), null));

      const result = await runWithRequestContext(aliceRemote, () =>
        runAcpTransport(deps, {
          provider,
          prompt: "fresh",
          correlationId: `acp-no-workspace-${provider}`,
        })
      );

      expect(responseText(result)).toContain(
        "Remote HTTP provider requests require a registered workspace"
      );
      expect(runAcpRequestMock).not.toHaveBeenCalled();
    }
  );

  it("leaves local ACP session diagnostics with the ACP runtime", async () => {
    const deps = handlerDeps(runtimeWith(new FakeSessionManager()));

    await runWithRequestContext({ transport: "stdio", authScopes: [] }, () =>
      runAcpTransport(deps, {
        provider: "mistral",
        prompt: "resume",
        sessionId: "gw-local-missing",
        correlationId: "acp-local",
      })
    );

    expect(runAcpRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionId: "gw-local-missing" })
    );
  });

  it("rejects a foreign local ACP session before workspace metadata or runtime mutation", async () => {
    const sessions = new FakeSessionManager();
    const foreign = remoteAcpSession("mistral");
    sessions.sessions.set(foreign.id, foreign);
    const before = structuredClone(foreign);
    const deps = handlerDeps(runtimeWith(sessions));

    const result = await runWithRequestContext({ transport: "stdio", authScopes: [] }, () =>
      runAcpTransport(deps, {
        provider: "mistral",
        prompt: "resume",
        sessionId: foreign.id,
        workspace: "default-acp",
        correlationId: "acp-local-foreign",
      })
    );

    expect(responseText(result)).toContain(`Session ${foreign.id} is not accessible`);
    expect(sessions.getSession(foreign.id)).toEqual(before);
    expect(runAcpRequestMock).not.toHaveBeenCalled();
  });
});
