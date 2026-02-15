import { describe, it, expect } from "vitest";
import { resolveSessionResumeArgs, validateSessionId, GATEWAY_SESSION_PREFIX } from "../request-helpers.js";

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

  describe("resolveSessionResumeArgs", () => {
    it("createNewSession=true ignores all other flags", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: true
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("resumeLatest=true without sessionId returns --resume latest", () => {
      const result = resolveSessionResumeArgs({
        resumeLatest: true,
        createNewSession: false
      });
      expect(result.resumeArgs).toEqual(["--resume", "latest"]);
      expect(result.effectiveSessionId).toBeUndefined();
      expect(result.userProvidedSession).toBe(false);
    });

    it("user-provided sessionId returns --resume with that ID", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        createNewSession: false
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("sessionId takes precedence over resumeLatest", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: false
      });
      expect(result.resumeArgs).toEqual(["--resume", "user-abc"]);
      expect(result.effectiveSessionId).toBe("user-abc");
      expect(result.userProvidedSession).toBe(true);
    });

    it("no flags returns empty args", () => {
      const result = resolveSessionResumeArgs({
        createNewSession: false
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
      expect(() =>
        resolveSessionResumeArgs({ sessionId: "gw-abc123" })
      ).toThrow('Session ID "gw-abc123" uses reserved prefix "gw-"');
    });

    it("createNewSession=true with sessionId=gw-abc does not throw (createNewSession short-circuits)", () => {
      const result = resolveSessionResumeArgs({
        sessionId: "gw-abc",
        createNewSession: true
      });
      expect(result.resumeArgs).toEqual([]);
      expect(result.userProvidedSession).toBe(false);
    });
  });
});
