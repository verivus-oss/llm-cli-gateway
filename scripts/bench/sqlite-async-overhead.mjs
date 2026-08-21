#!/usr/bin/env node
/**
 * b1: does wrapping the synchronous SQLite engine in promises cost anything
 * that matters at the flight recorder's real call rate?
 *
 * Method, thresholds and results:
 *   docs/evidence/storage-b1-benchmark-2026-08-21.md (host-local, gitignored).
 * Design question:
 *   docs/plans/storage-unification.md sections 3.1 and 9.
 *
 * SCOPE. This measures storage transaction latency: getting two statements
 * into a committed SQLite transaction. It excludes redaction, prompt-signal
 * derivation and owner resolution, which logStart / logComplete perform around
 * the transaction. Those costs are identical under every driver, so including
 * them would only dilute the quantity under test. Stated because a measurement
 * that does not say which side of that line it sits on cannot be checked.
 *
 * Four variants over identical data and an identical payload sequence:
 *   A0   production sync   the recorder's four cached `@name` statements inside
 *                          withTransaction (deferred BEGIN via db.exec), as
 *                          src/flight-recorder.ts:608-716 runs them today.
 *   A1   mechanical twin   a line-by-line SYNCHRONOUS transcription of
 *                          SqliteStorageDriver.transaction: role resolution, a
 *                          fresh connection facade per call, transaction
 *                          control issued through `execute` (so BEGIN
 *                          IMMEDIATE, COMMIT and ROLLBACK are each prepared),
 *                          positional binds, identical SQL. It differs from
 *                          Bnq only by having no promises.
 *   Bnq  async, no queue   the real driver's withConnection("write", ...) with
 *                          the same explicit transaction body, so the
 *                          serialising queue is the only absent thing.
 *   B    the async driver  the real driver's transaction("write", ...).
 *
 * Therefore:
 *   Bnq - A1  = promises and microtask turns alone
 *   B   - Bnq = the serialising queue at storage/drivers/sqlite.ts:82
 *   A1  - A0  = the driver's non-async choices (no statement cache, immediate
 *               transactions, transaction control through prepare)
 *   B   - A0  = the total delta s7 would actually pay
 *
 * Requires a build: it imports compiled dist, so it measures shipped code.
 *
 * Usage:
 *   npm run build
 *   node scripts/bench/sqlite-async-overhead.mjs <snapshot.db> --json out.json
 *
 * The argument is a read-only pristine source; each run happens on a working
 * copy beside it. Paths under ~/.llm-cli-gateway/ are refused, symlinks
 * resolved first, because the live database is not a fixture.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { clearInterval, setInterval, setTimeout as setTimer } from "node:timers";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

// ---------------------------------------------------------------- guards ---

/**
 * Resolve symlinks before comparing, so a link planted outside the forbidden
 * directory cannot smuggle the live database past a lexical check. A path that
 * does not exist yet resolves through its nearest existing ancestor.
 */
function trueLocation(candidate) {
  let current = resolve(candidate);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(candidate);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function assertNotLiveState(candidate) {
  const target = trueLocation(candidate);
  const forbidden = trueLocation(join(homedir(), ".llm-cli-gateway"));
  if (target === forbidden || target.startsWith(forbidden + sep)) {
    throw new Error(
      `refusing to run against live gateway state: ${target} is under ${forbidden}. ` +
        `Copy a snapshot elsewhere and point the benchmark at the copy.`
    );
  }
  return target;
}

// ------------------------------------------------------------------ args ---

function parseRates(spec) {
  return String(spec)
    .split(",")
    .map(entry => {
      const [label, rate, durationMs] = entry.split(":");
      if (!label || !rate || !durationMs) throw new Error(`bad --rates entry: ${entry}`);
      return { label, rate: Number(rate), durationMs: Number(durationMs) };
    });
}

function parseArgs(argv) {
  const options = {
    db: null,
    json: null,
    repeats: 3,
    warmupFraction: 0.1,
    concurrency: 8,
    drainOps: 200,
    injectAsyncDelayMs: 0,
    injectAsyncBlockMs: 0,
    synchronous: "FULL",
    seed: 20260821,
    bootstrapIterations: 2000,
    replayWindow: "2026-07-13T08",
    replaySpeeds: [70, 700],
    cellN: null,
    cells: [
      { label: "small", n: 2000, promptBytes: 7, responseBytes: 8 },
      { label: "large", n: 400, promptBytes: 8648, responseBytes: 282955 },
      { label: "mix", n: 1500, promptBytes: null, responseBytes: null },
    ],
    rates: [
      { label: "busiest-hour", rate: 0.343, durationMs: 60000 },
      { label: "busiest-minute", rate: 3.15, durationMs: 60000 },
      { label: "peak-burst", rate: 24, durationMs: 45000 },
      { label: "stress-10x", rate: 240, durationMs: 15000 },
    ],
    only: null,
    scenarios: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = argv[++i];
    else if (arg === "--repeats") options.repeats = Number(argv[++i]);
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg === "--drain-ops") options.drainOps = Number(argv[++i]);
    else if (arg === "--inject-async-delay-ms") options.injectAsyncDelayMs = Number(argv[++i]);
    else if (arg === "--inject-async-block-ms") options.injectAsyncBlockMs = Number(argv[++i]);
    else if (arg === "--only") options.only = String(argv[++i]).split(",");
    else if (arg === "--scenarios") options.scenarios = String(argv[++i]).split(",");
    else if (arg === "--rates") options.rates = parseRates(argv[++i]);
    else if (arg === "--replay-speeds") options.replaySpeeds = argv[++i].split(",").map(Number);
    else if (arg === "--replay-window") options.replayWindow = String(argv[++i]);
    else if (arg === "--seed") options.seed = Number(argv[++i]);
    else if (arg === "--synchronous") options.synchronous = String(argv[++i]).toUpperCase();
    else if (arg === "--cell-n") options.cellN = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (rest.length !== 1) {
    throw new Error("usage: sqlite-async-overhead.mjs <snapshot.db> [--json out.json]");
  }
  options.db = rest[0];
  if (options.cellN) for (const cell of options.cells) cell.n = options.cellN;
  return options;
}

// ----------------------------------------------------------- statistics ---

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarise(samples) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    mean: round(mean),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]),
  };
}

function round(value) {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : Math.round(value * 1000) / 1000;
}

