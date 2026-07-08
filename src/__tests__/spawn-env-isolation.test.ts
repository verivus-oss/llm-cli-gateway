import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { spawnCliProcess } from "../executor.js";
import {
  applySpawnEnvIsolation,
  isRedirectionEnvKey,
  isSpawnEnvIsolationEnabled,
  resetSpawnEnvIsolationWarning,
  sanitizeSpawnEnv,
} from "../spawn-env-isolation.js";

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

afterEach(() => {
  resetSpawnEnvIsolationWarning();
});

describe("isRedirectionEnvKey", () => {
  it("flags endpoint-override and proxy variables (case-insensitive)", () => {
    for (const key of [
      // *_BASE_URL
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "MISTRAL_BASE_URL",
      "CURSOR_API_BASE_URL",
      // *_API_URL
      "ANTHROPIC_API_URL",
      "OPENAI_API_URL",
      "XAI_API_URL",
      "GEMINI_API_URL",
      "DEVIN_API_URL",
      // *_API_BASE
      "OPENAI_API_BASE",
      // *_ENDPOINT / *_ENDPOINT_URL
      "AZURE_OPENAI_ENDPOINT",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT",
      "AWS_ENDPOINT_URL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      // *_SERVER_URL
      "WINDSURF_API_SERVER_URL",
      // socket redirects (exact)
      "ANTHROPIC_UNIX_SOCKET",
      "GROK_LEADER_SOCKET",
      // proxies (any *_PROXY, incl. socks)
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "FTP_PROXY",
      "SOCKS_PROXY",
      "SOCKS5_PROXY",
      "https_proxy",
      "all_proxy",
      "socks_proxy",
    ]) {
      expect(isRedirectionEnvKey(key)).toBe(true);
    }
  });

  it("does not flag benign or credential variables, NO_PROXY, or bare *_URL", () => {
    for (const key of [
      "PATH",
      "HOME",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CURSOR_API_KEY",
      "VIBE_ACTIVE_MODEL",
      "DATABASE_URL",
      "SUPABASE_URL",
      "REDIS_URL",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "NO_PROXY",
      "no_proxy",
    ]) {
      expect(isRedirectionEnvKey(key)).toBe(false);
    }
  });
});

describe("isSpawnEnvIsolationEnabled", () => {
  it("is opt-in: only enabled for explicit truthy flags", () => {
    for (const raw of ["1", "true", "on", "yes", " TRUE ", "On"]) {
      expect(isSpawnEnvIsolationEnabled({ LLM_GATEWAY_ISOLATE_SPAWN_ENV: raw })).toBe(true);
    }
    for (const raw of ["", "0", "false", "off", "no", undefined as unknown as string]) {
      expect(isSpawnEnvIsolationEnabled({ LLM_GATEWAY_ISOLATE_SPAWN_ENV: raw })).toBe(false);
    }
    expect(isSpawnEnvIsolationEnabled({})).toBe(false);
  });
});

describe("sanitizeSpawnEnv", () => {
  it("strips redirection variables, preserves the rest, and reports what it removed", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "sk-ant-keep-me",
      ANTHROPIC_BASE_URL: "https://evil.example/proxy",
      ANTHROPIC_API_URL: "https://evil.example/v1",
      OPENAI_API_BASE: "https://evil.example/v1",
      AWS_ENDPOINT_URL: "https://evil.example",
      HTTPS_PROXY: "http://evil.example:8080",
      NO_PROXY: "localhost",
    };

    const { env, stripped } = sanitizeSpawnEnv(input);

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "sk-ant-keep-me",
      NO_PROXY: "localhost",
    });
    expect(stripped.sort()).toEqual([
      "ANTHROPIC_API_URL",
      "ANTHROPIC_BASE_URL",
      "AWS_ENDPOINT_URL",
      "HTTPS_PROXY",
      "OPENAI_API_BASE",
    ]);
    // Input is not mutated.
    expect(input.ANTHROPIC_BASE_URL).toBe("https://evil.example/proxy");
  });

  it("returns an empty stripped list when nothing matches", () => {
    const { env, stripped } = sanitizeSpawnEnv({ PATH: "/usr/bin", HOME: "/home/dev" });
    expect(stripped).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev" });
  });
});

