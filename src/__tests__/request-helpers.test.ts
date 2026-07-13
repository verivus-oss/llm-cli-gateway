import { describe, it, expect } from "vitest";
import {
  resolveSessionResumeArgs,
  resolveGrokSessionArgs,
  resolveCodexSessionArgs,
  validateSessionId,
  sanitizeCliArgValues,
  GATEWAY_SESSION_PREFIX,
  resolveClaudePermissionFlags,
  resolveCodexSandboxFlags,
  filterCodexResumeFlags,
  CLAUDE_PERMISSION_MODES,
  GEMINI_APPROVAL_MODES,
} from "../request-helpers.js";

describe("request-helpers", () => {
  describe("GATEWAY_SESSION_PREFIX", () => {
    it("should be 'gw-'", () => {
      expect(GATEWAY_SESSION_PREFIX).toBe("gw-");
    });
  });

  describe("validateSessionId", () => {
    it("should throw for gw- prefixed IDs", () => {
      expect(() => validateSessionId("gw-abc123")).toThrow("reserved prefix");
    });

    it("should throw for bare gw- prefix", () => {
      expect(() => validateSessionId("gw-")).toThrow("reserved prefix");
    });

    it("should not throw for normal user IDs", () => {
      expect(() => validateSessionId("user-abc")).not.toThrow();
    });

    it("should not throw for UUIDs", () => {
      expect(() => validateSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
    });
  });

  describe("sanitizeCliArgValues", () => {
    it("should pass through normal values", () => {
      expect(sanitizeCliArgValues(["Edit", "Write", "Bash(git:*)"], "allowedTools")).toEqual([
        "Edit",
        "Write",
        "Bash(git:*)",
      ]);
    });

    it("should reject values starting with -", () => {
      expect(() =>
        sanitizeCliArgValues(["Edit", "--dangerously-skip-permissions"], "allowedTools")
      ).toThrow("argument injection");
    });

    it("should reject values starting with single dash", () => {
      expect(() => sanitizeCliArgValues(["-p"], "allowedTools")).toThrow("argument injection");
    });

    it("should accept empty array", () => {
      expect(sanitizeCliArgValues([], "allowedTools")).toEqual([]);
    });
  });

  describe("resolveSessionResumeArgs", () => {
    it("createNewSession=true ignores all other flags", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: true,
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("resumeLatest=true without sessionId returns --resume latest", () => {
      const result = resolveSessionResumeArgs({
        resumeLatest: true,
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual(["--resume", "latest"]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("user-provided sessionId returns --resume with that ID", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("sessionId takes precedence over resumeLatest", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("no flags returns empty args", () => {
      const result = resolveSessionResumeArgs({
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("all flags undefined returns empty args", () => {
      const result = resolveSessionResumeArgs({});
      expect(result.resumeArgs).toEqual([]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("rejects gateway-prefixed sessionId with clear error", () => {
      expect(() => resolveSessionResumeArgs({ sessionId: "gw-abc123" })).toThrow(
        'Session ID "gw-abc123" uses reserved prefix "gw-"'
      );
    });

    it("createNewSession=true with sessionId=gw-abc does not throw (createNewSession short-circuits)", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "gw-abc",
        createNewSession: true,
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.userProvidedSession).toBe(false);
    });
  });

  describe("resolveGrokSessionArgs", () => {
    it("createNewSession=true ignores all other flags", () => {
      const result = resolveGrokSessionArgs({
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: true,
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.userProvidedSession).toBe(false);
    });

    it("resumeLatest=true maps to --continue (not --resume latest)", () => {
      const result = resolveGrokSessionArgs({
        resumeLatest: true,
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual(["--continue"]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("user-provided sessionId returns --resume with that ID", () => {
      const result = resolveGrokSessionArgs({
        sessionId: "user-abc",
        createNewSession: false,
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("rejects gateway-prefixed sessionId with clear error", () => {
      expect(() => resolveGrokSessionArgs({ sessionId: "gw-abc123" })).toThrow(
        'Session ID "gw-abc123" uses reserved prefix "gw-"'
      );
    });
  });

  describe("resolveCodexSessionArgs", () => {
    it("defaults to mode=new with no options", () => {
      expect(resolveCodexSessionArgs({})).toEqual({ mode: "new" });
    });

    it("createNewSession=true forces mode=new even with sessionId", () => {
      expect(
        resolveCodexSessionArgs({
          sessionId: "11111111-2222-3333-4444-555555555555",
          resumeLatest: true,
          createNewSession: true,
        })
      ).toEqual({ mode: "new" });
    });

    it("sessionId takes precedence over resumeLatest", () => {
      const result = resolveCodexSessionArgs({
        sessionId: "11111111-2222-3333-4444-555555555555",
        resumeLatest: true,
      });
      expect(result.mode).toBe("resume-by-id");
      expect(result.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    });

    it("resumeLatest=true with no sessionId maps to resume-latest", () => {
      expect(resolveCodexSessionArgs({ resumeLatest: true })).toEqual({ mode: "resume-latest" });
    });

    it("rejects gw- prefixed sessionId", () => {
      expect(() => resolveCodexSessionArgs({ sessionId: "gw-abc123" })).toThrow(
        'reserved prefix "gw-"'
      );
    });

    it("accepts a normal UUID-shaped session id", () => {
      const result = resolveCodexSessionArgs({ sessionId: "7f9f9a2e-1b3c-4c7a-9b0e-deadbeefcafe" });
      expect(result.mode).toBe("resume-by-id");
      expect(result.sessionId).toBe("7f9f9a2e-1b3c-4c7a-9b0e-deadbeefcafe");
    });
  });

  describe("U24 resolveClaudePermissionFlags", () => {
    it("emits no flag when nothing is set", () => {
      expect(resolveClaudePermissionFlags({})).toEqual({ args: [] });
    });

    it("treats permissionMode 'default' as a no-op (no flag emitted)", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "default" })).toEqual({
        args: [],
      });
    });

    it("emits --permission-mode acceptEdits", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "acceptEdits" }).args).toEqual([
        "--permission-mode",
        "acceptEdits",
      ]);
    });

    it("emits --permission-mode manual", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "manual" }).args).toEqual([
        "--permission-mode",
        "manual",
      ]);
    });

    it("emits --permission-mode plan", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "plan" }).args).toEqual([
        "--permission-mode",
        "plan",
      ]);
    });

    it("emits --permission-mode auto", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "auto" }).args).toEqual([
        "--permission-mode",
        "auto",
      ]);
    });

    it("emits --permission-mode dontAsk", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "dontAsk" }).args).toEqual([
        "--permission-mode",
        "dontAsk",
      ]);
    });

    it("emits --permission-mode bypassPermissions", () => {
      expect(resolveClaudePermissionFlags({ permissionMode: "bypassPermissions" }).args).toEqual([
        "--permission-mode",
        "bypassPermissions",
      ]);
    });

    it("maps legacy dangerouslySkipPermissions=true to --permission-mode bypassPermissions", () => {
      const result = resolveClaudePermissionFlags({ dangerouslySkipPermissions: true });
      expect(result.args).toEqual(["--permission-mode", "bypassPermissions"]);
      expect(result.warning).toBeUndefined();
    });

    it("permissionMode wins over legacy dangerouslySkipPermissions and emits a warning", () => {
      const result = resolveClaudePermissionFlags({
        permissionMode: "plan",
        dangerouslySkipPermissions: true,
      });
      expect(result.args).toEqual(["--permission-mode", "plan"]);
      expect(result.warning).toMatch(/permissionMode wins/);
    });

    it("keeps default as a gateway pseudo-mode and includes all CLI wire modes", () => {
      expect(CLAUDE_PERMISSION_MODES).toEqual([
        "default",
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "manual",
        "dontAsk",
        "plan",
      ]);
    });
  });

  describe("U24 GEMINI_APPROVAL_MODES", () => {
    it("preserves existing values and adds 'plan'", () => {
      expect(GEMINI_APPROVAL_MODES).toContain("default");
      expect(GEMINI_APPROVAL_MODES).toContain("auto_edit");
      expect(GEMINI_APPROVAL_MODES).toContain("yolo");
      expect(GEMINI_APPROVAL_MODES).toContain("plan");
    });
  });

  describe("U24 resolveCodexSandboxFlags", () => {
    it("emits nothing when no params are set", () => {
      expect(resolveCodexSandboxFlags({})).toEqual({ args: [] });
    });

    it("emits --sandbox workspace-write for sandboxMode alone", () => {
      expect(resolveCodexSandboxFlags({ sandboxMode: "workspace-write" }).args).toEqual([
        "--sandbox",
        "workspace-write",
      ]);
    });

    it("emits --sandbox read-only", () => {
      expect(resolveCodexSandboxFlags({ sandboxMode: "read-only" }).args).toEqual([
        "--sandbox",
        "read-only",
      ]);
    });

    it("emits --sandbox danger-full-access", () => {
      expect(resolveCodexSandboxFlags({ sandboxMode: "danger-full-access" }).args).toEqual([
        "--sandbox",
        "danger-full-access",
      ]);
    });

    it("treats askForApproval as a deprecated no-op", () => {
      const result = resolveCodexSandboxFlags({ askForApproval: "on-request" });
      expect(result.args).toEqual([]);
      expect(result.warning).toMatch(/no longer accepts --ask-for-approval/);
    });

    it("emits sandbox only when sandboxMode and deprecated askForApproval are both set", () => {
      const result = resolveCodexSandboxFlags({
        sandboxMode: "workspace-write",
        askForApproval: "on-request",
      });
      expect(result.args).toEqual(["--sandbox", "workspace-write"]);
      expect(result.args).not.toContain("--full-auto");
      expect(result.args).not.toContain("--ask-for-approval");
      expect(result.warning).toMatch(/no longer accepts --ask-for-approval/);
    });

    it("expands fullAuto=true to sandbox only, NOT approval flags", () => {
      const result = resolveCodexSandboxFlags({ fullAuto: true });
      expect(result.args).toEqual(["--sandbox", "workspace-write"]);
      expect(result.args).not.toContain("--full-auto");
      expect(result.args).not.toContain("--ask-for-approval");
    });

    it("ignores useLegacyFullAutoFlag when fullAuto=true because Codex rejects --full-auto", () => {
      const result = resolveCodexSandboxFlags({
        fullAuto: true,
        useLegacyFullAutoFlag: true,
      });
      expect(result.args).toEqual(["--sandbox", "workspace-write"]);
      expect(result.args).not.toContain("--full-auto");
      expect(result.args).not.toContain("--ask-for-approval");
      expect(result.warning).toMatch(/no longer accepts --full-auto/);
    });

    it("explicit sandboxMode wins when fullAuto is also set, and emits a warning", () => {
      const result = resolveCodexSandboxFlags({
        sandboxMode: "read-only",
        fullAuto: true,
      });
      expect(result.args).toEqual(["--sandbox", "read-only"]);
      expect(result.args).not.toContain("--full-auto");
      expect(result.warning).toMatch(/sandboxMode wins/);
    });

    it("useLegacyFullAutoFlag without fullAuto is a deprecated no-op with a warning", () => {
      const result = resolveCodexSandboxFlags({ useLegacyFullAutoFlag: true });
      expect(result.args).toEqual([]);
      expect(result.warning).toMatch(/no longer accepts --full-auto/);
    });
  });

  describe("U24 filterCodexResumeFlags", () => {
    it("strips --full-auto", () => {
      expect(filterCodexResumeFlags(["exec", "--full-auto", "prompt"])).toEqual(["exec", "prompt"]);
    });

    it("strips --sandbox and its value", () => {
      expect(filterCodexResumeFlags(["exec", "--sandbox", "workspace-write", "prompt"])).toEqual([
        "exec",
        "prompt",
      ]);
    });

    it("strips --ask-for-approval and its value", () => {
      expect(filterCodexResumeFlags(["exec", "--ask-for-approval", "never", "prompt"])).toEqual([
        "exec",
        "prompt",
      ]);
    });

    it("strips both --sandbox and --ask-for-approval together", () => {
      expect(
        filterCodexResumeFlags([
          "exec",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "never",
          "prompt",
        ])
      ).toEqual(["exec", "prompt"]);
    });

    it("preserves unrelated flags", () => {
      expect(
        filterCodexResumeFlags(["exec", "--model", "gpt-5.4", "--sandbox", "read-only", "prompt"])
      ).toEqual(["exec", "--model", "gpt-5.4", "prompt"]);
    });
  });

  describe("U22 prepareMistralRequest (env-var injection)", () => {
    it("is exported from request-helpers", async () => {
      const mod = await import("../request-helpers.js");
      expect(typeof mod.prepareMistralRequest).toBe("function");
      expect(typeof mod.resolveMistralSessionArgs).toBe("function");
    });

    it("returns env.VIBE_ACTIVE_MODEL when a resolvedModel is supplied", async () => {
      const { prepareMistralRequest } = await import("../request-helpers.js");
      const result = prepareMistralRequest({
        prompt: "hi",
        resolvedModel: "mistral-medium-3.5",
      });
      expect(result.env).toEqual({ VIBE_ACTIVE_MODEL: "mistral-medium-3.5" });
      expect(result.args).not.toContain("--model");
    });

    it("returns empty env when no model is supplied (Vibe picks its own)", async () => {
      const { prepareMistralRequest } = await import("../request-helpers.js");
      const result = prepareMistralRequest({ prompt: "hi" });
      expect(result.env).toEqual({});
    });

    it("emits each disallowed tool as a Vibe --disabled-tools pair", async () => {
      const { prepareMistralRequest } = await import("../request-helpers.js");
      const result = prepareMistralRequest({
        prompt: "hi",
        disallowedTools: ["shell", "network"],
      });
      expect(result.args).toEqual([
        "-p",
        "hi",
        "--agent",
        "accept-edits",
        "--disabled-tools",
        "shell",
        "--disabled-tools",
        "network",
      ]);
    });
  });
});
