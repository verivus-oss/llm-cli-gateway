import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { SqliteJobStore, MemoryJobStore, type JobStore } from "../job-store.js";
import { FlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// Cross-LLM validation receipts (Phase 3): the validation-receipt:// MCP resource.

function persistence(backend: "sqlite" | "memory", path: string | null): PersistenceConfig {
  return {
    backend,
    path,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function ctx(authPrincipal?: string): GatewayRequestContext {
  return authPrincipal
    ? { transport: "http", authScopes: [], authPrincipal }
    : { transport: "stdio", authScopes: [] };
}

interface TemplateEntry {
  resourceTemplate: { uriTemplate: { toString: () => string } };
  readCallback: (
    uri: URL,
    variables: Record<string, unknown>,
    extra: Record<string, unknown>
  ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
}

function templates(server: unknown): Record<string, TemplateEntry> {
  return (server as Record<string, Record<string, TemplateEntry>>)._registeredResourceTemplates;
}

describe("validation-receipt:// MCP resource (Phase 3)", () => {
  let tmp: string;
  let store: SqliteJobStore;
  let flight: FlightRecorder;

  function buildServer(jobStore: JobStore, backend: "sqlite" | "memory") {
    return createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, jobStore),
      persistence: persistence(backend, join(tmp, "jobs.db")),
      flightRecorder: flight,
    });
  }

  function seedTerminalRun(owner: string): void {
    const now = new Date().toISOString();
    for (const id of ["j-claude", "j-codex"]) {
      store.recordStart({
        id,
        correlationId: `corr-${id}`,
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: now,
        pid: null,
        ownerPrincipal: owner,
      });
      store.recordComplete({
        id,
        status: "completed",
        exitCode: 0,
        stdout: "Verdict: approve",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: now,
      });
    }
    store.recordValidationRun({
      validationId: "v1",
      ownerPrincipal: owner,
      intent: "validate",
      createdAt: now,
      requestJson: JSON.stringify({ question: "Is this safe?", modelList: ["claude", "codex"] }),
      providerLinks: [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" },
      ],
      judgeLink: null,
      status: "running",
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "validation-receipt-resource-"));
    store = new SqliteJobStore(join(tmp, "jobs.db"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function read(server: unknown, validationId: string, principal?: string) {
    const entry = templates(server)["validation-receipt"];
    const result = await runWithRequestContext(ctx(principal), () =>
      entry.readCallback(new URL(`validation-receipt://${validationId}`), { validationId }, {})
    );
    return JSON.parse(result.contents[0].text);
  }

  it("is registered under the sqlite backend and returns the minted receipt to its owner", async () => {
    seedTerminalRun("local");
    const server = buildServer(store, "sqlite");
    expect(templates(server)["validation-receipt"]).toBeDefined();

    const body = await read(server, "v1");
    expect(body.status).toBe("minted");
    expect(body.receipt.validationId).toBe("v1");
  });

  it("is own-or-not-found: another principal gets not_found, never the data", async () => {
    seedTerminalRun("alice");
    const server = buildServer(store, "sqlite");

    const bob = await read(server, "v1", "bob");
    expect(bob.status).toBe("not_found");
    expect(JSON.stringify(bob)).not.toContain("Verdict");

    const alice = await read(server, "v1", "alice");
    expect(alice.status).toBe("minted");
  });

  it("returns not_found for an unknown id", async () => {
    const server = buildServer(store, "sqlite");
    expect((await read(server, "nope")).status).toBe("not_found");
  });

  it("is NOT registered under a non-durable (memory) backend", () => {
    const server = buildServer(new MemoryJobStore(), "memory");
    expect(templates(server)["validation-receipt"]).toBeUndefined();
  });
});

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function tools(server: unknown): Record<string, RegisteredTool> {
  return (server as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

describe("validation_receipt tool (Phase 1-2)", () => {
  let tmp: string;
  let store: SqliteJobStore;
  let flight: FlightRecorder;

  function buildServer(jobStore: JobStore, backend: "sqlite" | "memory") {
    return createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, jobStore),
      persistence: persistence(backend, join(tmp, "jobs.db")),
      flightRecorder: flight,
    });
  }

  function seedTerminalRun(owner: string): void {
    const now = new Date().toISOString();
    for (const id of ["j-claude", "j-codex"]) {
      store.recordStart({
        id,
        correlationId: `corr-${id}`,
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: now,
        pid: null,
        ownerPrincipal: owner,
      });
      store.recordComplete({
        id,
        status: "completed",
        exitCode: 0,
        stdout: "Verdict: approve",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: now,
      });
    }
    store.recordValidationRun({
      validationId: "v1",
      ownerPrincipal: owner,
      intent: "validate",
      createdAt: now,
      requestJson: JSON.stringify({ question: "Is this safe?", modelList: ["claude", "codex"] }),
      providerLinks: [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" },
      ],
      judgeLink: null,
      status: "running",
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "validation-receipt-tool-"));
    store = new SqliteJobStore(join(tmp, "jobs.db"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function callTool(server: unknown, args: Record<string, unknown>, principal?: string) {
    const entry = tools(server)["validation_receipt"];
    return runWithRequestContext(ctx(principal), () => entry.handler(args, {}));
  }

  it("is registered under sqlite and absent under the memory backend", () => {
    expect(tools(buildServer(store, "sqlite"))["validation_receipt"]).toBeDefined();
    expect(
      tools(buildServer(new MemoryJobStore(), "memory"))["validation_receipt"]
    ).toBeUndefined();
  });

  it("returns the minted receipt as JSON by default", async () => {
    seedTerminalRun("local");
    const server = buildServer(store, "sqlite");
    const res = await callTool(server, {
      validationId: "v1",
      format: "json",
      includeRawResponses: false,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("minted");
    expect(body.receipt.validationId).toBe("v1");
  });

  it("returns the human-readable rendering for format=markdown", async () => {
    seedTerminalRun("local");
    const server = buildServer(store, "sqlite");
    const res = await callTool(server, {
      validationId: "v1",
      format: "markdown",
      includeRawResponses: false,
    });
    // markdown short-circuit returns the humanReadable text, not JSON
    expect(res.content[0].text).toContain("Validation report v1");
    expect(res.content[0].text).not.toContain('"status":');
  });

  it("is own-or-not-found for another principal", async () => {
    seedTerminalRun("alice");
    const server = buildServer(store, "sqlite");
    const res = await callTool(
      server,
      { validationId: "v1", format: "json", includeRawResponses: false },
      "bob"
    );
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("not_found");
    expect(JSON.stringify(body)).not.toContain("Verdict");
  });
});
