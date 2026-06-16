/**
 * ACP session map tests (plan step implement-session-map).
 *
 * Proves gateway ACP sessions use gateway-owned gw-* ids (never a provider id),
 * store the provider ACP id only in metadata, and that resume enforces the
 * provider + transport ownership scope (cross-provider / cross-transport /
 * CLI-session resume are all rejected).
 */
import { describe, expect, it } from "vitest";

import {
  ACP_TRANSPORT,
  createAcpSession,
  isGatewaySessionId,
  newGatewaySessionId,
  recordAcpSessionInfo,
  resolveAcpResume,
} from "../acp/session-map.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

/** Minimal Map-backed ISessionManager for the methods session-map uses. */
class FakeSessionManager implements Partial<ISessionManager> {
  readonly sessions = new Map<string, Session>();
  /** When true, updateSessionMetadata reports a lost write (returns false). */
  failUpdates = false;

  createSession(cli: ProviderType, description?: string, sessionId?: string): Session {
    const id = sessionId ?? `auto-${this.sessions.size}`;
    const session: Session = {
      id,
      cli,
      createdAt: "t0",
      lastUsedAt: "t0",
      description,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  updateSessionMetadata(sessionId: string, metadata: Record<string, unknown>): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (this.failUpdates) return false; // simulate a lost write
    s.metadata = { ...s.metadata, ...metadata };
    return true;
  }
}

function fakeSM(): ISessionManager {
  return new FakeSessionManager() as unknown as ISessionManager;
}

describe("ACP session map — id ownership", () => {
  it("isGatewaySessionId / newGatewaySessionId use the gw- prefix", () => {
    const id = newGatewaySessionId();
    expect(id.startsWith("gw-")).toBe(true);
    expect(isGatewaySessionId(id)).toBe(true);
    expect(isGatewaySessionId("tough-chess")).toBe(false);
  });

  it("creates a gateway-owned gw-* session and stamps acp metadata", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "mistral", cwd: "/tmp/w", now: () => "t1" });
    expect(isGatewaySessionId(id)).toBe(true);
    const session = (await sm.getSession(id))!;
    expect(session.cli).toBe("mistral");
    const acp = session.metadata!.acp;
    expect(acp).toMatchObject({
      provider: "mistral",
      transport: ACP_TRANSPORT,
      cwd: "/tmp/w",
      createdAt: "t1",
      lastSeenAt: "t1",
    });
    expect(acp.sessionId).toBeUndefined(); // provider id not known until session/new
  });

  it("never reuses the provider ACP id as the gateway id (structural guarantee)", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "grok" });
    await recordAcpSessionInfo(sm, id, { providerSessionId: "tough-chess", now: () => "t2" });
    const acp = (await sm.getSession(id))!.metadata!.acp;
    expect(id).not.toBe("tough-chess");
    expect(acp.sessionId).toBe("tough-chess"); // provider id lives ONLY in metadata
    expect(isGatewaySessionId(id)).toBe(true);
    expect(isGatewaySessionId(acp.sessionId)).toBe(false);
  });
});

describe("ACP session map — recordAcpSessionInfo", () => {
  it("records provider id + protocol/agent info and bumps lastSeenAt, preserving scope", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "devin", cwd: "/w", now: () => "t1" });
    const ok = await recordAcpSessionInfo(sm, id, {
      providerSessionId: "sess-9",
      protocolVersion: 1,
      agentName: "affogato",
      agentVersion: "0.0.0-dev",
      now: () => "t3",
    });
    expect(ok).toBe(true);
    const acp = (await sm.getSession(id))!.metadata!.acp;
    expect(acp).toMatchObject({
      provider: "devin",
      transport: ACP_TRANSPORT,
      cwd: "/w", // preserved
      sessionId: "sess-9",
      protocolVersion: 1,
      agentName: "affogato",
      lastSeenAt: "t3",
    });
  });

  it("returns false for an unknown gateway session", async () => {
    const sm = fakeSM();
    expect(await recordAcpSessionInfo(sm, "gw-missing", { providerSessionId: "x" })).toBe(false);
  });

  it("returns false for a non-ACP (CLI) session (cannot coerce a CLI session into ACP)", async () => {
    const sm = fakeSM();
    sm.createSession("mistral", "cli session", "gw-cli-1"); // no acp metadata
    expect(await recordAcpSessionInfo(sm, "gw-cli-1", { providerSessionId: "x" })).toBe(false);
  });

  it("returns false when the metadata write is lost (propagates the update result)", async () => {
    const fake = new FakeSessionManager();
    const sm = fake as unknown as ISessionManager;
    const id = await createAcpSession(sm, { provider: "mistral" });
    fake.failUpdates = true; // the record write will be reported lost
    expect(await recordAcpSessionInfo(sm, id, { providerSessionId: "x" })).toBe(false);
  });
});

describe("ACP session map — createAcpSession write integrity", () => {
  it("throws rather than returning a gw-* id that was never stamped with acp metadata", async () => {
    const fake = new FakeSessionManager();
    fake.failUpdates = true; // the acp stamp will be reported lost
    const sm = fake as unknown as ISessionManager;
    await expect(createAcpSession(sm, { provider: "mistral" })).rejects.toThrow(
      /stamp ACP metadata/
    );
  });
});

describe("ACP session map — resolveAcpResume ownership scope", () => {
  it("resolves to the provider id for the owning provider + acp transport", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "mistral" });
    await recordAcpSessionInfo(sm, id, { providerSessionId: "psess-1" });
    const res = await resolveAcpResume(sm, id, "mistral");
    expect(res).toMatchObject({ ok: true, providerSessionId: "psess-1" });
  });

  it("rejects an unknown gateway session id (not_found)", async () => {
    const sm = fakeSM();
    expect(await resolveAcpResume(sm, "gw-nope", "mistral")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("rejects cross-provider resume (wrong_provider)", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "mistral" });
    await recordAcpSessionInfo(sm, id, { providerSessionId: "psess-1" });
    expect(await resolveAcpResume(sm, id, "grok")).toEqual({ ok: false, reason: "wrong_provider" });
  });

  it("rejects resuming a CLI (non-ACP) session through ACP (wrong_transport)", async () => {
    const sm = fakeSM();
    sm.createSession("mistral", "cli", "gw-cli-2"); // no acp metadata
    expect(await resolveAcpResume(sm, "gw-cli-2", "mistral")).toEqual({
      ok: false,
      reason: "wrong_transport",
    });
  });

  it("rejects resume before session/new was recorded (no_provider_session)", async () => {
    const sm = fakeSM();
    const id = await createAcpSession(sm, { provider: "mistral" });
    expect(await resolveAcpResume(sm, id, "mistral")).toEqual({
      ok: false,
      reason: "no_provider_session",
    });
  });
});