function spread(values) {
  const clean = values.filter(v => typeof v === "number");
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    min: round(sorted[0]),
    median: round(sorted[Math.floor((sorted.length - 1) / 2)]),
    max: round(sorted[sorted.length - 1]),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two-sample percentile bootstrap for the difference of a quantile.
 *
 * "No criterion fired" is not equivalence: an underpowered or noisy run makes
 * every criterion less likely to fire and would then be reported as a pass. An
 * upper confidence bound on the difference is the statement that can actually
 * support "the overhead does not matter".
 */
function bootstrapQuantileDifference(baseline, candidate, quantile, iterations, seed) {
  if (baseline.length < 50 || candidate.length < 50) return null;
  const random = mulberry32(seed);
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const a = [];
    const b = [];
    for (let i = 0; i < baseline.length; i++) a.push(baseline[(random() * baseline.length) | 0]);
    for (let i = 0; i < candidate.length; i++) b.push(candidate[(random() * candidate.length) | 0]);
    a.sort((x, y) => x - y);
    b.sort((x, y) => x - y);
    draws.push(percentile(b, quantile) - percentile(a, quantile));
  }
  draws.sort((x, y) => x - y);
  const sortedBaseline = [...baseline].sort((x, y) => x - y);
  const sortedCandidate = [...candidate].sort((x, y) => x - y);
  const lower = percentile(draws, 0.025);
  const upper = percentile(draws, 0.975);
  return {
    point: round(percentile(sortedCandidate, quantile) - percentile(sortedBaseline, quantile)),
    lower95: round(lower),
    upper95: round(upper),
    detectable: lower > 0 || upper < 0,
  };
}

// --------------------------------------------------------------- payload ---

const FILLER = (() => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,\n";
  const random = mulberry32(0x5eed);
  let block = "";
  for (let i = 0; i < 65536; i++) block += alphabet[Math.floor(random() * alphabet.length)];
  return block;
})();

/** ASCII filler, so one character is one UTF-8 byte and lengths ARE bytes. */
function textOfLength(length) {
  if (length <= 0) return "";
  if (length <= FILLER.length) return FILLER.slice(0, length);
  return FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);
}

/**
 * Payload sizes are measured in UTF-8 bytes (length(CAST(x AS BLOB))), not
 * characters, and drawn from the snapshot's own joint distribution so the
 * prompt/response correlation survives.
 */