describe("applySpawnEnvIsolation", () => {
  const hostile: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-keep-me",
    ANTHROPIC_BASE_URL: "https://evil.example/proxy",
  };

  it("returns the env unchanged when the flag is off (default)", () => {
    const logger = makeLogger();
    const out = applySpawnEnvIsolation(hostile, logger, {});
    expect(out).toBe(hostile); // same reference, no copy
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("strips redirection vars when the flag is on and preserves credentials", () => {
    const logger = makeLogger();
    const out = applySpawnEnvIsolation(hostile, logger, { LLM_GATEWAY_ISOLATE_SPAWN_ENV: "1" });
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-keep-me");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("warns exactly once across multiple spawns", () => {
    const logger = makeLogger();
    const env = { LLM_GATEWAY_ISOLATE_SPAWN_ENV: "1" };
    applySpawnEnvIsolation(hostile, logger, env);
    applySpawnEnvIsolation(hostile, logger, env);
    applySpawnEnvIsolation(hostile, logger, env);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("ANTHROPIC_BASE_URL");
  });

  it("does not let a logger-less call swallow the one-time warning", () => {
    const env = { LLM_GATEWAY_ISOLATE_SPAWN_ENV: "1" };
    // First spawn has no logger (e.g. a direct executeCli without options.logger):
    // it must still strip, but must NOT consume the single operator-visible warning.
    const out = applySpawnEnvIsolation(hostile, undefined, env);
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
    // A later spawn that does have a logger still gets the warning.
    const logger = makeLogger();
    applySpawnEnvIsolation(hostile, logger, env);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the flag is on but nothing needed stripping", () => {
    const logger = makeLogger();
    const clean = { PATH: "/usr/bin", HOME: "/home/dev" };
    const out = applySpawnEnvIsolation(clean, logger, { LLM_GATEWAY_ISOLATE_SPAWN_ENV: "1" });
    expect(out).toEqual(clean);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("spawnCliProcess chokepoint (integration)", () => {
  // Proves the fix for the sync-path bypass: the inline path passes
  // `{ ...process.env, ...env }` as the spawn env, so redirection vars must be
  // stripped at the spawn chokepoint, not merely on a base env upstream.
  async function spawnAndReadEnv(childEnv: NodeJS.ProcessEnv): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawnCliProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write(String(process.env.HTTPS_PROXY)+'|'+String(process.env.ANTHROPIC_BASE_URL))",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: childEnv }
      );
      let out = "";
      child.stdout?.on("data", d => (out += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });
  }

  it("strips redirection vars from the FINAL merged env when isolation is on", async () => {
    const prev = process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV;
    process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV = "1";
    try {
      const out = await spawnAndReadEnv({
        ...process.env,
        HTTPS_PROXY: "http://evil.example:8080",
        ANTHROPIC_BASE_URL: "https://evil.example",
      });
      expect(out).toBe("undefined|undefined");
    } finally {
      if (prev === undefined) delete process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV;
      else process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV = prev;
      resetSpawnEnvIsolationWarning();
    }
  });

  it("passes redirection vars through when isolation is off (default)", async () => {
    const prev = process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV;
    delete process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV;
    try {
      const out = await spawnAndReadEnv({
        ...process.env,
        HTTPS_PROXY: "http://proxy.example:8080",
        ANTHROPIC_BASE_URL: "https://endpoint.example",
      });
      expect(out).toBe("http://proxy.example:8080|https://endpoint.example");
    } finally {
      if (prev !== undefined) process.env.LLM_GATEWAY_ISOLATE_SPAWN_ENV = prev;
    }
  });
});
