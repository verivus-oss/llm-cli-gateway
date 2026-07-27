import { describe, it, expect, vi } from "vitest";
import {
  STARTUP_VERSION_CHECK_DISABLE_ENV,
  runStartupVersionCheck,
  startupVersionCheckEnabled,
} from "../startup-version-check.js";
import { PROVIDER_TARGET_VERSIONS } from "../provider-definitions.js";
import { CLI_TYPES, type CliType } from "../provider-types.js";
import type { CliVersionInfo } from "../cli-updater.js";

function versionInfo(cli: CliType, version: string | null): CliVersionInfo {
  return {
    cli,
    command: cli,
    args: ["--version"],
    installed: version !== null,
    version: version ?? undefined,
    stdout: version ?? "",
    stderr: "",
  };
}

/** Every provider reporting exactly its contracted version. */
function allMatching(): CliVersionInfo[] {
  return CLI_TYPES.map(cli => versionInfo(cli, PROVIDER_TARGET_VERSIONS[cli]));
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
      getVersions: async () => allMatching(),
    });
    expect(drifted).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("reports drift with a greppable headline and per-provider detail", async () => {
    const logger = fakeLogger();
    const versions = allMatching().map(v =>
      v.cli === "grok" ? versionInfo("grok", "grok 0.2.113") : v
    );
    const drifted = await runStartupVersionCheck(logger as never, {
      getVersions: async () => versions,
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
    const versions = allMatching().filter(v => v.cli !== "devin");
    versions.push(versionInfo("devin", null));
    const drifted = await runStartupVersionCheck(logger as never, {
      getVersions: async () => versions,
    });
    expect(drifted).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("skips entirely when disabled, spawning nothing", async () => {
    const logger = fakeLogger();
    const getVersions = vi.fn();
    const drifted = await runStartupVersionCheck(logger as never, {
      getVersions: getVersions as never,
      env: { [STARTUP_VERSION_CHECK_DISABLE_ENV]: "1" },
    });
    expect(drifted).toEqual([]);
    expect(getVersions).not.toHaveBeenCalled();
  });

  it("never throws, whatever the version collector does", async () => {
    // This runs un-awaited at startup, so an unhandled rejection here would
    // surface as a crash in a gateway that is otherwise serving fine.
    const logger = fakeLogger();
    await expect(
      runStartupVersionCheck(logger as never, {
        getVersions: async () => {
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
        getVersions: async () => null as never,
      })
    ).resolves.toEqual([]);
  });
});