function samplePayloadSizes(openReadOnly, dbPath) {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT length(CAST(prompt AS BLOB)) AS p,
                length(CAST(COALESCE(response, '') AS BLOB)) AS r
         FROM requests ORDER BY rowid`
      )
      .all();
    // Every row, not every Nth: systematic rowid sampling can bias provider and
    // time clusters, and retaining all 34,373 pairs costs nothing.
    return rows.map(row => [row.p, row.r]);
  } finally {
    db.close();
  }
}

/**
 * The real two-phase trace: when each request started, and how long until its
 * completion transaction arrived. `datetime_utc` is stamped at logStart
 * (src/flight-recorder.ts:641) and NOTHING records a completion timestamp, so
 * `duration_ms` is the only way to reconstruct the second transaction's
 * arrival. Rows without it cannot contribute a completion and are dropped.
 */
function loadReplayTrace(openReadOnly, dbPath, windowPrefix) {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT datetime_utc AS t, duration_ms AS d,
                length(CAST(prompt AS BLOB)) AS p,
                length(CAST(COALESCE(response, '') AS BLOB)) AS r
         FROM requests
         WHERE datetime_utc >= ? AND datetime_utc < ?
         ORDER BY datetime_utc, rowid`
      )
      .all(windowPrefix, `${windowPrefix}~`);
    if (rows.length === 0) return [];
    const origin = Date.parse(rows[0].t);
    // Every start is replayed. Dropping rows without duration_ms would remove
    // their perfectly valid start transactions from the arrival stream and
    // quietly change the load. A completion is added only where the duration
    // is finite and not negative.
    // Payload strings are materialised HERE, not inside the replayed
    // transaction, for the same reason buildPayloadPlan does it: an allocation
    // inside the measured window is charged to storage.
    const cache = new Map();
    const text = length => {
      if (!cache.has(length)) cache.set(length, textOfLength(length));
      return cache.get(length);
    };
    return rows.map(row => {
      const startOffsetMs = Date.parse(row.t) - origin;
      const usable = typeof row.d === "number" && Number.isFinite(row.d) && row.d >= 0;
      return {
        startOffsetMs,
        completeOffsetMs: usable ? startOffsetMs + row.d : null,
        promptLength: row.p,
        responseLength: row.r,
        prompt: text(row.p),
        response: text(row.r),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Payload STRINGS are materialised here, before any timing starts. An earlier
 * version stored lengths and called textOfLength inside the transaction, so
 * every measured write also allocated its own payload: for the large cell that
 * is a 283 KB allocation and its garbage collection inside the window, which
 * lands on capacity and queue service rather than on storage. Production hands
 * the recorder strings that already exist.
 */
function buildPayloadPlan(sizes, cell, count, seed) {
  const random = mulberry32(seed);
  const plan = [];
  const cache = new Map();
  const text = length => {
    if (!cache.has(length)) cache.set(length, textOfLength(length));
    return cache.get(length);
  };
  for (let i = 0; i < count; i++) {
    const pick =
      cell.promptBytes !== null
        ? [cell.promptBytes, cell.responseBytes]
        : sizes[Math.floor(random() * sizes.length)];
    plan.push({
      promptLength: pick[0],
      responseLength: pick[1],
      prompt: text(pick[0]),
      response: text(pick[1]),
    });
  }
  return plan;
}

// ------------------------------------------------------------ work files ---

function restoreWorkingCopy(source, work) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${work}${suffix}`, { force: true });
  copyFileSync(source, work);
  warmPageCache(work);
}

/**
 * Read the whole working copy once so every variant starts with the same page
 * cache. Without this the variant that happens to run first pays the cold-cache
 * cost of the first WAL checkpoints against a 1.21 GB file, and a smoke run
 * showed that artefact moving p50 by 2.6 ms, which is 150 times the quantity
 * under test. Discarding early iterations does not fix it; the checkpoints
 * arrive later than any plausible warm-up window.
 */
function warmPageCache(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * WAL is a property of the file; foreign_keys and synchronous are properties
 * of the connection. The recorder sets journal_mode and foreign_keys
 * (src/flight-recorder.ts:452-453) and the async driver sets neither, so all
 * three are established identically for every variant. Otherwise the
 * comparison would be about pragmas one path happens to issue.
 */
function establishWal(openDatabase, work) {
  const db = openDatabase(work);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const mode = db.prepare("PRAGMA journal_mode").get();
    if (String(mode.journal_mode).toLowerCase() !== "wal") {
      throw new Error(`expected WAL, got ${mode.journal_mode}`);
    }
  } finally {
    db.close();
  }
}

function effectivePragmas(openReadOnly, work) {
  const db = openReadOnly(work);
  try {
    const read = name => {
      const row = db.prepare(`PRAGMA ${name}`).get();
      return row ? Object.values(row)[0] : null;
    };
    return {
      journal_mode: read("journal_mode"),
      // Read back rather than assumed: without this the OFF lens is asserted
      // by the command line and never confirmed in the record.
      synchronous: read("synchronous"),
      wal_autocheckpoint: read("wal_autocheckpoint"),
      busy_timeout: read("busy_timeout"),
      page_size: read("page_size"),
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ SQL ---

/** Columns the recorder writes at src/flight-recorder.ts:608-618. */
const REQUEST_INSERT_COLUMNS = [
  "id",
  "cli",
  "model",
  "prompt",
  "system",
  "session_id",
  "datetime_utc",
  "stable_prefix_hash",
  "stable_prefix_tokens",
  "cache_control_blocks",
  "cache_control_ttl_seconds",
  "owner_principal",
  "derived_prompt_chars",
  "derived_content_class",
  "derivation_version",
];

/** Snapshots predate later migrations, so intersect with what the file has. */
function resolveColumns(openReadOnly, dbPath) {
  const db = openReadOnly(dbPath);
  try {
    const present = new Set(
      db
        .prepare("PRAGMA table_info(requests)")
        .all()
        .map(row => row.name)
    );
    return REQUEST_INSERT_COLUMNS.filter(name => present.has(name));
  } finally {
    db.close();
  }
}

const UPDATE_REQUEST_COLUMNS = [
  "response",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_basis",
];

const UPDATE_META_COLUMNS = [
  "retry_count",
  "circuit_breaker_state",
  "cost_usd",
  "approval_decision",
  "optimization_applied",
  "thinking_blocks",
  "exit_code",
  "http_status",
  "error_message",
  "provider_session_id",
  "stop_reason",
  "status",
];

function startRowValues(columns, id, payload) {
  const row = {
    id,
    cli: "bench",
    model: "bench-model",
    prompt: payload.prompt,
    system: null,
    session_id: `gw-bench-${id.slice(0, 8)}`,
    datetime_utc: new Date().toISOString(),
    stable_prefix_hash: null,
    stable_prefix_tokens: null,
    cache_control_blocks: null,
    cache_control_ttl_seconds: null,
    owner_principal: "bench",
    derived_prompt_chars: payload.promptLength,
    derived_content_class: "bench",
    derivation_version: 1,
  };
  return columns.map(name => row[name]);
}

function completeRequestValues(payload) {
  return [payload.response, 1234, 100, 200, 0, 0, "measured"];
}

function completeMetaValues() {
  return [0, "CLOSED", 0.0001, null, 0, null, 0, null, null, null, "end_turn", "completed"];
}

function sqlFor(columns) {
  return {
    named: {
      insertRequest: `INSERT INTO requests (${columns.join(", ")}) VALUES (${columns
        .map(c => `@${c}`)
        .join(", ")})`,
      insertMeta: `INSERT INTO gateway_metadata (request_id, async_job_id, status)
                   VALUES (@request_id, @async_job_id, 'started')`,
      updateRequest: `UPDATE requests SET ${UPDATE_REQUEST_COLUMNS.map(c => `${c} = @${c}`).join(
        ", "
      )} WHERE id = @id`,
      updateMeta: `UPDATE gateway_metadata SET ${UPDATE_META_COLUMNS.map(c => `${c} = @${c}`).join(
        ", "
      )} WHERE request_id = @id AND status = 'started'`,
    },
    positional: {
      insertRequest: `INSERT INTO requests (${columns.join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
      insertMeta: `INSERT INTO gateway_metadata (request_id, async_job_id, status) VALUES (?, ?, 'started')`,
      updateRequest: `UPDATE requests SET ${UPDATE_REQUEST_COLUMNS.map(c => `${c} = ?`).join(
        ", "
      )} WHERE id = ?`,
      updateMeta: `UPDATE gateway_metadata SET ${UPDATE_META_COLUMNS.map(c => `${c} = ?`).join(
        ", "
      )} WHERE request_id = ? AND status = 'started'`,
    },
  };
}

// -------------------------------------------------------------- scenarios ---

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

let idCounter = 0;
/** Set per scenario so committed rows can be counted back by tag (G6). */
let scenarioToken = "x";
function setScenarioToken(token) {
  scenarioToken = token;
}
function newId(tag) {
  idCounter += 1;
  return `bench-${tag}-${scenarioToken}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// -------------------------------------------------------------- variants ---

function namedObject(columns, values) {
  const object = {};
  columns.forEach((name, index) => {
    object[name] = values[index];
  });
  return object;
}

function buildA0(modules, work, columns, sql, injection, synchronous) {
  const db = modules.openDatabase(work);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  const insertRequest = db.prepare(sql.named.insertRequest);
  const insertMeta = db.prepare(sql.named.insertMeta);
  const updateRequest = db.prepare(sql.named.updateRequest);
  const updateMeta = db.prepare(sql.named.updateMeta);
  const startTxn = db.withTransaction((id, payload) => {
    insertRequest.run(namedObject(columns, startRowValues(columns, id, payload)));
    insertMeta.run({ request_id: id, async_job_id: null });
  });
  const completeTxn = db.withTransaction((id, payload) => {
    updateRequest.run({
      id,
      ...namedObject(UPDATE_REQUEST_COLUMNS, completeRequestValues(payload)),
    });
    updateMeta.run({ id, ...namedObject(UPDATE_META_COLUMNS, completeMetaValues()) });
  });
  return {
    id: "A0",
    async: false,
    start: (id, payload) => startTxn(id, payload),
    complete: (id, payload) => completeTxn(id, payload),
    close: () => db.close(),
  };
}

/**
 * A1 transcribes SqliteStorageDriver into synchronous code: the closed check,
 * resolveStorageRole, a fresh { query, execute } facade per call, transaction
 * control issued through that facade (so BEGIN IMMEDIATE, COMMIT and ROLLBACK
 * are each prepared, exactly as storage/drivers/sqlite.ts:36 does), and the
 * { rowsAffected } result object. The ONLY difference from Bnq is that nothing
 * here returns a promise.
 */
function buildA1(modules, work, columns, sql, injection, synchronous) {
  const db = modules.openDatabase(work);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  const roles = new Set(["app"]);
  const readOnlyOperations = new Set(["transcript_read", "analytics_read"]);
  let closed = false;

  const connectionOver = handle => ({
    query: (statement, params = []) => handle.prepare(statement).all(...params),
    execute: (statement, params = []) => ({
      rowsAffected: handle.prepare(statement).run(...params).changes,
    }),
  });
  // Only the write path is transcribed. No scenario exercises a read class, and
  // an unexercised branch here would later be mistaken for a tested one.
  const connectionFor = operation => {
    if (closed) throw new Error("storage: sqlite driver is closed");
    modules.resolveStorageRole(operation, roles);
    // The set lookup production pays at storage/drivers/sqlite.ts:61, kept so
    // it is not silently absent from the twin.
    if (!readOnlyOperations.has(operation)) return connectionOver(db);
    throw new Error("read class not exercised by any scenario");
  };
  const transaction = (operation, body) => {
    // The upfront read-class rejection production performs at
    // storage/drivers/sqlite.ts:88 before touching a connection.
    if (readOnlyOperations.has(operation)) {
      throw new Error(`storage: ${operation} is a read class and cannot open a transaction`);
    }
    const connection = connectionFor(operation);
    connection.execute("BEGIN IMMEDIATE");
    try {
      const result = body(connection);
      connection.execute("COMMIT");
      return result;
    } catch (error) {
      connection.execute("ROLLBACK");
      throw error;
    }
  };

  return {
    id: "A1",
    async: false,
    start: (id, payload) =>
      transaction("write", connection => {
        connection.execute(sql.positional.insertRequest, startRowValues(columns, id, payload));
        connection.execute(sql.positional.insertMeta, [id, null]);
      }),
    complete: (id, payload) =>
      transaction("write", connection => {
        connection.execute(sql.positional.updateRequest, [...completeRequestValues(payload), id]);
        connection.execute(sql.positional.updateMeta, [...completeMetaValues(), id]);
      }),
    close: () => {
      closed = true;
      db.close();
    },
  };
}

function asyncVariant(modules, work, columns, sql, injection, synchronous, useQueue) {
  const driver = new modules.SqliteStorageDriver(work);
  const ready = driver.withConnection("write", async connection => {
    await connection.execute("PRAGMA journal_mode = WAL");
    await connection.execute("PRAGMA foreign_keys = ON");
    await connection.execute(`PRAGMA synchronous = ${synchronous}`);
  });
  /**
   * Two injection modes, because one cannot test both instruments. A macrotask
   * sleep YIELDS the event loop, so it must appear in latency and must NOT
   * appear in the event-loop-delay histogram. A busy spin blocks, so it must
   * appear in BOTH. Crediting one probe for both instruments would leave the
   * histogram unexercised while appearing to have been verified.
   */
  const delay = ms => new Promise(done => setTimer(done, ms));
  const spin = ms => {
    const until = nowMs() + ms;
    while (nowMs() < until) {
      /* deliberately blocking */
    }
  };
  /**
   * Admission to body start. It is NOT pure queue delay: the driver runs
   * `connectionFor` and `BEGIN IMMEDIATE` between the queue handing off and
   * this callback (storage/drivers/sqlite.ts:93-97), so both are inside this
   * interval. Named for what it measures rather than for what would be
   * convenient.
   */
  const admissionToBody = [];

  /**
   * The no-queue arm reproduces transaction()'s body through withConnection,
   * so the serialising chain at storage/drivers/sqlite.ts:110 is the only
   * thing that differs between Bnq and B.
   */
  const runNoQueue = (operation, body) =>
    driver.withConnection(operation, async connection => {
      await connection.execute("BEGIN IMMEDIATE");
      try {
        const result = await body(connection);
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        await connection.execute("ROLLBACK");
        throw error;
      }
    });

  /**
   * Instrumentation is OFF unless a scenario asks for it. An earlier version
   * wrapped every async operation in a closure that took two hrtime readings,
   * pushed to an array and evaluated two injection branches, while A0 and A1
   * paid none of that. The quantity under test is tens of microseconds, so
   * instrumenting only the candidate arm was measuring the instrument.
   */
  const injecting = injection.delayMs > 0 || injection.blockMs > 0;
  let instrumenting = false;
  const run = (operation, body) => {
    const submit = useQueue ? driver.transaction.bind(driver) : runNoQueue;
    if (!instrumenting && !injecting) return submit(operation, body);
    const admitted = nowMs();
    return submit(operation, async connection => {
      if (instrumenting) admissionToBody.push(nowMs() - admitted);
      if (injection.delayMs > 0) await delay(injection.delayMs);
      if (injection.blockMs > 0) spin(injection.blockMs);
      return body(connection);
    });
  };

  return {
    id: useQueue ? "B" : "Bnq",
    async: true,
    ready,
    admissionToBody,
    setInstrumenting: on => {
      instrumenting = on;
    },
    start: (id, payload) =>
      run("write", async connection => {
        await connection.execute(
          sql.positional.insertRequest,
          startRowValues(columns, id, payload)
        );
        await connection.execute(sql.positional.insertMeta, [id, null]);
      }),
    complete: (id, payload) =>
      run("write", async connection => {
        await connection.execute(sql.positional.updateRequest, [
          ...completeRequestValues(payload),
          id,
        ]);
        await connection.execute(sql.positional.updateMeta, [...completeMetaValues(), id]);
      }),
    closeWithoutDraining: () => driver.close(),
    close: () => driver.close(),
  };
}

const VARIANT_BUILDERS = {
  A0: buildA0,
  A1: buildA1,
  Bnq: (m, w, c, s, i, y) => asyncVariant(m, w, c, s, i, y, false),
  B: (m, w, c, s, i, y) => asyncVariant(m, w, c, s, i, y, true),
};

// --------------------------------------------------------------- probes ---

/**
 * Does this variant ever hand the loop back to a timer? A synchronous variant
 * cannot. An async one that only awaits already-settled promises cannot
 * either, because microtasks do not yield to the timer queue. Reported as the
 * observed firing gaps of a 50 ms interval running alongside the closed loop,
 * which is a closed-loop timer-fairness probe, NOT an event-loop-delay figure.
 */
function startTimerFairnessProbe(intervalMs) {
  const gaps = [];
  let previous = nowMs();
  const timer = setInterval(() => {
    const current = nowMs();
    gaps.push(current - previous);
    previous = current;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return { intervalMs, fired: gaps.length, gapMs: summarise(gaps) };
    },
  };
}

/**
 * The concurrent reader and the WAL sampler both live in a SEPARATE PROCESS.
 * Sampling the WAL from the measured event loop would perturb the measurement
 * it accompanies, and would miss samples exactly when synchronous work blocks
 * the sampler.
 */
function startReaderAndWalSampler(work) {
  const script = `
    import { openReadOnly } from ${JSON.stringify(
      pathToFileURL(join(ROOT, "dist/sqlite-driver.js")).href
    )};
    import { statSync } from "node:fs";
    const path = ${JSON.stringify(work)};
    const db = openReadOnly(path);
    let reads = 0, errors = 0, busy = 0, walMax = 0, walFinal = 0, samples = 0;
    const stop = () => {
      console.log(JSON.stringify({ reads, errors, busy, walMaxBytes: walMax,
        walFinalBytes: walFinal, walSamples: samples }));
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    setInterval(() => {
      try {
        walFinal = statSync(path + "-wal").size;
        walMax = Math.max(walMax, walFinal);
        samples++;
      } catch { /* no wal yet */ }
    }, 100);
    const loop = () => {
      try {
        db.prepare("SELECT id FROM requests ORDER BY rowid DESC LIMIT 1").all();
        db.prepare("SELECT count(*) c FROM gateway_metadata WHERE status = 'started'").all();
        reads += 2;
      } catch (error) {
        errors++;
        if (String(error && error.message).toUpperCase().includes("BUSY")) busy++;
      }
      setTimeout(loop, 5);
    };
    loop();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", chunk => {
    out += chunk;
  });
  child.stderr.on("data", chunk => {
    err += chunk;
  });
  return {
    stop: () =>
      new Promise(done => {
        child.on("exit", () => {
          try {
            done(JSON.parse(out.trim().split("\n").pop()));
          } catch {
            done({ raw: out.trim(), stderr: err.trim().slice(0, 300) });
          }
        });
        child.kill("SIGTERM");
      }),
  };
}

// ------------------------------------------------------------- scenarios ---

async function runClosedLoop(variant, plan, warmup) {
  const startLatency = [];
  const completeLatency = [];
  const endToEnd = [];
  const probe = startTimerFairnessProbe(50);
  const begin = nowMs();
  for (let i = 0; i < plan.length; i++) {
    const id = newId(variant.id);
    const payload = plan[i];
    const measured = i >= warmup;
    const t0 = nowMs();
    if (variant.async) await variant.start(id, payload);
    else variant.start(id, payload);
    const t1 = nowMs();
    if (variant.async) await variant.complete(id, payload);
    else variant.complete(id, payload);
    const t2 = nowMs();
    if (measured) {
      startLatency.push(t1 - t0);
      completeLatency.push(t2 - t1);
      endToEnd.push(t2 - t0);
    }
  }
  const elapsedMs = nowMs() - begin;
  return {
    start: summarise(startLatency),
    complete: summarise(completeLatency),
    endToEnd: summarise(endToEnd),
    samples: { endToEnd },
    timerFairness: probe.stop(),
    elapsedMs: round(elapsedMs),
    throughputPerSec: round((plan.length / elapsedMs) * 1000),
  };
}

/**
 * Open loop. Arrivals are paced by a macrotask timer, never a busy-wait, and
 * are dispatched independently of whether the previous one finished. Latency
 * is recorded from the SCHEDULED arrival, because measuring from the moment a
 * delayed callback finally ran is the coordinated omission that hides exactly
 * the event-loop blocking under test. Service latency from admission is
 * reported alongside so the two can be compared.
 */
async function runOpenLoop(variant, plan, rate, durationMs) {
  const periodMs = 1000 / rate;
  const total = Math.max(1, Math.floor((durationMs / 1000) * rate));
  const serviceLatency = [];
  const responseLatency = [];
  const dispatchLag = [];
  const inFlight = [];
  let failures = 0;
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const beforeUtilisation = performance.eventLoopUtilization();
  histogram.enable();
  const origin = nowMs();

  const dispatch = index => {
    const scheduled = origin + index * periodMs;
    const admitted = nowMs();
    dispatchLag.push(admitted - scheduled);
    const id = newId(variant.id);
    const payload = plan[index % plan.length];
    if (!variant.async) {
      variant.start(id, payload);
      variant.complete(id, payload);
      const done = nowMs();
      serviceLatency.push(done - admitted);
      responseLatency.push(done - scheduled);
      return;
    }
    inFlight.push(
      variant
        .start(id, payload)
        .then(() => variant.complete(id, payload))
        .then(() => {
          const done = nowMs();
          serviceLatency.push(done - admitted);
          responseLatency.push(done - scheduled);
        })
        .catch(() => {
          failures += 1;
        })
    );
  };

  await new Promise(done => {
    let index = 0;
    const tick = () => {
      const elapsed = nowMs() - origin;
      while (index < total && index * periodMs <= elapsed) {
        dispatch(index);
        index++;
      }
      if (index >= total) {
        done();
        return;
      }
      setTimer(tick, Math.max(0, origin + index * periodMs - nowMs()));
    };
    tick();
  });

  const tailStart = nowMs();
  if (inFlight.length > 0) await Promise.all(inFlight);
  const tailDrainMs = nowMs() - tailStart;
  histogram.disable();
  const utilisation = performance.eventLoopUtilization(beforeUtilisation);

  return {
    rate,
    dispatched: total,
    failures,
    serviceLatency: summarise(serviceLatency),
    responseLatency: summarise(responseLatency),
    dispatchLag: summarise(dispatchLag),
    samples: { responseLatency },
    tailDrainMs: round(tailDrainMs),
    eventLoopDelayMs: {
      mean: round(histogram.mean / 1e6),
      p50: round(histogram.percentile(50) / 1e6),
      p99: round(histogram.percentile(99) / 1e6),
      max: round(histogram.max / 1e6),
    },
    eventLoopUtilisation: round(utilisation.utilization),
  };
}

/**
 * Replay of the real trace: real start times AND real start-to-complete gaps,
 * so completion transactions arrive late and overlap later starts. The
 * constant-rate open loop pairs a start with an immediate completion, which is
 * not the shape the recorder sees and is not what exercises the queue.
 */
async function runReplay(variant, trace, speed, capMs) {
  const startService = [];
  const completeService = [];
  const startSojourn = [];
  const completeSojourn = [];
  const inFlight = [];
  let starts = 0;
  let completes = 0;
  let failures = 0;
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const beforeUtilisation = performance.eventLoopUtilization();
  histogram.enable();
  const events = [];
  for (const row of trace) {
    events.push({ at: row.startOffsetMs / speed, kind: "start", row });
    if (row.completeOffsetMs !== null) {
      events.push({ at: row.completeOffsetMs / speed, kind: "complete", row });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const capped = events.filter(event => event.at <= capMs);
  const ids = new Map();
  const origin = nowMs();

  const fire = event => {
    const scheduled = origin + event.at;
    if (event.kind === "start") {
      const id = newId(variant.id);
      ids.set(event.row, id);
      starts += 1;
      const t0 = nowMs();
      startSojourn.push(t0 - scheduled);
      if (!variant.async) {
        variant.start(id, event.row);
        startService.push(nowMs() - t0);
        return;
      }
      inFlight.push(
        variant
          .start(id, event.row)
          .then(() => startService.push(nowMs() - t0))
          .catch(() => {
            failures += 1;
          })
      );
      return;
    }
    const id = ids.get(event.row);
    if (!id) return;
    completes += 1;
    const t0 = nowMs();
    const sojournStart = scheduled;
    if (!variant.async) {
      variant.complete(id, event.row);
      completeService.push(nowMs() - t0);
      completeSojourn.push(nowMs() - sojournStart);
      return;
    }
    inFlight.push(
      variant
        .complete(id, event.row)
        .then(() => {
          completeService.push(nowMs() - t0);
          completeSojourn.push(nowMs() - sojournStart);
        })
        .catch(() => {
          failures += 1;
        })
    );
  };

  await new Promise(done => {
    let index = 0;
    const tick = () => {
      const elapsed = nowMs() - origin;
      while (index < capped.length && capped[index].at <= elapsed) {
        fire(capped[index]);
        index++;
      }
      if (index >= capped.length) {
        done();
        return;
      }
      setTimer(tick, Math.max(0, origin + capped[index].at - nowMs()));
    };
    tick();
  });
  if (inFlight.length > 0) await Promise.all(inFlight);
  const wallMs = nowMs() - origin;
  histogram.disable();
  const utilisation = performance.eventLoopUtilization(beforeUtilisation);

  return {
    speed,
    traceEvents: capped.length,
    starts,
    completes,
    failures,
    wallMs: round(wallMs),
    achievedTransactionsPerSec: round(((starts + completes) / wallMs) * 1000),
    startService: summarise(startService),
    completeService: summarise(completeService),
    startSojourn: summarise(startSojourn),
    completeSojourn: summarise(completeSojourn),
    samples: { completeService, completeSojourn },
    eventLoopDelayMs: {
      mean: round(histogram.mean / 1e6),
      p50: round(histogram.percentile(50) / 1e6),
      p99: round(histogram.percentile(99) / 1e6),
      max: round(histogram.max / 1e6),
    },
    eventLoopUtilisation: round(utilisation.utilization),
  };
}

/**
 * The serialising queue at storage/drivers/sqlite.ts:82 is where an async
 * wrapper can cost something a synchronous call cannot, so it gets its own
 * scenario and its own number: queue wait, the interval between calling
 * transaction() and the body actually starting, reported apart from service.
 */
async function runConcurrency(variant, plan, batches, concurrency) {
  if (!variant.async) {
    return { skipped: "synchronous variant cannot overlap by construction", concurrency };
  }
  variant.setInstrumenting(true);
  variant.admissionToBody.length = 0;
  const latency = [];
  const batchLatency = [];
  let rejected = 0;
  let firstError = null;
  for (let batch = 0; batch < batches; batch++) {
    const t0 = nowMs();
    const work = [];
    for (let k = 0; k < concurrency; k++) {
      const payload = plan[(batch * concurrency + k) % plan.length];
      const opStart = nowMs();
      work.push(variant.start(newId(variant.id), payload).then(() => nowMs() - opStart));
    }
    const settled = await Promise.allSettled(work);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") latency.push(outcome.value);
      else {
        rejected += 1;
        firstError ??= String(outcome.reason && outcome.reason.message);
      }
    }
    batchLatency.push(nowMs() - t0);
    // The no-queue arm cannot survive overlap: two concurrent bodies issue
    // BEGIN on one connection. That is the finding, so stop rather than
    // accumulate thousands of identical failures.
    if (rejected > 0 && batch === 0) break;
  }
  return {
    concurrency,
    rejected,
    firstError,
    perOperation: summarise(latency),
    perBatch: summarise(batchLatency),
    admissionToBody: summarise([...variant.admissionToBody]),
    samples: { perOperation: latency },
  };
}

/**
 * Drain, with the protocol stated rather than implied: stop admitting, await
 * every admitted transaction, verify every expected row through a REOPENED
 * connection, then close. "Durable" here means committed and visible after
 * reopen. Crash survival is s6's work and is not tested here.
 */
async function runDrain(variant, plan, ops, modules, work) {
  const ids = [];
  if (!variant.async) {
    const t0 = nowMs();
    for (let i = 0; i < ops; i++) {
      const id = newId(variant.id);
      ids.push(id);
      variant.start(id, plan[i % plan.length]);
    }
    const inlineWriteMs = nowMs() - t0;
    const t1 = nowMs();
    variant.close();
    return {
      inFlightAtStopAccepting: 0,
      inlineWriteMs: round(inlineWriteMs),
      drainMs: round(nowMs() - t1),
      rowsExpected: ops,
      rowsFound: countRows(modules, work, ids),
      rejected: 0,
    };
  }
  const pending = [];
  for (let i = 0; i < ops; i++) {
    const id = newId(variant.id);
    ids.push(id);
    pending.push(variant.start(id, plan[i % plan.length]));
  }
  const t0 = nowMs();
  const settled = await Promise.allSettled(pending);
  await variant.close();
  return {
    inFlightAtStopAccepting: ops,
    drainMs: round(nowMs() - t0),
    rowsExpected: ops,
    rowsFound: countRows(modules, work, ids),
    rejected: settled.filter(s => s.status === "rejected").length,
  };
}

/**
 * A defect probe, not a latency measurement. SqliteStorageDriver.close()
 * (src/storage/drivers/sqlite.ts:115) sets `closed`, closes both handles and
 * resolves, without ever awaiting `this.queue`. A shutdown that closes while
 * transactions are still queued should therefore lose them. This counts how
 * many, by reopening the file afterwards.
 */
async function runCloseUnderLoad(variant, plan, ops, modules, work) {
  if (!variant.async) return { skipped: "synchronous variant has no queue to abandon" };
  const ids = [];
  const pending = [];
  for (let i = 0; i < ops; i++) {
    const id = newId(variant.id);
    ids.push(id);
    pending.push(variant.start(id, plan[i % plan.length]).catch(() => "rejected"));
  }
  const t0 = nowMs();
  await variant.closeWithoutDraining();
  const closeMs = nowMs() - t0;
  const settled = await Promise.all(pending);
  const rowsFound = countRows(modules, work, ids);
  return {
    submitted: ops,
    closeMs: round(closeMs),
    rejected: settled.filter(s => s === "rejected").length,
    rowsFound,
    rowsLost: rowsFound === null ? null : ops - rowsFound,
  };
}

/**
 * Returns null, never a sentinel number, when the count cannot be taken. An
 * earlier version returned -1, which arithmetic downstream turned into
 * `rowsLost = ops + 1`: a harness failure wearing the costume of data loss.
 */
function countRows(modules, work, ids) {
  let db = null;
  try {
    db = modules.openReadOnly(work);
    const statement = db.prepare("SELECT count(*) AS c FROM requests WHERE id = ?");
    let found = 0;
    for (const id of ids) found += statement.all(id)[0].c;
    return found;
  } catch (error) {
    console.error(`  ! countRows failed, not a loss result: ${error.message}`);
    return null;
  } finally {
    if (db) db.close();
  }
}

/**
 * Row accounting for the scenarios that do not retain every id: count what this
 * variant actually committed under its own tag. G6 asks for verification by
 * reopening the file, and counting thrown errors is not that.
 */
function countRowsByTag(modules, work, tag) {
  let db = null;
  try {
    db = modules.openReadOnly(work);
    return db.prepare("SELECT count(*) AS c FROM requests WHERE id LIKE ?").all(`bench-${tag}-%`)[0]
      .c;
  } catch (error) {
    console.error(`  ! countRowsByTag failed, not a loss result: ${error.message}`);
    return null;
  } finally {
    if (db) db.close();
  }
}

// ------------------------------------------------------------------ main ---

/**
 * Provenance for what was actually measured. An existence check does not stop a
 * stale dist from being benchmarked, so every imported artefact is hashed, its
 * TypeScript source is hashed beside it, and a source newer than its build is a
 * hard error rather than a warning.
 */
function buildProvenance(paths) {
  const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  const record = {};
  for (const [name, distPath] of Object.entries(paths)) {
    const sourcePath = distPath
      .replace(`${sep}dist${sep}`, `${sep}src${sep}`)
      .replace(/\.js$/, ".ts");
    const stale =
      existsSync(sourcePath) && statSync(sourcePath).mtimeMs > statSync(distPath).mtimeMs;
    if (stale) {
      throw new Error(`${sourcePath} is newer than ${distPath}. Run \`npm run build\`.`);
    }
    record[name] = {
      dist: digest(distPath),
      source: existsSync(sourcePath) ? digest(sourcePath) : null,
    };
  }
  let git;
  try {
    git = {
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim()
          .length > 0,
    };
  } catch {
    git = { head: null, dirty: null };
  }
  return { modules: record, git, harness: digest(new URL(import.meta.url).pathname) };
}

async function loadModules() {
  const paths = {
    adapter: join(ROOT, "dist/sqlite-driver.js"),
    storage: join(ROOT, "dist/storage/drivers/sqlite.js"),
    roles: join(ROOT, "dist/storage/roles.js"),
  };
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) {
      throw new Error(`missing ${path}. Run \`npm run build\` first: this measures dist, not src.`);
    }
  }
  const provenance = buildProvenance(paths);
  const adapter = await import(pathToFileURL(paths.adapter).href);
  const storage = await import(pathToFileURL(paths.storage).href);
  const roles = await import(pathToFileURL(paths.roles).href);
  return {
    openDatabase: adapter.openDatabase,
    openReadOnly: adapter.openReadOnly,
    SqliteStorageDriver: storage.SqliteStorageDriver,
    resolveStorageRole: roles.resolveStorageRole,
    provenance,
  };
}

