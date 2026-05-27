/**
 * Phase 4 slice κ — test-veracity regressions for Claude
 * `cache_control` via `--input-format stream-json`.
 *
 * Mirrors the REGRESSIONS pattern from slices ε / ζ / η / θ. Every test
 * below is mutation-probe-friendly; the audit spec at
 * `docs/plans/slice-kappa.spec.md` documents the counterexample
 * mutations each LLM reviewer must run before approving this slice.
 *
 * Probe targets:
 *
 *   P-Kα-1..4 — PromptParts Zod + assembleClaudeCacheBlocks helper.
 *   P-Kβ-1..5 — prepareClaudeRequest argv + stdin + ttl + regression.
 *   P-Kγ-1..4 — UPSTREAM_CLI_CONTRACTS: optional arity + --input-format.
 *   P-Kδ-1..3 — executor + async-job-manager stdin wiring + dedup key.
 *   P-Kε-1..4 — FlightRecorder migration v4 + cache_control_blocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { PromptPartsSchema, assembleClaudeCacheBlocks } from "../prompt-parts.js";
import { prepareClaudeRequest } from "../index.js";
import { UPSTREAM_CLI_CONTRACTS, validateUpstreamCliArgs } from "../upstream-contracts.js";
import { executeCli } from "../executor.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { FlightRecorder } from "../flight-recorder.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

const BASE_CLAUDE_PARAMS = {
  outputFormat: "stream-json" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};

// ─── REGRESSIONS Kα — PromptParts Zod + assembleClaudeCacheBlocks ──────
//
// Falsifiability: dropping cacheControl from the schema fails Kα-1's
// data-retention assertion; flipping ttl to "5m" fails Kα-3/5/6.

describe("REGRESSIONS Kα — PromptParts.cacheControl + assembleClaudeCacheBlocks (slice κ)", () => {
  it("PromptPartsSchema accepts cacheControl and preserves it on the parsed value", () => {
    const parsed = PromptPartsSchema.safeParse({
      task: "x",
      cacheControl: { system: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Critical: catches a regression that drops cacheControl from the
      // schema (Zod would still pass non-strict objects, but the field
      // would be stripped — breaking downstream κ detection).
      expect(parsed.data.cacheControl?.system).toBe(true);
    }
  });

  it("PromptPartsSchema rejects non-boolean cacheControl entries", () => {
    const parsed = PromptPartsSchema.safeParse({
      task: "x",
      // @ts-expect-error — intentional bad type
      cacheControl: { system: "yes" },
    });
    expect(parsed.success).toBe(false);
  });

  it("assembleClaudeCacheBlocks emits 4 blocks in order with cache_control only on the marked block", () => {
    const r = assembleClaudeCacheBlocks({
      system: "S",
      tools: "T",
      context: "C",
      task: "K",
      cacheControl: { system: true },
    });
    const blocks = r.payload.message.content;
    expect(blocks.length).toBe(4);
    expect(blocks[0].text).toBe("S");
    expect(blocks[1].text).toBe("T");
    expect(blocks[2].text).toBe("C");
    expect(blocks[3].text).toBe("K");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toBeUndefined();
    expect(blocks[3].cache_control).toBeUndefined();
    expect(r.markedBlockCount).toBe(1);
  });

  it("assembleClaudeCacheBlocks skips empty parts and does NOT count their cacheControl marker", () => {
    const r = assembleClaudeCacheBlocks({
      task: "K",
      cacheControl: { system: true },
    });
    expect(r.payload.message.content.length).toBe(1);
    expect(r.payload.message.content[0].text).toBe("K");
    expect(r.markedBlockCount).toBe(0);
  });

  it("assembleClaudeCacheBlocks never marks the task block, even when system+tools+context are all marked", () => {
    const r = assembleClaudeCacheBlocks({
      system: "S",
      tools: "T",
      context: "C",
      task: "K",
      cacheControl: { system: true, tools: true, context: true },
    });
    const blocks = r.payload.message.content;
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[3].cache_control).toBeUndefined();
    expect(r.markedBlockCount).toBe(3);
  });

  it("every cache_control emitted has ttl exactly '1h'", () => {
    const r = assembleClaudeCacheBlocks({
      system: "S",
      tools: "T",
      task: "K",
      cacheControl: { system: true, tools: true },
    });
    const ccBlocks = r.payload.message.content.filter(b => b.cache_control !== undefined);
    expect(ccBlocks.length).toBe(2);
    for (const b of ccBlocks) {
      // Anthropic rejects cache_control without ttl='1h' once Claude
      // Code injects its own 1h-marked system blocks ahead of caller
      // content. Any drift here breaks κ live.
      expect(b.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }
  });

  it("assembleClaudeCacheBlocks default path (no cacheControl) emits zero markers", () => {
    const r = assembleClaudeCacheBlocks({ task: "K" });
    expect(r.payload.message.content.length).toBe(1);
    expect(r.payload.message.content[0].cache_control).toBeUndefined();
    expect(r.markedBlockCount).toBe(0);
  });
});

// ─── REGRESSIONS Kβ — prepareClaudeRequest κ branch end-to-end ────────
//
// Falsifiability: every test inspects the actual argv +
// stdinPayload + cacheControlBlocks that prepareClaudeRequest emits.
// Non-κ regression tests catch any accidental broadening.

describe("REGRESSIONS Kβ — prepareClaudeRequest κ branch (slice κ)", () => {
  let testHome: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    testHome = mkdtempSync(path.join(os.tmpdir(), "kappa-claude-prep-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("Kβ-1: κ argv contains -p / --input-format stream-json / --output-format stream-json / --include-partial-messages / --verbose and NO positional prompt", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      promptParts: { system: "S", task: "K", cacheControl: { system: true } },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    const args = prep.args;
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--output-format");
    // The κ branch emits --output-format stream-json exactly once.
    const outFmtValue = args[args.indexOf("--output-format") + 1];
    expect(outFmtValue).toBe("stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--verbose");
    // No positional prompt: the stable + task content lives in stdinPayload.
    expect(args).not.toContain("S");
    expect(args).not.toContain("K");
    expect(args).not.toContain("S\n\nK");
  });

  it("Kβ-2: stdinPayload is valid stream-json user message with cache_control ttl=1h on the marked block", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      promptParts: { system: "S", task: "K", cacheControl: { system: true } },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.stdinPayload).toBeDefined();
    const payload = JSON.parse(prep.stdinPayload!.trim());
    expect(payload.type).toBe("user");
    expect(payload.message.role).toBe("user");
    expect(payload.message.content[0].text).toBe("S");
    expect(payload.message.content[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(payload.message.content[1].text).toBe("K");
    expect(payload.message.content[1].cache_control).toBeUndefined();
  });

  it("Kβ-3: cacheControl set with outputFormat=text returns an actionable error (no silent format coercion)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      outputFormat: "text",
      promptParts: { system: "S", task: "K", cacheControl: { system: true } },
    } as never);
    expect("args" in prep).toBe(false);
    const r = prep as { content: Array<{ text: string }> };
    expect(r.content[0].text).toMatch(/outputFormat.*stream-json/i);
  });

  it("Kβ-4: promptParts WITHOUT cacheControl keeps the positional -p path and emits no stdinPayload (regression)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      outputFormat: "text",
      promptParts: { system: "S", task: "K" },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    // Positional path: ["-p", "S\n\nK", …]
    expect(prep.args[0]).toBe("-p");
    expect(prep.args[1]).toBe("S\n\nK");
    expect(prep.stdinPayload).toBeUndefined();
    expect(prep.cacheControlBlocks).toBeUndefined();
    expect(prep.args).not.toContain("--input-format");
  });

  it("Kβ-5: plain prompt (no promptParts) keeps positional path and no stdinPayload (regression)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      prompt: "hi",
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("-p");
    expect(prep.args[1]).toBe("hi");
    expect(prep.stdinPayload).toBeUndefined();
    expect(prep.args).not.toContain("--input-format");
  });

  it("Kβ-6: cacheControlBlocks counts only marker-on-non-empty (system marker on empty system → 0)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      promptParts: { task: "K", cacheControl: { system: true } },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.cacheControlBlocks).toBe(0);
  });

  it("Kβ-7: cacheControlBlocks equals the number of marked non-empty blocks", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      promptParts: {
        system: "S",
        tools: "T",
        task: "K",
        cacheControl: { system: true, tools: true },
      },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.cacheControlBlocks).toBe(2);
  });

  it("Kβ-8: κ argv passes validateUpstreamCliArgs AND has the exact pinned shape (contract + structural)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      promptParts: { system: "S", task: "K", cacheControl: { system: true } },
    } as never);
    if (!("args" in prep)) throw new Error("expected args");

    // Contract check — must be ok AND emit zero violations.
    const validation = validateUpstreamCliArgs("claude", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
    expect(validation.violations).toEqual([]);

    // Structural pin (Codex round-1 finding, Grok concur):
    // `validateUpstreamCliArgs` is too loose for the κ shape — `-p` has
    // `arity:"optional"`, so dropping `--verbose` (P-Kβ-1) or putting a
    // positional prompt back after `-p` (P-Kβ-2) leaves the validator
    // happy. Pin the exact prefix and required flags here so those
    // probes still go red.
    expect(prep.args[0]).toBe("-p");
    expect(prep.args[1]).toBe("--input-format");
    expect(prep.args[2]).toBe("stream-json");
    expect(prep.args).toContain("--verbose");
    expect(prep.args).toContain("--include-partial-messages");
    // The token right after `-p` must be a flag (no positional prompt
    // value snuck in between `-p` and `--input-format`).
    expect(prep.args[1].startsWith("--")).toBe(true);
  });

  it("Kβ-9: optimizePrompt=true + cacheControl returns an error (rec #5 mutual exclusion)", () => {
    const prep = prepareClaudeRequest({
      ...BASE_CLAUDE_PARAMS,
      optimizePrompt: true,
      promptParts: { system: "S", task: "K", cacheControl: { system: true } },
    } as never);
    // Must be an error response, not a CliRequestPrep.
    expect("args" in prep).toBe(false);
    const r = prep as { content: Array<{ text: string }> };
    expect(r.content[0].text).toMatch(/optimizePrompt.*incompatible|cacheControl/i);
  });
});

// ─── REGRESSIONS Kγ — UPSTREAM_CLI_CONTRACTS optional arity + fixture ─

describe("REGRESSIONS Kγ — claude contract gains optional arity + --input-format (slice κ)", () => {
  it("Kγ-1: legacy positional form ['-p','hello'] still validates (-p arity must accept value)", () => {
    const v = validateUpstreamCliArgs("claude", ["-p", "hello"]);
    expect(v.ok, JSON.stringify(v.violations)).toBe(true);
  });

  it("Kγ-2: full κ combination validates", () => {
    const v = validateUpstreamCliArgs("claude", [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    expect(v.ok, JSON.stringify(v.violations)).toBe(true);
  });

  it("Kγ-3: '-p' as the final token (zero-value) validates", () => {
    const v = validateUpstreamCliArgs("claude", ["-p"]);
    expect(v.ok, JSON.stringify(v.violations)).toBe(true);
  });

  it("Kγ-4: UPSTREAM_CLI_CONTRACTS.claude.flags['-p'].arity === 'optional'", () => {
    expect(UPSTREAM_CLI_CONTRACTS.claude.flags["-p"].arity).toBe("optional");
  });

  it("Kγ-5: --input-format is registered with arity:'one' and values:['text','stream-json']", () => {
    const flag = UPSTREAM_CLI_CONTRACTS.claude.flags["--input-format"];
    expect(flag).toBeDefined();
    expect(flag.arity).toBe("one");
    expect(flag.values).toEqual(["text", "stream-json"]);
  });

  it("Kγ-6: validateUpstreamCliArgs rejects --input-format with an unknown value", () => {
    const v = validateUpstreamCliArgs("claude", ["-p", "x", "--input-format", "yaml"]);
    expect(v.ok).toBe(false);
  });

  it("Kγ-7: claude-input-format-stream-json fixture exists and mechanically passes the contract", () => {
    const fixture = UPSTREAM_CLI_CONTRACTS.claude.conformanceFixtures.find(
      f => f.id === "claude-input-format-stream-json"
    );
    expect(fixture, "fixture must be registered").toBeDefined();
    expect(fixture!.expect).toBe("pass");
    const v = validateUpstreamCliArgs("claude", [...fixture!.args]);
    expect(v.ok, JSON.stringify(v.violations)).toBe(true);
  });
});

// ─── REGRESSIONS Kδ — executor + async-job-manager stdin wiring ───────

describe("REGRESSIONS Kδ — executor + AsyncJobManager stdin (slice κ)", () => {
  it("Kδ-1: executeCli writes stdin payload to the child and the child sees it", async () => {
    const result = await executeCli("cat", [], { stdin: "kappa-payload\n" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("kappa-payload\n");
  });

  it(
    "Kδ-2: executeCli WITHOUT stdin leaves stdio[0] as 'ignore' (regression — cat gets EOF immediately)",
    async () => {
      // Without `stdin`, stdin[0] is "ignore"; `cat` reads EOF and
      // exits 0 with empty stdout. Catches the regression where stdin
      // is always wired up to "pipe" (which would hang `cat` waiting
      // for input). Per-test 5s timeout — without it, the "always
      // pipe" mutation would hang the suite until vitest's global
      // timeout fires (Codex round-1 finding).
      const result = await executeCli("cat", []);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    },
    5000
  );

  it("Kδ-3: AsyncJobManager dedup key includes stdin (two jobs with same args, different stdin do NOT collide)", () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    // Use a long-running sleep so neither job has terminated by the
    // time we inspect their snapshots. We never await — the manager
    // never blocks on the child.
    const a = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-a", {
      stdin: "payload-A",
    });
    const b = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-b", {
      stdin: "payload-B",
    });
    expect(b.deduped).toBe(false);
    expect(b.snapshot.id).not.toBe(a.snapshot.id);
    // Same stdin: now dedup MUST trip (regression — non-stdin path is
    // unchanged).
    const c = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-c", {
      stdin: "payload-A",
    });
    expect(c.deduped).toBe(true);
    expect(c.snapshot.id).toBe(a.snapshot.id);

    // Cleanup so the test process exits cleanly.
    mgr.cancelJob(a.snapshot.id);
    mgr.cancelJob(b.snapshot.id);
  });

  it("Kδ-4: AsyncJobManager dedup still fires for identical-no-stdin requests (regression)", () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const a = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-a", {});
    const b = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-b", {});
    expect(b.deduped).toBe(true);
    expect(b.snapshot.id).toBe(a.snapshot.id);
    mgr.cancelJob(a.snapshot.id);
  });
});

// ─── REGRESSIONS Kε — FlightRecorder migration v4 + writes ────────────

describe("REGRESSIONS Kε — flight-recorder cache_control_blocks (slice κ)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "kappa-fr-"));
    dbPath = path.join(tmpDir, "logs.db");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function tableColumns(p: string): Set<string> {
    const db = new BetterSqlite3(p);
    try {
      const rows = db.prepare("PRAGMA table_info(requests)").all() as Array<{
        name: string;
      }>;
      return new Set(rows.map((r: { name: string }) => r.name));
    } finally {
      db.close();
    }
  }

  it("Kε-1: fresh FR has cache_control_blocks column", () => {
    new FlightRecorder(dbPath).close();
    expect(tableColumns(dbPath).has("cache_control_blocks")).toBe(true);
  });

  it("Kε-2: pre-κ DB (v3 schema simulated) gets cache_control_blocks added idempotently with _migrations v4 row", () => {
    // Bootstrap a v3-shaped DB (no cache_control_blocks column).
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system TEXT,
        response TEXT,
        session_id TEXT,
        duration_ms INTEGER,
        datetime_utc TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        stable_prefix_hash TEXT,
        stable_prefix_tokens INTEGER
      );
      CREATE TABLE gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0,
        circuit_breaker_state TEXT,
        cost_usd REAL,
        approval_decision TEXT,
        optimization_applied INTEGER DEFAULT 0,
        thinking_blocks TEXT,
        exit_code INTEGER,
        error_message TEXT,
        async_job_id TEXT,
        status TEXT NOT NULL DEFAULT 'started'
      );
    `);
    seed
      .prepare("INSERT INTO _migrations(version, applied_at) VALUES(3, ?)")
      .run(new Date().toISOString());
    seed.close();
    expect(tableColumns(dbPath).has("cache_control_blocks")).toBe(false);

    new FlightRecorder(dbPath).close();
    expect(tableColumns(dbPath).has("cache_control_blocks")).toBe(true);

    const db = new BetterSqlite3(dbPath);
    const v4Row = db.prepare("SELECT version FROM _migrations WHERE version = 4").get();
    db.close();
    expect(v4Row).toBeDefined();
  });

  it("Kε-3: logStart with cacheControlBlocks persists the integer", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "k3-corr-1",
      cli: "claude",
      model: "sonnet",
      prompt: "test",
      cacheControlBlocks: 3,
    });
    rec.close();
    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare("SELECT cache_control_blocks FROM requests WHERE id = ?")
      .get("k3-corr-1") as { cache_control_blocks: number | null };
    db.close();
    expect(row.cache_control_blocks).toBe(3);
  });

  it("Kε-4: logStart WITHOUT cacheControlBlocks persists NULL (regression for legacy callers)", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "k4-corr-1",
      cli: "claude",
      model: "sonnet",
      prompt: "no-kappa",
    });
    rec.close();
    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare("SELECT cache_control_blocks FROM requests WHERE id = ?")
      .get("k4-corr-1") as { cache_control_blocks: number | null };
    db.close();
    expect(row.cache_control_blocks).toBeNull();
  });

  it("Kε-5: opening the FR twice does not duplicate the v4 migration row (INSERT OR IGNORE)", () => {
    new FlightRecorder(dbPath).close();
    new FlightRecorder(dbPath).close();
    const db = new BetterSqlite3(dbPath);
    const cnt = db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE version = 4").get() as {
      n: number;
    };
    db.close();
    expect(cnt.n).toBe(1);
  });
});
