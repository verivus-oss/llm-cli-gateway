import { chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

export interface FlightLogStart {
  correlationId: string;
  cli: "claude" | "codex" | "gemini" | "grok";
  model: string;
  prompt: string;
  system?: string;
  sessionId?: string;
  asyncJobId?: string;
}

export interface FlightLogResult {
  response: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  retryCount: number;
  circuitBreakerState: string;
  costUsd?: number;
  approvalDecision?: string;
  optimizationApplied: boolean;
  thinkingBlocks?: string[];
  exitCode: number;
  errorMessage?: string;
  status: "completed" | "failed";
}

interface LoggerLike {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
}

interface StatementLike {
  run: (...args: any[]) => void;
}

interface DatabaseLike {
  pragma: (query: string) => any;
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
  transaction: <T extends (...args: any[]) => void>(fn: T) => T;
  close: () => void;
}

const MAX_THINKING_BYTES = 1_000_000;

export function resolveFlightRecorderDbPath(): string | null {
  const configured = process.env.LLM_GATEWAY_LOGS_DB;
  if (configured !== undefined) {
    const normalized = configured.trim().toLowerCase();
    if (!normalized || normalized === "none") {
      return null;
    }
    return configured.trim();
  }

  return path.join(os.homedir(), ".llm-cli-gateway", "logs.db");
}

const TRUNCATION_SUFFIX = "[TRUNCATED]";
const TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");

function truncateThinkingBlocks(blocks: string[]): string[] {
  const result: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const bytes = Buffer.byteLength(block, "utf8");
    if (used + bytes <= MAX_THINKING_BYTES) {
      result.push(block);
      used += bytes;
      continue;
    }

    // Reserve space for the suffix so total stays within budget
    const budget = Math.max(0, MAX_THINKING_BYTES - used - TRUNCATION_SUFFIX_BYTES);
    if (budget > 0) {
      // Truncate on code point boundaries by using string iteration
      let charBytes = 0;
      let safeEnd = 0;
      for (const char of block) {
        const charSize = Buffer.byteLength(char, "utf8");
        if (charBytes + charSize > budget) break;
        charBytes += charSize;
        safeEnd += char.length; // char.length handles surrogate pairs
      }
      const sliced = block.slice(0, safeEnd);
      result.push(sliced ? `${sliced}${TRUNCATION_SUFFIX}` : TRUNCATION_SUFFIX);
    } else {
      result.push(TRUNCATION_SUFFIX);
    }
    break;
  }

  return result;
}

export class FlightRecorder {
  private db: DatabaseLike;
  private insertStartTxn: (entry: FlightLogStart) => void;
  private updateCompleteTxn: (correlationId: string, result: FlightLogResult) => void;

  constructor(dbPath: string) {
    const require = createRequire(import.meta.url);
    const BetterSqlite3 = require("better-sqlite3");

    const directory = path.dirname(dbPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requests (
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
        output_tokens INTEGER
      );

      CREATE TABLE IF NOT EXISTS gateway_metadata (
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

      CREATE INDEX IF NOT EXISTS idx_requests_datetime ON requests(datetime_utc);
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
      CREATE INDEX IF NOT EXISTS idx_requests_cli ON requests(cli);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_status ON gateway_metadata(status);
    `);

    this.db
      .prepare("INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());

    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    const insertRequest = this.db.prepare(`
      INSERT INTO requests (id, cli, model, prompt, system, session_id, datetime_utc)
      VALUES (@id, @cli, @model, @prompt, @system, @session_id, @datetime_utc)
    `);

    const insertMetadata = this.db.prepare(`
      INSERT INTO gateway_metadata (request_id, async_job_id, status)
      VALUES (@request_id, @async_job_id, 'started')
    `);

    this.insertStartTxn = this.db.transaction((entry: FlightLogStart) => {
      insertRequest.run({
        id: entry.correlationId,
        cli: entry.cli,
        model: entry.model,
        prompt: entry.prompt,
        system: entry.system || null,
        session_id: entry.sessionId || null,
        datetime_utc: new Date().toISOString(),
      });

      insertMetadata.run({
        request_id: entry.correlationId,
        async_job_id: entry.asyncJobId || null,
      });
    });

    const updateRequests = this.db.prepare(`
      UPDATE requests
      SET response = @response,
          duration_ms = @duration_ms,
          input_tokens = @input_tokens,
          output_tokens = @output_tokens
      WHERE id = @id
    `);

    const updateMetadata = this.db.prepare(`
      UPDATE gateway_metadata
      SET retry_count = @retry_count,
          circuit_breaker_state = @circuit_breaker_state,
          cost_usd = @cost_usd,
          approval_decision = @approval_decision,
          optimization_applied = @optimization_applied,
          thinking_blocks = @thinking_blocks,
          exit_code = @exit_code,
          error_message = @error_message,
          status = @status
      WHERE request_id = @id AND status = 'started'
    `);

    this.updateCompleteTxn = this.db.transaction(
      (correlationId: string, result: FlightLogResult) => {
        const thinkingBlocks =
          result.thinkingBlocks && result.thinkingBlocks.length > 0
            ? JSON.stringify(truncateThinkingBlocks(result.thinkingBlocks))
            : null;

        updateRequests.run({
          id: correlationId,
          response: result.response,
          duration_ms: result.durationMs,
          input_tokens: result.inputTokens ?? null,
          output_tokens: result.outputTokens ?? null,
        });

        updateMetadata.run({
          id: correlationId,
          retry_count: result.retryCount,
          circuit_breaker_state: result.circuitBreakerState,
          cost_usd: result.costUsd ?? null,
          approval_decision: result.approvalDecision ?? null,
          optimization_applied: result.optimizationApplied ? 1 : 0,
          thinking_blocks: thinkingBlocks,
          exit_code: result.exitCode,
          error_message: result.errorMessage ?? null,
          status: result.status,
        });
      }
    );
  }

  logStart(entry: FlightLogStart): void {
    this.insertStartTxn(entry);
  }

  logComplete(correlationId: string, result: FlightLogResult): void {
    this.updateCompleteTxn(correlationId, result);
  }

  flush(): void {
    // No-op: better-sqlite3 writes synchronously.
  }

  close(): void {
    this.db.close();
  }
}

export class NoopFlightRecorder {
  logStart(_entry: FlightLogStart): void {}
  logComplete(_correlationId: string, _result: FlightLogResult): void {}
  flush(): void {}
  close(): void {}
}

export type FlightRecorderLike = FlightRecorder | NoopFlightRecorder;

export function createFlightRecorder(logger: LoggerLike): FlightRecorderLike {
  const dbPath = resolveFlightRecorderDbPath();
  if (!dbPath) {
    logger.info("Flight recorder disabled (LLM_GATEWAY_LOGS_DB=none)");
    return new NoopFlightRecorder();
  }

  try {
    const recorder = new FlightRecorder(dbPath);
    logger.info(`Flight recorder enabled at ${dbPath}`);
    return recorder;
  } catch (error) {
    logger.error("Flight recorder unavailable; continuing without SQLite logging", error);
    return new NoopFlightRecorder();
  }
}
