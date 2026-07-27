import { describe, it, expect, vi } from "vitest";
import {
  STARTUP_VERSION_CHECK_DISABLE_ENV,
  runStartupVersionCheck,
  startupVersionCheckEnabled,
} from "../startup-version-check.js";
import { PROVIDER_TARGET_VERSIONS } from "../provider-definitions.js";
import { CLI_TYPES, type CliType } from "../provider-types.js";
import type { InstalledVersionMap } from "../startup-version-check.js";

/** Every provider reporting exactly its contracted version. */
function allMatching(): InstalledVersionMap {
  return Object.fromEntries(
    CLI_TYPES.map(cli => [cli, PROVIDER_TARGET_VERSIONS[cli]])
  ) as InstalledVersionMap;
}

function fakeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe("startupVersionCheckEnabled", () => {
  it("is on by default, because drift was going unnoticed", () => {
    expect(startupVersionCheckEnabled({})).toBe(true);
  });

  it("honours the kill switch in its common spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", " yes "]) {
      expect(startupVersionCheckEnabled({ [STARTUP_VERSION_CHECK_DISABLE_ENV]: value })).toBe(
        false
      );
    }
  });

  it("stays on for values that are not a disable", () => {
    for (const value of ["0", "false", "no", ""]) {
      expect(startupVersionCheckEnabled({ [STARTUP_VERSION_CHECK_DISABLE_ENV]: value })).toBe(true);
    }
  });
});

describe("runStartupVersionCheck", () => {
  it("says nothing at all when every provider matches", async () => {
    // A startup line that is almost always "fine" trains people to skip it,
    // and it competes with real errors on stderr.
    const logger = fakeLogger();
    const drifted = await runStartupVersionCheck(logger as never, {
      collectVersions: async () => allMatching(),
    });
    expect(drifted).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("reports drift with a greppable headline and per-provider detail", async () => {
    const logger = fakeLogger();
    const drifted = await runStartupVersionCheck(logger as never, {
      collectVersions: async () => ({ ...allMatching(), grok: "grok 0.2.113" }),
    });

    expect(drifted).toEqual(["grok"]);
    const lines = logger.error.mock.calls.map(c => String(c[0]));
    expect(lines[0]).toContain("drift detected");
    expect(lines[0]).toContain("grok");
    expect(lines.join("\n")).toContain("0.2.113");
    expect(lines.join("\n")).toContain("provider_version_guard");
  });

  it("does not treat a missing CLI as drift", async () => {
    // A machine without all seven providers must not log an error every boot.
    const logger = fakeLogger();
    const drifted = await runStartupVersionCheck(logger as never, {
      collectVersions: async () => ({ ...allMatching(), devin: null }),
    });
    expect(drifted).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("skips entirely when disabled, spawning nothing", async () => {
    const logger = fakeLogger();
    const collectVersions = vi.fn();
    const drifted = await runStartupVersionCheck(logger as never, {
      collectVersions: collectVersions as never,
      env: { [STARTUP_VERSION_CHECK_DISABLE_ENV]: "1" },
    });
    expect(drifted).toEqual([]);
    expect(collectVersions).not.toHaveBeenCalled();
  });

  it("never throws, whatever the version collector does", async () => {
    // This runs un-awaited at startup, so an unhandled rejection here would
    // surface as a crash in a gateway that is otherwise serving fine.
    const logger = fakeLogger();
    await expect(
      runStartupVersionCheck(logger as never, {
        collectVersions: async () => {
          throw new Error("spawn ENOENT");
        },
      })
    ).resolves.toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("survives a malformed version payload", async () => {
    const logger = fakeLogger();
    await expect(
      runStartupVersionCheck(logger as never, {
        collectVersions: async () => null as never,
      })
    ).resolves.toEqual([]);
  });
});

describe("runStartupVersionCheck: does not block the event loop", () => {
  // Found in review. `void runStartupVersionCheck(logger)` used to reach
  // getCliVersions, which hits spawnSync before its first await, so `void`
  // bought nothing: control did not return for 5277 ms measured on this host.
  // A gateway that has just announced itself ready cannot serve anything
  // during that window.
  //
  // NOTE: assertions must live OUTSIDE the injected collector. The function
  // swallows every error by design, so an `expect` inside the collector is
  // caught and silently discarded, and the test passes no matter what.
  it("returns control before the collector does any synchronous work", async () => {
    const logger = { info() {}, error() {}, debug() {}, warn() {} };
    let collectorEntered = false;
    const pending = runStartupVersionCheck(logger as never, {
      collectVersions: async () => {
        collectorEntered = true;
        // Simulate spawnSync: burn wall-clock synchronously. Without a
        // suspension point before this, the caller wears the whole cost.
        const until = Date.now() + 150;
        while (Date.now() < until) {
          /* spin */
        }
        return allMatching();
      },
    });

    // Recorded synchronously, immediately after the call returns.
    const enteredSynchronously = collectorEntered;
    expect(enteredSynchronously).toBe(false);
    await pending;
    expect(collectorEntered).toBe(true);
  });

  it("keeps the caller off the hot path even for a slow probe", async () => {
    const logger = { info() {}, error() {}, debug() {}, warn() {} };
    const started = Date.now();
    const pending = runStartupVersionCheck(logger as never, {
      collectVersions: async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        return allMatching();
      },
    });
    const returnedAfter = Date.now() - started;
    expect(returnedAfter).toBeLessThan(50);
    await pending;
  });
});
