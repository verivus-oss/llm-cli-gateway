import { describe, it, expect } from "vitest";
import {
  resolveSessionResumeArgs,
  resolveGrokSessionArgs,
  resolveCodexSessionArgs,
  validateSessionId,
  sanitizeCliArgValues,
  GATEWAY_SESSION_PREFIX,
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
        createNewSession: true
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.userProvidedSession).toBe(false);
    });

    it("resumeLatest=true maps to --continue (not --resume latest)", () => {
      const result = resolveGrokSessionArgs({
        resumeLatest: true,
        createNewSession: false
      });
      expect(result.resumeArgs).toEqual(["--continue"]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("user-provided sessionId returns --resume with that ID", () => {
      const result = resolveGrokSessionArgs({
        sessionId: "user-abc",
        createNewSession: false
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("rejects gateway-prefixed sessionId with clear error", () => {
      expect(() =>
        resolveGrokSessionArgs({ sessionId: "gw-abc123" })
      ).toThrow('Session ID "gw-abc123" uses reserved prefix "gw-"');
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
          createNewSession: true
        })
      ).toEqual({ mode: "new" });
    });

    it("sessionId takes precedence over resumeLatest", () => {
      const result = resolveCodexSessionArgs({
        sessionId: "11111111-2222-3333-4444-555555555555",
        resumeLatest: true
      });
      expect(result.mode).toBe("resume-by-id");
      expect(result.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    });

    it("resumeLatest=true with no sessionId maps to resume-latest", () => {
      expect(resolveCodexSessionArgs({ resumeLatest: true })).toEqual({ mode: "resume-latest" });
    });

    it("rejects gw- prefixed sessionId", () => {
      expect(() => resolveCodexSessionArgs({ sessionId: "gw-abc123" })).toThrow('reserved prefix "gw-"');
    });

    it("accepts a normal UUID-shaped session id", () => {
      const result = resolveCodexSessionArgs({ sessionId: "7f9f9a2e-1b3c-4c7a-9b0e-deadbeefcafe" });
      expect(result.mode).toBe("resume-by-id");
      expect(result.sessionId).toBe("7f9f9a2e-1b3c-4c7a-9b0e-deadbeefcafe");
    });
  });
});