async function withVariant(modules, options, work, columns, sql, variantId, body) {
  restoreWorkingCopy(options.source, work);
  establishWal(modules.openDatabase, work);
  const variant = VARIANT_BUILDERS[variantId](
    modules,
    work,
    columns,
    sql,
    { delayMs: options.injectAsyncDelayMs, blockMs: options.injectAsyncBlockMs },
    options.synchronous
  );
  if (variant.ready) await variant.ready;
  let scenarioOwnsClose = false;
  try {
    return await body(variant, () => {
      scenarioOwnsClose = true;
    });
  } finally {
    if (!scenarioOwnsClose) {
      try {
        const closed = variant.close();
        if (closed && typeof closed.then === "function") await closed;
      } catch {
        // Already closed.
      }
    }
  }
}

function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.source = assertNotLiveState(options.db);
  if (!existsSync(options.source)) throw new Error(`no such database: ${options.source}`);
  const work = assertNotLiveState(join(dirname(options.source), "b1-bench-work.db"));
  mkdirSync(dirname(work), { recursive: true });

  const modules = await loadModules();
  const columns = resolveColumns(modules.openReadOnly, options.source);
  const sql = sqlFor(columns);
  const sizes = samplePayloadSizes(modules.openReadOnly, options.source);
  const trace = loadReplayTrace(modules.openReadOnly, options.source, options.replayWindow);

  console.log(`# b1 sqlite async-wrapping benchmark`);
  console.log(`source      ${options.source} (${statSync(options.source).size} bytes)`);
  console.log(`node        ${process.version}`);
  console.log(
    `build       driver ${modules.provenance.modules.storage.dist} ` +
      `git ${String(modules.provenance.git.head).slice(0, 8)}` +
      `${modules.provenance.git.dirty ? " DIRTY" : ""}`
  );
  console.log(`synchronous ${options.synchronous}  (the recorder leaves SQLite's FULL default)`);
  console.log(`columns     ${columns.length} of ${REQUEST_INSERT_COLUMNS.length}`);
  console.log(`payloads    ${sizes.length} size pairs (UTF-8 bytes) from the snapshot`);
  console.log(`replay      ${trace.length} traced requests from ${options.replayWindow}`);
  if (options.injectAsyncDelayMs > 0) {
    console.log(`PROBE       ${options.injectAsyncDelayMs}ms macrotask sleep per async operation`);
  }
  if (options.injectAsyncBlockMs > 0) {
    console.log(`PROBE       ${options.injectAsyncBlockMs}ms BUSY SPIN per async operation`);
  }

  const variantIds = options.only ?? ["A0", "A1", "Bnq", "B"];
  const wanted = name => !options.scenarios || options.scenarios.includes(name);
  const results = {
    meta: {
      node: process.version,
      columns,
      source: options.source,
      sourceBytes: statSync(options.source).size,
      provenance: modules.provenance,
      options,
      startedAt: new Date().toISOString(),
    },
    runs: [],
  };
  const random = mulberry32(options.seed);

  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const order = shuffled(variantIds, random);
    console.log(`\n== repeat ${repeat + 1}/${options.repeats}  order ${order.join(" ")}`);
    for (const variantId of order) {
      console.log(`-- ${variantId}`);

      for (const cell of wanted("closed") ? options.cells : []) {
        const plan = buildPayloadPlan(sizes, cell, cell.n, 0x1234);
        const warmup = Math.floor(cell.n * options.warmupFraction);
        const token = `c${cell.label}r${repeat}`;
        setScenarioToken(token);
        const run = await withVariant(modules, options, work, columns, sql, variantId, variant =>
          runClosedLoop(variant, plan, warmup)
        );
        run.rowsExpected = cell.n;
        run.rowsCommitted = countRowsByTag(modules, work, `${variantId}-${token}`);
        console.log(
          `   closed:${cell.label.padEnd(5)} n=${run.endToEnd.n} p50 ${run.endToEnd.p50}ms ` +
            `p99 ${run.endToEnd.p99}ms tput ${run.throughputPerSec}/s ` +
            `timer fired ${run.timerFairness.fired}x`
        );
        results.runs.push({ repeat, variant: variantId, scenario: `closed:${cell.label}`, ...run });
      }

      const overlapCapable = variantId !== "Bnq";

      for (const rateSpec of wanted("open") && overlapCapable ? options.rates : []) {
        const plan = buildPayloadPlan(sizes, options.cells[2], 2000, 0x2345);
        const token = `o${rateSpec.label}r${repeat}`;
        setScenarioToken(token);
        const run = await withVariant(modules, options, work, columns, sql, variantId, async v => {
          const sidecar = startReaderAndWalSampler(work);
          const measured = await runOpenLoop(v, plan, rateSpec.rate, rateSpec.durationMs);
          measured.sidecar = await sidecar.stop();
          measured.pragmas = effectivePragmas(modules.openReadOnly, work);
          return measured;
        });
        run.rowsExpected = run.dispatched - run.failures;
        run.rowsCommitted = countRowsByTag(modules, work, `${variantId}-${token}`);
        console.log(
          `   open ${String(rateSpec.rate).padStart(6)}/s n=${run.responseLatency.n} ` +
            `resp p50 ${run.responseLatency.p50}ms p99 ${run.responseLatency.p99}ms ` +
            `eld p99 ${run.eventLoopDelayMs.p99}ms elu ${run.eventLoopUtilisation} ` +
            `wal ${run.sidecar.walMaxBytes} busy ${run.sidecar.busy} fail ${run.failures}`
        );
        results.runs.push({
          repeat,
          variant: variantId,
          scenario: `open:${rateSpec.label}`,
          ...run,
        });
      }

      for (const speed of wanted("replay") && overlapCapable && trace.length > 0
        ? options.replaySpeeds
        : []) {
        const token = `rp${speed}r${repeat}`;
        setScenarioToken(token);
        const run = await withVariant(modules, options, work, columns, sql, variantId, async v => {
          const sidecar = startReaderAndWalSampler(work);
          const measured = await runReplay(v, trace, speed, 90000);
          measured.sidecar = await sidecar.stop();
          return measured;
        });
        run.rowsExpected = run.starts;
        run.rowsCommitted = countRowsByTag(modules, work, `${variantId}-${token}`);
        console.log(
          `   replay x${speed} starts ${run.starts} completes ${run.completes} ` +
            `${run.achievedTransactionsPerSec} txn/s complete p99 ${run.completeService.p99}ms ` +
            `eld p99 ${run.eventLoopDelayMs.p99}ms fail ${run.failures}`
        );
        results.runs.push({ repeat, variant: variantId, scenario: `replay:x${speed}`, ...run });
      }

      // Bnq at concurrency > 1 cannot work: two bodies BEGIN on one connection.
      // That is recorded once as a labelled finding below, not as a measured
      // scenario whose deliberate rejections would then violate G6.
      const concurrencyLevels = wanted("concurrency")
        ? variantId === "Bnq"
          ? [1]
          : [1, options.concurrency]
        : [];
      for (const concurrency of concurrencyLevels) {
        const plan = buildPayloadPlan(sizes, options.cells[0], 1000, 0x3456);
        const run = await withVariant(modules, options, work, columns, sql, variantId, v =>
          runConcurrency(v, plan, 60, concurrency)
        );
        console.log(
          `   conc x${concurrency}   ${
            run.skipped ??
            `per-op p50 ${run.perOperation.p50}ms p99 ${run.perOperation.p99}ms ` +
              `admission-to-body p99 ${run.admissionToBody.p99}ms`
          }`
        );
        results.runs.push({
          repeat,
          variant: variantId,
          scenario: `concurrency:x${concurrency}`,
          ...run,
        });
      }

      if (wanted("drain") && overlapCapable) {
        const plan = buildPayloadPlan(sizes, options.cells[2], options.drainOps, 0x4567);
        const drain = await withVariant(
          modules,
          options,
          work,
          columns,
          sql,
          variantId,
          (v, own) => {
            own();
            return runDrain(v, plan, options.drainOps, modules, work);
          }
        );
        console.log(`   drain    ${JSON.stringify(drain)}`);
        results.runs.push({ repeat, variant: variantId, scenario: "drain", ...drain });
      }

      if (wanted("closeUnderLoad") && overlapCapable) {
        const plan = buildPayloadPlan(sizes, options.cells[2], options.drainOps, 0x4567);
        const probe = await withVariant(
          modules,
          options,
          work,
          columns,
          sql,
          variantId,
          (v, own) => {
            own();
            return runCloseUnderLoad(v, plan, options.drainOps, modules, work);
          }
        );
        console.log(`   close!   ${JSON.stringify(probe)}`);
        results.runs.push({ repeat, variant: variantId, scenario: "closeUnderLoad", ...probe });
      }
    }
  }

  results.meta.finishedAt = new Date().toISOString();
  report(results, variantIds, options);
  if (options.json) {
    writeFileSync(options.json, JSON.stringify(results, null, 2));
    console.log(`\nJSON written to ${options.json}`);
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${work}${suffix}`, { force: true });
}

function pooled(results, scenario, variantId, key) {
  const out = [];
  for (const run of results.runs) {
    if (run.scenario !== scenario || run.variant !== variantId) continue;
    const values = run.samples ? run.samples[key] : null;
    if (Array.isArray(values)) out.push(...values);
  }
  return out;
}

function sampleKeyFor(scenario) {
  if (scenario.startsWith("closed")) return "endToEnd";
  if (scenario.startsWith("open")) return "responseLatency";
  if (scenario.startsWith("concurrency")) return "perOperation";
  if (scenario.startsWith("replay")) return "completeService";
  return null;
}

function report(results, variantIds, options) {
  console.log(`\n\n# summary (spread is min / median / max over ${options.repeats} repeats)`);
  const scenarios = [...new Set(results.runs.map(run => run.scenario))];
  for (const scenario of scenarios) {
    console.log(`\n## ${scenario}`);
    for (const variantId of variantIds) {
      const runs = results.runs.filter(r => r.scenario === scenario && r.variant === variantId);
      if (runs.length === 0) continue;
      if (runs[0].skipped) {
        console.log(`  ${variantId.padEnd(4)} ${runs[0].skipped}`);
        continue;
      }
      const parts = [`  ${variantId.padEnd(4)}`];
      const show = (path, label) => {
        const values = runs.map(r => path.split(".").reduce((o, k) => (o ? o[k] : undefined), r));
        if (values.some(v => typeof v === "number")) {
          parts.push(`${label} ${JSON.stringify(spread(values))}`);
        }
      };
      show("endToEnd.p50", "p50");
      show("endToEnd.p99", "p99");
      show("responseLatency.p50", "resp-p50");
      show("responseLatency.p99", "resp-p99");
      show("completeService.p99", "compl-p99");
      show("completeSojourn.p99", "compl-sojourn-p99");
      show("perOperation.p50", "op-p50");
      show("admissionToBody.p99", "admit-p99");
      show("eventLoopDelayMs.p99", "eld-p99");
      show("eventLoopDelayMs.max", "eld-max");
      show("eventLoopUtilisation", "elu");
      show("throughputPerSec", "tput");
      show("achievedTransactionsPerSec", "txn/s");
      show("timerFairness.gapMs.p99", "timer-p99");
      show("drainMs", "drainMs");
      show("rowsFound", "rowsFound");
      show("rowsExpected", "rowsExpected");
      show("rowsCommitted", "rowsCommitted");
      show("rowsLost", "rowsLost");
      show("rejected", "rejected");
      show("failures", "failures");
      show("sidecar.walMaxBytes", "walMax");
      show("sidecar.busy", "busy");
      show("rejected", "rejectedOps");
      if (runs[0].firstError) parts.push(`firstError "${runs[0].firstError}"`);
      console.log(parts.join("  "));
    }
  }

  console.log(`\n\n# bootstrap 95% intervals for the quantile difference (ms)`);
  console.log(`# "no criterion fired" is not equivalence. These bounds are.`);
  const pairs = [
    ["A1", "Bnq", "promises alone"],
    ["Bnq", "B", "the serialising queue"],
    ["A1", "B", "async wrapping including the queue"],
    ["A0", "A1", "the driver's non-async choices"],
    ["A0", "B", "the total delta s7 would pay"],
  ];
  for (const scenario of [...new Set(results.runs.map(r => r.scenario))]) {
    const key = sampleKeyFor(scenario);
    if (!key) continue;
    let printedHeader = false;
    for (const [baselineId, candidateId, meaning] of pairs) {
      const baseline = pooled(results, scenario, baselineId, key);
      const candidate = pooled(results, scenario, candidateId, key);
      if (baseline.length === 0 || candidate.length === 0) continue;
      if (!printedHeader) {
        console.log(`\n## ${scenario}  (${key}, pooled over repeats)`);
        printedHeader = true;
      }
      for (const [quantile, label] of [
        [0.5, "p50"],
        [0.99, "p99"],
      ]) {
        const result = bootstrapQuantileDifference(
          baseline,
          candidate,
          quantile,
          options.bootstrapIterations,
          options.seed + Math.round(quantile * 100)
        );
        if (!result) continue;
        console.log(
          `  ${candidateId} - ${baselineId} ${label}: ${result.point} ` +
            `[${result.lower95}, ${result.upper95}] ` +
            `${result.detectable ? "DETECTABLE" : "indistinguishable"}  (${meaning})`
        );
      }
    }
  }
}

main().catch(error => {
  console.error(`benchmark failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
