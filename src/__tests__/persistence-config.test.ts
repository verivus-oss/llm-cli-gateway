import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistenceConfig,
  loadProvidersConfig,
  isXaiProviderEnabled,
  DEFAULT_JOB_RETENTION_DAYS,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_XAI_API_KEY_ENV,
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_MODEL,
  type PersistenceConfig,
  type ProvidersConfig,
} from "../config.js";
import { MemoryJobStore, SqliteJobStore, createJobStore, PostgresJobStore } from "../job-store.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { createGatewayServer } from "../index.js";
import { noopLogger } from "../logger.js";

describe("loadPersistenceConfig", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "persistence-config-test-"));
    // Stash setup.ts's test config so we can override per test.
    stubbedConfig = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbedConfig === undefined) {
      delete process.env.LLM_GATEWAY_CONFIG;
    } else {
      process.env.LLM_GATEWAY_CONFIG = stubbedConfig;
    }
  });

  function pointToFile(tomlBody: string): string {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, tomlBody);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
    return p;
  }

  function pointToMissing(): void {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "does-not-exist.toml"));
    // Also ensure legacy env vars don't leak in from setup.ts.
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
  }

  it("returns sqlite defaults when no config file and no env vars are set", () => {
    pointToMissing();
    // Unset legacy vars so they don't override.
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.backend).toBe("sqlite");
    expect(cfg.path).toMatch(/logs\.db$/);
    expect(cfg.retentionDays).toBe(DEFAULT_JOB_RETENTION_DAYS);
    expect(cfg.dedupWindowMs).toBe(DEFAULT_DEDUP_WINDOW_MS);
    expect(cfg.asyncJobsEnabled).toBe(true);
    expect(cfg.sources.envOverrides).toEqual([]);
  });

  it("loads sqlite backend with explicit path from config file", () => {
    pointToFile(
      [
        "[persistence]",
        'backend = "sqlite"',
        `path = "${join(tempDir, "jobs.db").replace(/\\/g, "\\\\")}"`,
        "retentionDays = 7",
        "",
      ].join("\n")
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.backend).toBe("sqlite");
    expect(cfg.path).toBe(join(tempDir, "jobs.db"));
    expect(cfg.retentionDays).toBe(7);
    expect(cfg.asyncJobsEnabled).toBe(true);
  });

  it("backend=none disables async jobs", () => {
    pointToFile(["[persistence]", 'backend = "none"', ""].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.backend).toBe("none");
    expect(cfg.asyncJobsEnabled).toBe(false);
  });

  it("backend=memory without acknowledgeEphemeral throws at startup", () => {
    pointToFile(["[persistence]", 'backend = "memory"', ""].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/acknowledgeEphemeral/);
  });

  it("backend=memory + acknowledgeEphemeral=true enables async jobs", () => {
    pointToFile(
      ["[persistence]", 'backend = "memory"', "acknowledgeEphemeral = true", ""].join("\n")
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.backend).toBe("memory");
    expect(cfg.asyncJobsEnabled).toBe(true);
  });

  it("backend=postgres requires dsn", () => {
    pointToFile(["[persistence]", 'backend = "postgres"', ""].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/dsn/);
  });

  it("LLM_GATEWAY_LOGS_DB=none env overrides file with deprecation warning", () => {
    pointToFile(
      [
        "[persistence]",
        'backend = "sqlite"',
        `path = "${join(tempDir, "jobs.db").replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n")
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "none");
    const warn = vi.fn();
    const cfg = loadPersistenceConfig({
      info: () => {},
      error: () => {},
      debug: () => {},
      warn,
    });
    expect(cfg.backend).toBe("none");
    expect(cfg.sources.envOverrides).toContain("LLM_GATEWAY_LOGS_DB");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/LLM_GATEWAY_LOGS_DB is deprecated/),
      expect.anything()
    );
  });

  it("LLM_GATEWAY_LOGS_DB=<path> env switches to sqlite at that path", () => {
    pointToMissing();
    const customPath = join(tempDir, "custom.db");
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", customPath);
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.backend).toBe("sqlite");
    expect(cfg.path).toBe(customPath);
  });

  it("LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL env emits deprecation warning", () => {
    pointToFile(["[persistence]", 'backend = "memory"', "", ""].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    vi.stubEnv("LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL", "1");
    const warn = vi.fn();
    const cfg = loadPersistenceConfig({
      info: () => {},
      error: () => {},
      debug: () => {},
      warn,
    });
    expect(cfg.acknowledgeEphemeral).toBe(true);
    expect(cfg.sources.envOverrides).toContain("LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL is deprecated/),
      expect.anything()
    );
  });

  it("LLM_GATEWAY_JOB_RETENTION_DAYS env overrides retentionDays", () => {
    pointToMissing();
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOB_RETENTION_DAYS", "5");
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.retentionDays).toBe(5);
    expect(cfg.sources.envOverrides).toContain("LLM_GATEWAY_JOB_RETENTION_DAYS");
  });
});

describe("loadProvidersConfig", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "providers-config-test-"));
    stubbedConfig = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbedConfig === undefined) {
      delete process.env.LLM_GATEWAY_CONFIG;
    } else {
      process.env.LLM_GATEWAY_CONFIG = stubbedConfig;
    }
  });

  function pointToFile(tomlBody: string): string {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, tomlBody);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
    return p;
  }

  it("returns disabled xAI defaults when [providers.xai] is absent", () => {
    pointToFile(["[persistence]", 'backend = "none"', ""].join("\n"));
    const cfg = loadProvidersConfig(noopLogger);
    expect(cfg.xai).toBeNull();
  });

  it("loads [providers.xai] with default API env, base URL, and model", () => {
    pointToFile(["[providers.xai]", ""].join("\n"));
    const cfg = loadProvidersConfig(noopLogger);
    expect(cfg.xai).toEqual({
      apiKeyEnv: DEFAULT_XAI_API_KEY_ENV,
      baseUrl: DEFAULT_XAI_BASE_URL,
      defaultModel: DEFAULT_XAI_MODEL,
    });
  });

  it("loads explicit [providers.xai] values without reading key material", () => {
    pointToFile(
      [
        "[providers.xai]",
        'api_key_env = "CUSTOM_XAI_KEY"',
        'base_url = "https://example.test/v1"',
        'default_model = "grok-4.3"',
        "",
      ].join("\n")
    );
    vi.stubEnv("CUSTOM_XAI_KEY", "secret-value");
    const cfg = loadProvidersConfig(noopLogger);
    expect(cfg.xai).toEqual({
      apiKeyEnv: "CUSTOM_XAI_KEY",
      baseUrl: "https://example.test/v1",
      defaultModel: "grok-4.3",
    });
    expect(JSON.stringify(cfg)).not.toContain("secret-value");
  });

  it("gates xAI enablement on the configured env var being non-empty", () => {
    pointToFile(["[providers.xai]", 'api_key_env = "CUSTOM_XAI_KEY"', ""].join("\n"));
    const cfg = loadProvidersConfig(noopLogger);
    expect(isXaiProviderEnabled(cfg, {})).toBe(false);
    expect(isXaiProviderEnabled(cfg, { CUSTOM_XAI_KEY: "   " })).toBe(false);
    expect(isXaiProviderEnabled(cfg, { CUSTOM_XAI_KEY: "present" })).toBe(true);
  });

  it("schema-invalid [providers.xai] disables only the provider", () => {
    pointToFile(
      [
        "[persistence]",
        'backend = "sqlite"',
        `path = "${join(tempDir, "jobs.db").replace(/\\/g, "\\\\")}"`,
        "",
        "[providers.xai]",
        "base_url = 42",
        "",
      ].join("\n")
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
    vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
    const warn = vi.fn();
    const logger = {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn,
    };
    const providers = loadProvidersConfig(logger);
    const persistence = loadPersistenceConfig(logger);
    expect(providers.xai).toBeNull();
    expect(persistence.backend).toBe("sqlite");
    expect(persistence.path).toBe(join(tempDir, "jobs.db"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid \[providers\.xai\] config/),
      expect.anything()
    );
  });

  it("rejects plaintext non-loopback xAI base URLs", () => {
    pointToFile(["[providers.xai]", 'base_url = "http://api.example.test/v1"', ""].join("\n"));
    const warn = vi.fn();
    const logger = {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn,
    };
    const providers = loadProvidersConfig(logger);
    expect(providers.xai).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid \[providers\.xai\] config/),
      expect.anything()
    );
  });
});

describe("createJobStore", () => {
  it("returns null for backend=none", () => {
    const store = createJobStore({
      backend: "none",
      path: null,
      dsn: null,
      retentionDays: 30,
      dedupWindowMs: 3600000,
      acknowledgeEphemeral: false,
      asyncJobsEnabled: false,
      sources: { configFile: null, envOverrides: [] },
    });
    expect(store).toBeNull();
  });

  it("returns MemoryJobStore for backend=memory", () => {
    const store = createJobStore({
      backend: "memory",
      path: null,
      dsn: null,
      retentionDays: 30,
      dedupWindowMs: 3600000,
      acknowledgeEphemeral: true,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    });
    expect(store).toBeInstanceOf(MemoryJobStore);
  });

  it("returns SqliteJobStore for backend=sqlite", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cjs-sqlite-"));
    try {
      const store = createJobStore({
        backend: "sqlite",
        path: join(tempDir, "j.db"),
        dsn: null,
        retentionDays: 30,
        dedupWindowMs: 3600000,
        acknowledgeEphemeral: false,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      });
      expect(store).toBeInstanceOf(SqliteJobStore);
      store?.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("createJobStore({backend:'postgres'}) reaches the throwing Postgres stub", () => {
    expect(() =>
      createJobStore({
        backend: "postgres",
        path: null,
        dsn: "postgresql://x@y/z",
        retentionDays: 30,
        dedupWindowMs: 3600000,
        acknowledgeEphemeral: false,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      })
    ).toThrow(/not yet implemented/);
  });

  it("PostgresJobStore constructor also throws when called directly", () => {
    // Belt-and-braces: catches a regression where someone changes the factory
    // to swallow the throw but leaves the stub class lying around.
    expect(() => new PostgresJobStore("postgresql://x@y/z")).toThrow(/not yet implemented/);
  });
});

describe("MemoryJobStore", () => {
  it("round-trips a job record through start → output → complete → getById", () => {
    const store = new MemoryJobStore();
    store.recordStart({
      id: "j1",
      correlationId: "c1",
      requestKey: "k1",
      cli: "claude",
      args: ["-p", "hello"],
      startedAt: new Date().toISOString(),
      pid: 1234,
    });
    store.recordOutput("j1", "stdout-here", "stderr-here", false);
    store.recordComplete({
      id: "j1",
      status: "completed",
      exitCode: 0,
      stdout: "final-stdout",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    const row = store.getById("j1");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.stdout).toBe("final-stdout");
    expect(row!.cli).toBe("claude");
  });

  it("findByRequestKey returns the most recent matching job within the dedup window", () => {
    const store = new MemoryJobStore({ dedupWindowMs: 60_000 });
    const t0 = new Date(Date.now() - 10_000).toISOString();
    store.recordStart({
      id: "old",
      correlationId: "c",
      requestKey: "same-key",
      cli: "codex",
      args: [],
      startedAt: t0,
      pid: null,
    });
    store.recordStart({
      id: "new",
      correlationId: "c",
      requestKey: "same-key",
      cli: "codex",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
    });
    const found = store.findByRequestKey("same-key");
    expect(found?.id).toBe("new");
  });

  it("findByRequestKey ignores jobs outside the dedup window", () => {
    const store = new MemoryJobStore({ dedupWindowMs: 1 });
    store.recordStart({
      id: "stale",
      correlationId: "c",
      requestKey: "k",
      cli: "codex",
      args: [],
      startedAt: new Date(Date.now() - 1_000_000).toISOString(),
      pid: null,
    });
    expect(store.findByRequestKey("k")).toBeNull();
  });

  it("evictExpired removes completed rows whose expiresAt has passed", () => {
    const store = new MemoryJobStore({ retentionMs: 1 });
    store.recordStart({
      id: "j",
      correlationId: "c",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
    });
    store.recordComplete({
      id: "j",
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(store.evictExpired()).toBe(1);
    expect(store.getById("j")).toBeNull();
  });

  it("markOrphanedOnStartup is a no-op for memory stores", () => {
    const store = new MemoryJobStore();
    expect(store.markOrphanedOnStartup()).toEqual({ count: 0, orphaned: [] });
  });
});

describe("AsyncJobManager.hasStore", () => {
  it("returns false when constructed with null store", () => {
    const m = new AsyncJobManager(noopLogger, undefined, null);
    expect(m.hasStore()).toBe(false);
  });

  it("returns true when constructed with a store", () => {
    const m = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    expect(m.hasStore()).toBe(true);
  });
});

describe("createGatewayServer — structural invariant on async tool registration", () => {
  const REGISTRY_KEY = "_registeredTools";
  const ASYNC_TOOL_NAMES = [
    "claude_request_async",
    "codex_request_async",
    "gemini_request_async",
    "grok_request_async",
    "mistral_request_async",
    "llm_job_status",
    "llm_job_result",
    "llm_job_cancel",
  ] as const;

  function registeredToolNames(server: ReturnType<typeof createGatewayServer>): Set<string> {
    // The MCP SDK keeps registered tools on a private `_registeredTools`
    // plain object (name → registration). Reaching into it is the only way
    // to introspect without round-tripping through a transport. Acceptable
    // for a test.
    const reg = (server as unknown as Record<string, Record<string, unknown>>)[REGISTRY_KEY];
    return new Set(Object.keys(reg));
  }

  function mkPersistence(overrides: Partial<PersistenceConfig> = {}): PersistenceConfig {
    return {
      backend: "memory",
      path: null,
      dsn: null,
      retentionDays: 30,
      dedupWindowMs: 3600000,
      acknowledgeEphemeral: true,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
      ...overrides,
    };
  }

  function mkProviders(overrides: Partial<ProvidersConfig> = {}): ProvidersConfig {
    return {
      xai: null,
      sources: { configFile: null },
      ...overrides,
    };
  }

  it("registers all 8 async tools when persistence.asyncJobsEnabled AND manager has store", () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ asyncJobsEnabled: true }),
    });
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to be registered`).toBe(true);
    }
  });

  it("does NOT register async tools when manager has no store, even if asyncJobsEnabled=true", () => {
    // This is the codex CLAIM 4f blocker: an injected
    // persistence.asyncJobsEnabled=true paired with a null-store manager
    // (e.g. isolate-mode runtime) used to silently re-register the async
    // tools. With the structural fix, hasStore()===false forces the gate
    // off regardless of what the injected config says.
    const manager = new AsyncJobManager(noopLogger, undefined, null);
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "none", asyncJobsEnabled: true }),
    });
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to NOT be registered`).toBe(false);
    }
    // Sanity: non-async tools are still registered.
    expect(tools.has("llm_process_health")).toBe(true);
    // llm_request_result reads the flight recorder, not the async job store,
    // so it must register even when async persistence is fully gated off.
    expect(tools.has("llm_request_result")).toBe(true);
  });

  it("does NOT register async tools when persistence.asyncJobsEnabled=false, even if manager has store", () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "none", asyncJobsEnabled: false }),
    });
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to NOT be registered`).toBe(false);
    }
  });

  it("does NOT register async tools when backend='none' even if asyncJobsEnabled=true AND store is attached (caller lies about flag)", () => {
    // Codex round-2 blocker reproduction: an inconsistent injected config
    // where backend='none' but asyncJobsEnabled was flipped to true used to
    // sneak past the gate when paired with a real store-backed manager.
    // SPEC CLAIM 4f requires that backend='none' structurally guarantees
    // absence of async tools regardless of any other field, so the gate
    // now ANDs `persistence.backend !== "none"` in addition to the flag
    // and the store-presence check.
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "none", asyncJobsEnabled: true }),
    });
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to NOT be registered`).toBe(false);
    }
    expect(tools.has("llm_process_health")).toBe(true);
  });

  it("registers grok_api_request when xAI config is enabled and leaves async unregistered", () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ asyncJobsEnabled: true }),
      providers: mkProviders({
        xai: {
          apiKeyEnv: "XAI_API_KEY",
          baseUrl: "https://api.x.ai/v1",
          defaultModel: "grok-build-0.1",
        },
      }),
    });
    const tools = registeredToolNames(server);
    expect(tools.has("grok_api_request")).toBe(true);
    expect(tools.has("grok_api_request_async")).toBe(false);
  });

  it("does not register grok_api_request when the configured xAI key env var is missing", () => {
    vi.stubEnv("XAI_API_KEY", "");
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ asyncJobsEnabled: true }),
      providers: mkProviders({
        xai: {
          apiKeyEnv: "XAI_API_KEY",
          baseUrl: "https://api.x.ai/v1",
          defaultModel: "grok-build-0.1",
        },
      }),
    });
    const tools = registeredToolNames(server);
    expect(tools.has("grok_api_request")).toBe(false);
    expect(tools.has("grok_api_request_async")).toBe(false);
  });

  // Regression: llm_process_health must report the EFFECTIVE async state
  // (config flag AND hasStore()), not the raw configured intent. A backend
  // whose durable store fails to open (backend='postgres', which always throws,
  // or a sqlite DB that fails to open) is caught in getJobStore() and nulls the
  // store, so async tools are not registered, and health must not claim they
  // are.
  async function readHealthPersistence(
    server: ReturnType<typeof createGatewayServer>
  ): Promise<{ backend: string; asyncJobsEnabled: boolean; warning: string | null }> {
    const reg = (
      server as unknown as Record<
        string,
        Record<
          string,
          {
            handler?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
            callback?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
          }
        >
      >
    )[REGISTRY_KEY];
    const tool = reg["llm_process_health"];
    const fn = tool.handler ?? tool.callback;
    if (!fn) throw new Error("llm_process_health not registered");
    const result = await fn({}, {});
    return JSON.parse(result.content[0].text).persistence;
  }

  async function readHealthFull(
    server: ReturnType<typeof createGatewayServer>
  ): Promise<Record<string, any>> {
    const reg = (
      server as unknown as Record<
        string,
        Record<
          string,
          {
            handler?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
            callback?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
          }
        >
      >
    )[REGISTRY_KEY];
    const tool = reg["llm_process_health"];
    const fn = tool.handler ?? tool.callback;
    if (!fn) throw new Error("llm_process_health not registered");
    const result = await fn({}, {});
    return JSON.parse(result.content[0].text);
  }

  it("llm_process_health reports issue #130 backpressure metrics (jobs, http caps, parent memory) without secrets", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "memory", acknowledgeEphemeral: true }),
    });
    const health = await readHealthFull(server);
    const bp = health.backpressure;
    expect(bp).toBeDefined();
    // Job limiter metrics.
    expect(typeof bp.jobs.running).toBe("number");
    expect(typeof bp.jobs.queued).toBe("number");
    expect(bp.jobs.runningByProvider).toBeDefined();
    expect(bp.jobs.queuedByProvider).toBeDefined();
    expect(typeof bp.jobs.maxRunning).toBe("number");
    expect(typeof bp.jobs.saturated).toBe("boolean");
    expect(typeof bp.jobs.completedJobMemoryTtlMs).toBe("number");
    expect(typeof bp.jobs.maxJobOutputBytes).toBe("number");
    // HTTP session caps (stdio path: not active, configured caps only).
    expect(bp.httpSessions.active).toBe(false);
    expect(typeof bp.httpSessions.max).toBe("number");
    expect(typeof bp.httpSessions.idleTtlMs).toBe("number");
    // Parent-process memory.
    expect(bp.memory.rss).toBeGreaterThan(0);
    expect(bp.memory.heapUsed).toBeGreaterThan(0);
    // Redaction: nothing prompt/token/secret-shaped in the backpressure block.
    const raw = JSON.stringify(bp);
    expect(raw).not.toMatch(/prompt|bearer|api[_-]?key|authorization|secret/i);
  });

  it("llm_process_health reports saturation when a provider is queued at its per-provider cap", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), undefined, {
      maxRunningJobs: 10,
      maxRunningJobsPerProvider: 1,
      maxQueuedJobs: 5,
      queueTimeoutMs: 10_000,
      completedJobMemoryTtlMs: 60 * 60 * 1000,
      maxJobOutputBytes: 50 * 1024 * 1024,
    });
    const running = manager.startJob("sleep" as any, ["2"], "corr-running");
    const queued = manager.startJob("sleep" as any, ["3"], "corr-queued");
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "memory", acknowledgeEphemeral: true }),
    });

    try {
      const health = await readHealthFull(server);

      expect(health.backpressure.jobs.running).toBe(1);
      expect(health.backpressure.jobs.queued).toBe(1);
      expect(health.backpressure.jobs.saturated).toBe(true);
    } finally {
      manager.cancelJob(queued.id);
      manager.cancelJob(running.id);
    }
  });

  it("llm_process_health reports asyncJobsEnabled=false when the durable store failed to open (backend != 'none')", async () => {
    // Post-catch runtime: getJobStore() caught a store-open error (e.g.
    // backend='postgres', whose store constructor always throws) and nulled the
    // store. The config flag says enabled; the effective state is not.
    const manager = new AsyncJobManager(noopLogger, undefined, null);
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({
        backend: "postgres",
        dsn: "postgresql://x",
        asyncJobsEnabled: true,
      }),
    });
    // Existing invariant: no async tools registered without a store.
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to NOT be registered`).toBe(false);
    }
    // New: health reports the effective state, not the config intent.
    const p = await readHealthPersistence(server);
    expect(p.backend).toBe("postgres");
    expect(p.asyncJobsEnabled).toBe(false);
    expect(p.warning).toMatch(/failed to open/i);
  });

  it("llm_process_health reports asyncJobsEnabled=true with no warning when a store is attached", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "sqlite", path: ":memory:", asyncJobsEnabled: true }),
    });
    const p = await readHealthPersistence(server);
    expect(p.asyncJobsEnabled).toBe(true);
    expect(p.warning).toBeNull();
  });

  it("llm_process_health keeps the backend='none' disabled warning", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, null);
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "none", asyncJobsEnabled: false }),
    });
    const p = await readHealthPersistence(server);
    expect(p.asyncJobsEnabled).toBe(false);
    expect(p.warning).toMatch(/backend = 'none'/);
  });

  it("llm_process_health reports asyncJobsEnabled=false for backend='none' even if the flag is lied true AND a store is attached", async () => {
    // Mirrors the registration gate's structural guarantee (backend='none' wins
    // regardless of other fields). Health must match: report effective=false,
    // not the raw config flag, for the same injected-inconsistent config the
    // "caller lies about flag" registration test above covers.
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence({ backend: "none", asyncJobsEnabled: true }),
    });
    const tools = registeredToolNames(server);
    for (const t of ASYNC_TOOL_NAMES) {
      expect(tools.has(t), `expected ${t} to NOT be registered`).toBe(false);
    }
    const p = await readHealthPersistence(server);
    expect(p.asyncJobsEnabled).toBe(false);
    expect(p.warning).toMatch(/backend = 'none'/);
  });
});
