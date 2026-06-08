/**
 * Phase 4 slice δ — Grok `--max-turns` wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { optimizePrompt } from "../optimizer.js";
import {
  prepareGrokRequest,
  handleGrokRequest,
  handleGrokRequestAsync,
  MAX_TURNS_SCHEMA,
  MAX_PRICE_SCHEMA,
} from "../index.js";
import type { ISessionManager, Session } from "../session-manager.js";
import { validateUpstreamCliArgs } from "../upstream-contracts.js";

function baseParams(extra: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "grok_request",
    ...extra,
  };
}

const noopLogger = {
  info: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
};

function mockSession(id: string, cli: Session["cli"]): Session {
  return {
    id,
    cli,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    description: `${cli} session`,
  };
}

function createMockSessionManager(sessions: Map<string, Session>): ISessionManager {
  return {
    createSession: vi.fn(async (cli, description, sessionId) => {
      const session = mockSession(sessionId || `gw-${cli}`, cli);
      session.description = description;
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn(async sessionId => sessions.get(sessionId) || null),
    listSessions: vi.fn(async cli =>
      [...sessions.values()].filter(session => !cli || session.cli === cli)
    ),
    deleteSession: vi.fn(async sessionId => sessions.delete(sessionId)),
    setActiveSession: vi.fn(async () => true),
    getActiveSession: vi.fn(async () => null),
    updateSessionUsage: vi.fn(async () => {}),
    updateSessionMetadata: vi.fn(async () => true),
    clearAllSessions: vi.fn(async () => 0),
  };
}

describe("Phase 4 slice δ — Grok --max-turns wiring", () => {
  it("emits --max-turns <N> when maxTurns is set", () => {
    const prep = prepareGrokRequest(baseParams({ maxTurns: 7 }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("7");
  });

  it("does NOT emit --max-turns when maxTurns is omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--max-turns");
  });

  it("does NOT emit --max-turns when maxTurns is explicitly undefined", () => {
    const prep = prepareGrokRequest(baseParams({ maxTurns: undefined }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--max-turns");
  });

  it("MAX_TURNS_SCHEMA rejects out-of-range / unsafe / scientific-notation values", () => {
    // Accept the happy path.
    expect(MAX_TURNS_SCHEMA.safeParse(1).success).toBe(true);
    expect(MAX_TURNS_SCHEMA.safeParse(10_000).success).toBe(true);
    // Reject zero / negative / non-integer.
    expect(MAX_TURNS_SCHEMA.safeParse(0).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(-1).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(1.5).success).toBe(false);
    // Reject above the 10k ceiling.
    expect(MAX_TURNS_SCHEMA.safeParse(10_001).success).toBe(false);
    // Reject values whose String() form would be scientific notation
    // (`1e21` → "1e+21") — exactly Codex's review finding.
    expect(MAX_TURNS_SCHEMA.safeParse(1e21).success).toBe(false);
    expect(MAX_TURNS_SCHEMA.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it("MAX_PRICE_SCHEMA rejects Infinity / NaN / out-of-range / scientific-notation", () => {
    expect(MAX_PRICE_SCHEMA.safeParse(0.001).success).toBe(true);
    expect(MAX_PRICE_SCHEMA.safeParse(10_000).success).toBe(true);
    // Lower bound: 1e-6 is the smallest value String() emits in decimal form.
    expect(MAX_PRICE_SCHEMA.safeParse(1e-6).success).toBe(true);
    expect(String(1e-6)).toBe("0.000001");
    expect(MAX_PRICE_SCHEMA.safeParse(0).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(-0.5).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(Infinity).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(NaN).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(10_001).success).toBe(false);
    expect(MAX_PRICE_SCHEMA.safeParse(1e21).success).toBe(false);
    // The exact attack vector from Codex round-2: 1e-7 stringifies as "1e-7"
    // which Vibe and our --max-price contract regex both reject.
    expect(MAX_PRICE_SCHEMA.safeParse(1e-7).success).toBe(false);
    expect(String(1e-7)).toBe("1e-7");
  });

  it("emits --max-turns alongside existing flags without disturbing argv order", () => {
    const prep = prepareGrokRequest(
      baseParams({
        model: "grok-build",
        outputFormat: "json",
        allowedTools: ["read", "edit"],
        maxTurns: 12,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    // `-p` is still first; --max-turns is appended after the existing flag
    // set, mirroring prepareClaudeHighImpactFlags' append-only contract.
    expect(prep.args[0]).toBe("-p");
    expect(prep.args).toContain("--model");
    expect(prep.args).toContain("--output-format");
    expect(prep.args).toContain("--tools");
    const idx = prep.args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("12");
  });
});

describe("Grok CLI session namespace validation", () => {
  it("rejects a grok-api session id before sync Grok CLI execution", async () => {
    const sm = createMockSessionManager(
      new Map([["api-session", mockSession("api-session", "grok-api")]])
    );

    const result = await handleGrokRequest(
      { sessionManager: sm, logger: noopLogger },
      {
        prompt: "hello",
        sessionId: "api-session",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not 'grok'");
  });

  it("rejects a grok-api session id before starting async Grok CLI jobs", async () => {
    const sm = createMockSessionManager(
      new Map([["api-session", mockSession("api-session", "grok-api")]])
    );
    const asyncJobManager = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(asyncJobManager, "startJob");

    const result = await handleGrokRequestAsync(
      { sessionManager: sm, asyncJobManager, logger: noopLogger },
      {
        prompt: "hello",
        sessionId: "api-session",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not 'grok'");
    expect(startJobSpy).not.toHaveBeenCalled();
  });
});

describe("Grok 0.2.x: --compaction-mode / --compaction-detail wiring", () => {
  it("emits --compaction-mode <MODE> when compactionMode is set", () => {
    const prep = prepareGrokRequest(baseParams({ compactionMode: "segments" }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--compaction-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("segments");
  });

  it("emits --compaction-detail <DETAIL> when compactionDetail is set", () => {
    const prep = prepareGrokRequest(baseParams({ compactionDetail: "balanced" }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--compaction-detail");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("balanced");
  });

  it("emits both compaction flags together, appended after existing flags", () => {
    const prep = prepareGrokRequest(
      baseParams({
        model: "grok-build",
        outputFormat: "json",
        compactionMode: "transcript",
        compactionDetail: "verbose",
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("-p");
    const mIdx = prep.args.indexOf("--compaction-mode");
    const dIdx = prep.args.indexOf("--compaction-detail");
    expect(prep.args[mIdx + 1]).toBe("transcript");
    expect(prep.args[dIdx + 1]).toBe("verbose");
  });

  it("emits neither compaction flag when both are omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--compaction-mode");
    expect(prep.args).not.toContain("--compaction-detail");
  });
});

describe("Grok 0.2.x: headless control flags", () => {
  it("emits --agent, --best-of-n, --check, --disable-web-search, --todo-gate, --verbatim", () => {
    const prep = prepareGrokRequest(
      baseParams({
        agent: "reviewer",
        bestOfN: 3,
        check: true,
        disableWebSearch: true,
        todoGate: true,
        verbatim: true,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--agent");
    expect(prep.args).toContain("reviewer");
    expect(prep.args).toContain("--best-of-n");
    expect(prep.args).toContain("3");
    expect(prep.args).toContain("--check");
    expect(prep.args).toContain("--disable-web-search");
    expect(prep.args).toContain("--todo-gate");
    expect(prep.args).toContain("--verbatim");
  });

  it("does not emit headless flags when omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    for (const flag of [
      "--agent",
      "--best-of-n",
      "--check",
      "--disable-web-search",
      "--todo-gate",
      "--verbatim",
    ]) {
      expect(prep.args).not.toContain(flag);
    }
  });

  it("emits Grok 0.2.x help-surface flags (agents, prompt-file, memory, native worktree)", () => {
    const prep = prepareGrokRequest(
      baseParams({
        agents: { reviewer: { description: "review", prompt: "check code" } },
        promptFile: "/tmp/prompt.md",
        promptJson: [{ type: "text", text: "hi" }],
        single: "single-turn",
        experimentalMemory: true,
        noAltScreen: true,
        oauth: true,
        restoreCode: true,
        nativeWorktree: "wt-1",
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--agents");
    expect(prep.args).toContain("--prompt-file");
    expect(prep.args).toContain("/tmp/prompt.md");
    expect(prep.args).toContain("--prompt-json");
    expect(prep.args).toContain("--single");
    expect(prep.args).toContain("single-turn");
    expect(prep.args).toContain("--experimental-memory");
    expect(prep.args).toContain("--no-alt-screen");
    expect(prep.args).toContain("--oauth");
    expect(prep.args).toContain("--restore-code");
    expect(prep.args).toContain("--worktree");
    expect(prep.args).toContain("wt-1");
    expect(validateUpstreamCliArgs("grok", prep.args).ok).toBe(true);
  });

  it("emits bare --worktree when nativeWorktree is true", () => {
    const prep = prepareGrokRequest(baseParams({ nativeWorktree: true }));
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--worktree");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).not.toBe("true");
  });

  it("emits --leader-socket <PATH> when leaderSocket is set (Grok 0.2.32)", () => {
    const prep = prepareGrokRequest(
      baseParams({ leaderSocket: "/home/user/.grok/leader-branch.sock" })
    );
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("--leader-socket");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("/home/user/.grok/leader-branch.sock");
    expect(validateUpstreamCliArgs("grok", prep.args).ok).toBe(true);
  });

  it("does not emit --leader-socket when leaderSocket is omitted", () => {
    const prep = prepareGrokRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--leader-socket");
  });

  it("skips gateway optimizePrompt when verbatim is true (even if optimizePrompt is true)", () => {
    const verbose =
      "Please implement the following feature:\nI would like you to help me with the session management system.";
    const prepOptimized = prepareGrokRequest(baseParams({ optimizePrompt: true, prompt: verbose }));
    const prepVerbatim = prepareGrokRequest(
      baseParams({ optimizePrompt: true, verbatim: true, prompt: verbose })
    );
    if (!("effectivePrompt" in prepOptimized) || !("effectivePrompt" in prepVerbatim)) {
      throw new Error("expected effectivePrompt");
    }
    expect(prepOptimized.effectivePrompt).toBe(optimizePrompt(verbose));
    expect(prepOptimized.effectivePrompt).not.toBe(verbose);
    expect(prepVerbatim.effectivePrompt).toBe(verbose);
    expect(prepVerbatim.args).toContain("--verbatim");
  });
});
