import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistenceConfig,
  DEFAULT_JOB_RETENTION_DAYS,
  DEFAULT_DEDUP_WINDOW_MS,
  type PersistenceConfig,
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
});
