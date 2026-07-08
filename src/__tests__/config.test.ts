import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  DEFAULT_SESSION_TTL_SECONDS,
  loadLimitsConfig,
  loadSkillsConfig,
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_IDLE_TTL_MS,
  DEFAULT_MAX_RUNNING_JOBS,
  DEFAULT_MAX_RUNNING_JOBS_PER_PROVIDER,
  DEFAULT_MAX_JOB_OUTPUT_BYTES,
  DEFAULT_COMPLETED_JOB_MEMORY_TTL_MS,
  diagnoseRemoteOAuthConfig,
} from "../config.js";
import { hashSecret } from "../oauth.js";
import { noopLogger } from "../logger.js";

/** Write a temp config.toml and point LLM_GATEWAY_CONFIG at it. */
function withConfigToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "limits-cfg-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, body, "utf8");
  return path;
}

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
      const config = loadConfig();
      expect(config).toBeDefined();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
      expect(config.database).toBeUndefined();
    });

    it("should parse valid SESSION_TTL from env", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_TTL", "7200");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(7200);
    });

    it("should fallback to default when SESSION_TTL is NaN", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_TTL", "not-a-number");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should fallback to default when SESSION_TTL is negative", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_TTL", "-100");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should fallback to default when SESSION_TTL is zero", () => {
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_TTL", "0");
      const config = loadConfig();
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });

    it("should include database config when DATABASE_URL is set", () => {
      vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");
      const config = loadConfig();
      expect(config.database).toBeDefined();
      expect(config.database!.connectionString).toBe("postgresql://localhost:5432/test");
      expect(config.sessionTtl).toBe(DEFAULT_SESSION_TTL_SECONDS);
    });
  });

  describe("loadLimitsConfig (issue #130)", () => {
    const created: string[] = [];
    afterEach(() => {
      delete process.env.LLM_GATEWAY_CONFIG;
      for (const p of created.splice(0)) {
        rmSync(p, { force: true });
        rmSync(join(p, ".."), { recursive: true, force: true });
      }
    });

    it("returns defaults when the new limit keys are absent", () => {
      const path = withConfigToml("[persistence]\nbackend = 'sqlite'\n");
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      const cfg = loadLimitsConfig();
      expect(cfg.http.maxSessions).toBe(DEFAULT_HTTP_MAX_SESSIONS);
      expect(cfg.http.sessionIdleTtlMs).toBe(DEFAULT_HTTP_SESSION_IDLE_TTL_MS);
      expect(cfg.jobs.maxRunningJobs).toBe(DEFAULT_MAX_RUNNING_JOBS);
      expect(cfg.jobs.maxRunningJobsPerProvider).toBe(DEFAULT_MAX_RUNNING_JOBS_PER_PROVIDER);
      expect(cfg.jobs.maxJobOutputBytes).toBe(DEFAULT_MAX_JOB_OUTPUT_BYTES);
      expect(cfg.jobs.completedJobMemoryTtlMs).toBe(DEFAULT_COMPLETED_JOB_MEMORY_TTL_MS);
    });

    it("returns defaults when there is no config file at all", () => {
      process.env.LLM_GATEWAY_CONFIG = join(tmpdir(), "does-not-exist-limits.toml");
      const cfg = loadLimitsConfig();
      expect(cfg.http.maxSessions).toBe(DEFAULT_HTTP_MAX_SESSIONS);
      expect(cfg.jobs.maxRunningJobs).toBe(DEFAULT_MAX_RUNNING_JOBS);
      expect(cfg.sources.configFile).toBeNull();
    });

    it("parses valid custom limit values", () => {
      const path = withConfigToml(
        [
          "[http]",
          "max_sessions = 5",
          "session_idle_ttl_ms = 1000",
          "session_reaper_interval_ms = 250",
          "",
          "[limits]",
          "max_running_jobs = 2",
          "max_running_jobs_per_provider = 1",
          "max_queued_jobs = 3",
          "queue_timeout_ms = 500",
          "completed_job_memory_ttl_ms = 2000",
          "max_job_output_bytes = 4096",
          "",
        ].join("\n")
      );
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      const cfg = loadLimitsConfig();
      expect(cfg.http.maxSessions).toBe(5);
      expect(cfg.http.sessionIdleTtlMs).toBe(1000);
      expect(cfg.http.sessionReaperIntervalMs).toBe(250);
      expect(cfg.jobs.maxRunningJobs).toBe(2);
      expect(cfg.jobs.maxRunningJobsPerProvider).toBe(1);
      expect(cfg.jobs.maxQueuedJobs).toBe(3);
      expect(cfg.jobs.queueTimeoutMs).toBe(500);
      expect(cfg.jobs.completedJobMemoryTtlMs).toBe(2000);
      expect(cfg.jobs.maxJobOutputBytes).toBe(4096);
    });

    it("coexists with [http.oauth] in the same [http] table", () => {
      const path = withConfigToml(
        ["[http]", "max_sessions = 7", "", "[http.oauth]", "enabled = false", ""].join("\n")
      );
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      const cfg = loadLimitsConfig();
      expect(cfg.http.maxSessions).toBe(7);
    });

    it("rejects a zero limit value with a clear error", () => {
      const path = withConfigToml("[limits]\nmax_running_jobs = 0\n");
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      expect(() => loadLimitsConfig()).toThrow(/Invalid \[limits\] config/);
    });

    it("rejects a negative limit value with a clear error", () => {
      const path = withConfigToml("[limits]\nmax_job_output_bytes = -1\n");
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      expect(() => loadLimitsConfig()).toThrow(/Invalid \[limits\] config/);
    });

    it("rejects a non-positive http session ttl with a clear error", () => {
      const path = withConfigToml("[http]\nsession_idle_ttl_ms = 0\n");
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      expect(() => loadLimitsConfig()).toThrow(/Invalid \[http\] session-limit config/);
    });

    it("rejects an unknown [limits] key (strict)", () => {
      const path = withConfigToml("[limits]\nmax_runing_jobs = 4\n");
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      expect(() => loadLimitsConfig()).toThrow(/Invalid \[limits\] config/);
    });
  });

  describe("loadSkillsConfig", () => {
    const created: string[] = [];

    afterEach(() => {
      delete process.env.LLM_GATEWAY_CONFIG;
      delete process.env.LLM_GATEWAY_SKILLS_PATH;
      for (const p of created.splice(0)) {
        rmSync(p, { force: true });
      }
    });

    function pointSkillsConfig(tomlBody: string): void {
      const p = withConfigToml(tomlBody);
      created.push(p);
      process.env.LLM_GATEWAY_CONFIG = p;
    }

    it("loads [skills].paths from config.toml", () => {
      pointSkillsConfig(
        ["[skills]", 'paths = ["/opt/gateway-skills", "~/local-skills"]'].join("\n")
      );

      const cfg = loadSkillsConfig(noopLogger);

      expect(cfg.paths).toEqual(["/opt/gateway-skills", "~/local-skills"]);
      expect(cfg.sources.configFile).toBe(process.env.LLM_GATEWAY_CONFIG);
      expect(cfg.sources.envOverrides).toEqual([]);
    });

    it("appends LLM_GATEWAY_SKILLS_PATH entries using the host delimiter", () => {
      pointSkillsConfig(["[skills]", 'paths = ["/opt/gateway-skills"]'].join("\n"));
      process.env.LLM_GATEWAY_SKILLS_PATH = ["/tmp/pack-a", "/tmp/pack-b"].join(delimiter);

      const cfg = loadSkillsConfig(noopLogger);

      expect(cfg.paths).toEqual(["/opt/gateway-skills", "/tmp/pack-a", "/tmp/pack-b"]);
      expect(cfg.sources.envOverrides).toEqual(["LLM_GATEWAY_SKILLS_PATH"]);
    });

    it("throws on invalid [skills] config", () => {
      pointSkillsConfig(["[skills]", 'paths = "/not-an-array"'].join("\n"));

      expect(() => loadSkillsConfig(noopLogger)).toThrow(/Invalid \[skills\] config/);
    });
  });

  describe("diagnoseRemoteOAuthConfig (remote setup projection)", () => {
    const created: string[] = [];
    // A clean env without OAuth overrides so the file drives the outcome.
    function useConfig(body: string): void {
      const path = withConfigToml(body);
      created.push(path);
      process.env.LLM_GATEWAY_CONFIG = path;
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("LLM_GATEWAY_OAUTH_")) delete process.env[key];
      }
    }
    afterEach(() => {
      delete process.env.LLM_GATEWAY_CONFIG;
      for (const p of created.splice(0)) {
        rmSync(p, { force: true });
        rmSync(join(p, ".."), { recursive: true, force: true });
      }
    });

    it("handles a missing [http.oauth] section without throwing (status absent)", () => {
      useConfig("[persistence]\nbackend = 'sqlite'\n");
      let result!: ReturnType<typeof diagnoseRemoteOAuthConfig>;
      expect(() => {
        result = diagnoseRemoteOAuthConfig(noopLogger, process.env);
      }).not.toThrow();
      expect(result.status).toBe("absent");
      expect(result.configured).toBe(false);
      expect(result.config.enabled).toBe(false);
      expect(result.issues).toEqual([]);
    });

    it("reports a deliberately disabled block as disabled, not malformed", () => {
      useConfig(["[http.oauth]", "enabled = false", ""].join("\n"));
      const result = diagnoseRemoteOAuthConfig(noopLogger, process.env);
      expect(result.status).toBe("disabled");
      expect(result.configured).toBe(true);
      expect(result.config.enabled).toBe(false);
    });

    it("produces actionable diagnostics for a malformed enabled config while failing closed", () => {
      // enabled OAuth with a confidential client that has no secret hash.
      useConfig(
        [
          "[http.oauth]",
          "enabled = true",
          "[[http.oauth.clients]]",
          'client_id = "chatgpt"',
          'allowed_redirect_uris = ["https://chatgpt.com/connector/callback"]',
          "",
        ].join("\n")
      );
      const result = diagnoseRemoteOAuthConfig(noopLogger, process.env);
      expect(result.status).toBe("malformed");
      // Fail-closed: runtime OAuth is disabled even though the operator asked for it.
      expect(result.config.enabled).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(" ")).toContain("client_secret_hash");
      // Diagnostics never echo secret material.
      expect(result.issues.join(" ")).not.toMatch(/scrypt:/);
    });

    it("classifies a valid enabled config with a confidential client as enabled", () => {
      const hash = hashSecret("s3cret-value");
      useConfig(
        [
          "[http.oauth]",
          "enabled = true",
          'issuer = "auto"',
          "[[http.oauth.clients]]",
          'client_id = "chatgpt"',
          `client_secret_hash = "${hash}"`,
          'allowed_redirect_uris = ["https://chatgpt.com/connector/callback"]',
          "",
        ].join("\n")
      );
      const result = diagnoseRemoteOAuthConfig(noopLogger, process.env);
      expect(result.status).toBe("enabled");
      expect(result.config.enabled).toBe(true);
      expect(result.config.clients).toHaveLength(1);
      expect(result.config.registrationPolicy).toBe("static_clients");
    });
  });
});
