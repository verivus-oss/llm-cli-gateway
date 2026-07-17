import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  flattenCliSubcommands,
  probeInstalledCliContract,
  subcommandHelpProbeIsUntrusted,
  UPSTREAM_CLI_CONTRACTS,
} from "../upstream-contracts.js";
import type { CliType } from "../provider-types.js";

// Mock ONLY spawnSync of node:child_process (upstream-contracts imports from the
// `node:`-prefixed specifier; executor.ts imports from bare "child_process", so
// its resolveCommandForSpawn is untouched). This lets the runtime subcommand
// probe be driven deterministically without spawning real provider CLIs.
vi.mock("node:child_process", async importActual => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

const mockedSpawn = vi.mocked(spawnSync);

const HELP_TEXT = "Usage: tool [options]\n  --help  Show help\n  --json  Emit JSON\n";

// Minimal spawnSync-return shape; only .error/.status/.stdout/.stderr are read.
function spawnRes(overrides: Record<string, unknown>): unknown {
  return {
    pid: 1,
    output: ["", HELP_TEXT, ""],
    stdout: HELP_TEXT,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

// probeInstalledCliContract runs every declared `helpArgs` (root) probe FIRST,
// then probes subcommands, so the mock can split root vs subcommand by call
// order. This avoids the argv collision when a subcommand's help argv (e.g.
// `exec --help`) equals a root helpArgs entry. rootResult drives the leading
// root calls; subResult drives everything after.
function driveSpawn(
  cli: CliType,
  handlers: {
    rootResult: (args: string[]) => unknown;
    subResult: (args: string[]) => unknown;
  }
): void {
  let rootRemaining = UPSTREAM_CLI_CONTRACTS[cli].helpArgs.length;
  mockedSpawn.mockImplementation(((_cmd: string, args: string[]) => {
    if (rootRemaining > 0) {
      rootRemaining -= 1;
      return handlers.rootResult(args);
    }
    return handlers.subResult(args);
  }) as never);
}

// On linux resolveCommandForSpawn returns argv unchanged, so within the
// subcommand phase a spawnSync call's args identify the specific subcommand.
function subcommandArgvKeys(cli: CliType, commandPath: readonly string[]): Set<string> {
  const sub = flattenCliSubcommands(UPSTREAM_CLI_CONTRACTS[cli].subcommands).find(
    candidate => candidate.commandPath.join(" ") === commandPath.join(" ")
  );
  if (!sub) throw new Error(`no subcommand ${commandPath.join(" ")} for ${cli}`);
  return new Set(sub.helpArgs.map(help => [...commandPath, ...help].join(" ")));
}

function firstSubcommand(cli: CliType, opts: { tolerant: boolean }): readonly string[] {
  const sub = flattenCliSubcommands(UPSTREAM_CLI_CONTRACTS[cli].subcommands).find(candidate =>
    opts.tolerant ? candidate.helpProbeExitTolerant === true : !candidate.helpProbeExitTolerant
  );
  if (!sub)
    throw new Error(`no ${opts.tolerant ? "tolerant" : "non-tolerant"} subcommand for ${cli}`);
  return sub.commandPath;
}

// codex has non-tolerant subcommands; gemini (agy) has the tolerant `update`.
const NONTOLERANT_CLI: CliType = "codex";

beforeEach(() => {
  mockedSpawn.mockReset();
});

describe("F4 runtime subcommand-help-probe wiring", () => {
  // Regression guard for the invert-the-bug blocker: a clean exit-0 run must NOT
  // be treated as untrusted. The mutation is passing a raw spawnSync result
  // (no `available` field) into the predicate; then !result.available is truthy
  // and this assertion flips to true.
  it("keeps helpExitedNonzero false for an all-clean exit-0 probe", () => {
    driveSpawn(NONTOLERANT_CLI, {
      rootResult: () => spawnRes({ status: 0 }),
      subResult: () => spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(NONTOLERANT_CLI);

    expect(probe.available).toBe(true);
    expect(probe.helpExitedNonzero).toBe(false);
    for (const sub of Object.values(probe.subcommands)) {
      expect(sub.helpExitedNonzero).toBe(false);
    }
  });

  it("flags a subcommand help probe that fails to spawn as unavailable and untrusted", () => {
    const commandPath = firstSubcommand(NONTOLERANT_CLI, { tolerant: false });
    const targetKeys = subcommandArgvKeys(NONTOLERANT_CLI, commandPath);

    driveSpawn(NONTOLERANT_CLI, {
      rootResult: () => spawnRes({ status: 0 }),
      subResult: args =>
        targetKeys.has(args.join(" "))
          ? spawnRes({ error: new Error("spawn ENOENT") })
          : spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(NONTOLERANT_CLI);
    const targetProbe = Object.values(probe.subcommands).find(
      sub => sub.commandPath.join(" ") === commandPath.join(" ")
    );
    expect(targetProbe).toBeDefined();
    expect(targetProbe?.available).toBe(false);
    expect(targetProbe?.helpExitedNonzero).toBe(true);
    // Root spawned fine, so the contract stays available but the fold surfaces it.
    expect(probe.available).toBe(true);
    expect(probe.helpExitedNonzero).toBe(true);
  });

  it("flags a nonzero-exit non-tolerant subcommand while keeping it available", () => {
    const commandPath = firstSubcommand(NONTOLERANT_CLI, { tolerant: false });
    const targetKeys = subcommandArgvKeys(NONTOLERANT_CLI, commandPath);

    driveSpawn(NONTOLERANT_CLI, {
      rootResult: () => spawnRes({ status: 0 }),
      subResult: args =>
        targetKeys.has(args.join(" ")) ? spawnRes({ status: 1 }) : spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(NONTOLERANT_CLI);
    const targetProbe = Object.values(probe.subcommands).find(
      sub => sub.commandPath.join(" ") === commandPath.join(" ")
    );
    expect(targetProbe?.available).toBe(true);
    expect(targetProbe?.helpExitedNonzero).toBe(true);
    // Contract-level OR-fold: an untrusted SUBCOMMAND alone (root clean) must make
    // contract.helpExitedNonzero true. Dropping the fold weakens this to false.
    expect(probe.helpExitedNonzero).toBe(true);
  });

  it("trusts a nonzero-exit tolerant subcommand (helpProbeExitTolerant)", () => {
    const cli: CliType = "gemini";
    const commandPath = firstSubcommand(cli, { tolerant: true });
    const targetKeys = subcommandArgvKeys(cli, commandPath);

    driveSpawn(cli, {
      rootResult: () => spawnRes({ status: 0 }),
      subResult: args =>
        targetKeys.has(args.join(" ")) ? spawnRes({ status: 2 }) : spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(cli);
    const targetProbe = Object.values(probe.subcommands).find(
      sub => sub.commandPath.join(" ") === commandPath.join(" ")
    );
    expect(targetProbe?.available).toBe(true);
    expect(targetProbe?.helpExitedNonzero).toBe(false);
  });

  it("folds a nonzero declared helpArgs probe into contract.helpExitedNonzero", () => {
    driveSpawn(NONTOLERANT_CLI, {
      rootResult: () => spawnRes({ status: 1 }),
      // Every subcommand exits clean, isolating the signal to the helpArgs fold.
      subResult: () => spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(NONTOLERANT_CLI);
    expect(probe.available).toBe(true);
    expect(probe.helpExitedNonzero).toBe(true);
    for (const sub of Object.values(probe.subcommands)) {
      expect(sub.helpExitedNonzero).toBe(false);
    }
  });

  it("preserves an earlier nonzero helpArgs exit when a later helpArgs spawn-fails", () => {
    // Codex is the only multi-helpArgs CLI. If the first declared help probe
    // exits nonzero and a LATER one spawn-fails (e.g. a timeout), the early
    // return must NOT wipe the prior untrusted-help signal. Mutation: hard-coding
    // helpExitedNonzero:false on the early return flips this to false.
    expect(UPSTREAM_CLI_CONTRACTS.codex.helpArgs.length).toBeGreaterThan(1);
    let rootCall = 0;
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[]) => {
      rootCall += 1;
      // First helpArgs: spawned but exited nonzero. Second: spawn failure.
      return rootCall === 1
        ? spawnRes({ status: 1 })
        : spawnRes({ error: new Error("spawn ETIMEDOUT") });
    }) as never);

    const probe = probeInstalledCliContract("codex");
    expect(probe.available).toBe(false);
    expect(probe.helpExitedNonzero).toBe(true);
    expect(Object.keys(probe.subcommands)).toHaveLength(0);
  });

  it("carries helpExitedNonzero:false on an early root spawn failure", () => {
    // The very first spawn (a root helpArgs probe) errors, so probeInstalledCliContract
    // returns early. available:false carries the root failure; the untrusted-help
    // signal stays false and no subcommands are probed.
    driveSpawn(NONTOLERANT_CLI, {
      rootResult: () => spawnRes({ error: new Error("spawn ENOENT") }),
      subResult: () => spawnRes({ status: 0 }),
    });

    const probe = probeInstalledCliContract(NONTOLERANT_CLI);
    expect(probe.available).toBe(false);
    expect(probe.helpExitedNonzero).toBe(false);
    expect(Object.keys(probe.subcommands)).toHaveLength(0);
  });
});

describe("F4 shared predicate truth table (runtime export)", () => {
  const strict = { helpProbeExitTolerant: false };
  const tolerant = { helpProbeExitTolerant: true };

  it("treats an unavailable probe as untrusted regardless of tolerance", () => {
    expect(subcommandHelpProbeIsUntrusted(strict, { available: false, status: null })).toBe(true);
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: false, status: null })).toBe(true);
    expect(subcommandHelpProbeIsUntrusted(undefined, { available: false, status: 0 })).toBe(true);
  });

  it("treats a nonzero exit as untrusted only when not tolerant", () => {
    expect(subcommandHelpProbeIsUntrusted(strict, { available: true, status: 1 })).toBe(true);
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: true, status: 1 })).toBe(false);
    expect(subcommandHelpProbeIsUntrusted(undefined, { available: true, status: 3 })).toBe(true);
  });

  it("trusts a clean exit-0 run", () => {
    expect(subcommandHelpProbeIsUntrusted(strict, { available: true, status: 0 })).toBe(false);
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: true, status: 0 })).toBe(false);
    expect(subcommandHelpProbeIsUntrusted(undefined, { available: true, status: 0 })).toBe(false);
  });
});
