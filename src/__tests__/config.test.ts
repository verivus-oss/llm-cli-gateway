import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig, DEFAULT_SESSION_TTL_SECONDS } from "../config.js";

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("DEFAULT_SESSION_TTL_SECONDS", () => {
    it("should be 30 days in seconds", () => {
      expect(DEFAULT_SESSION_TTL_SECONDS).toBe(2592000);
    });
  });

  describe("loadConfig", () => {
    it("should always return Config object (never undefined) even without DB env vars", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("REDIS_URL", "");
      const config = loadConfig();
      expect(config).toBeDefined();
      expect(config.cacheTtl).toBeDefined();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
      expect(config.database).toBeUndefined();
      expect(config.redis).toBeUndefined();
    });

    it("should parse valid SESSION_TTL from env", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("REDIS_URL", "");
      vi.stubEnv("SESSION_TTL", "7200");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(7200);
    });

    it("should fallback to default when SESSION_TTL is NaN", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("REDIS_URL", "");
      vi.stubEnv("SESSION_TTL", "not-a-number");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should fallback to default when SESSION_TTL is negative", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("REDIS_URL", "");
      vi.stubEnv("SESSION_TTL", "-100");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should fallback to default when SESSION_TTL is zero", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("REDIS_URL", "");
      vi.stubEnv("SESSION_TTL", "0");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should include database and redis config when env vars are set", () => {
      vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");
      vi.stubEnv("REDIS_URL", "redis://localhost:6379");
      const config = loadConfig();
      expect(config.database).toBeDefined();
      expect(config.database!.connectionString).toBe("postgresql://localhost:5432/test");
      expect(config.redis).toBeDefined();
      expect(config.redis!.url).toBe("redis://localhost:6379");
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });
  });
});
