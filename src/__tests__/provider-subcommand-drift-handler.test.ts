import { describe, expect, it, vi } from "vitest";
import type { InstalledCliContractProbe } from "../upstream-contracts.js";

// Force the runtime probe to return a synthetic contract whose only subcommand
// is available AND clean on flags but exited nonzero on its help probe. This is
// exactly the F4 fail-open: without `|| sub.helpExitedNonzero` in the drift
// handler the row is drift-free and (default includeClean=false) DROPPED.
const CRAFTED_SUBCOMMAND = {
  commandPath: ["exec"] as const,
  checkedHelpCommands: [["exec", "--help"]],
  available: true,
  missingFlags: [] as string[],
  extraFlags: [] as string[],
  acknowledgedExtraFlags: [] as string[],
  discoveredFlags: [] as string[],
  helpHash: "sub-hash",
  probedAt: "2026-01-01T00:00:00.000Z",
  warnings: ["codex exec --help exited with status 1"],
  risk: "executes_agent" as const,
  exposure: "mcp_requires_approval" as const,
  tier: "execute_candidate" as const,
  summary: "Run a non-interactive codex exec task.",
  helpExitedNonzero: true,
};

const CRAFTED_PROBE: InstalledCliContractProbe = {
  cli: "codex",
  executable: "codex",
  resolvedCommand: "codex",
  resolvedArgs: ["exec", "--help"],
  available: true,
  checkedHelpCommands: [["exec", "--help"]],
  missingFlags: [],
  extraFlags: [],
  acknowledgedExtraFlags: [],
  discoveredFlags: [],
  helpHash: "root-hash",
  versionHint: undefined,
  subcommands: { exec: CRAFTED_SUBCOMMAND },
  probedAt: "2026-01-01T00:00:00.000Z",
  warnings: [],
  helpExitedNonzero: true,
};

vi.mock("../upstream-contracts.js", async importActual => {
  const actual = await importActual<typeof import("../upstream-contracts.js")>();
  return {
    ...actual,
    probeInstalledCliContract: vi.fn(() => CRAFTED_PROBE),
  };
});

async function makeServer() {
  const { createGatewayServer } = await import("../index.js");
  const { AsyncJobManager } = await import("../async-job-manager.js");
  const { MemoryJobStore } = await import("../job-store.js");
  const { noopLogger } = await import("../logger.js");
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  return createGatewayServer({
    asyncJobManager: manager,
    persistence: {
      backend: "sqlite",
      logsDbPath: ":memory:",
      jobsDbPath: ":memory:",
      jobRetentionDays: 7,
      dedupWindowMs: 0,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    },
  });
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>
  ) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
}

describe("provider_subcommand_drift F4 wiring", () => {
  it("reports an untrusted-help-exit subcommand as drift even with clean flags", async () => {
    const server = await makeServer();
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const result = await reg.provider_subcommand_drift.handler(
      { provider: "codex", includeClean: false },
      {}
    );
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.schemaVersion).toBe("provider-subcommand-drift.v1");
    // The mutation `drifted = !available || extra || missing` (dropping
    // `|| sub.helpExitedNonzero`) makes this row clean and, under
    // includeClean=false, drops it: total becomes 0 and this fails.
    expect(payload.total).toBe(1);
    const row = payload.rows[0];
    expect(row.commandPath).toEqual(["exec"]);
    expect(row.driftStatus).toBe("drift");
    expect(row.helpExitedNonzero).toBe(true);
    expect(row.available).toBe(true);
    expect(row.extraVsContract).toEqual([]);
    expect(row.missingFromBinary).toEqual([]);
  });
});
