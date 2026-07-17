import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildUpstreamContractReport } from "../upstream-contracts.js";
import { buildPersonalConfigReadinessReport, createDoctorReport } from "../doctor.js";

// Deterministic options: an empty env (stdio transport, no auth) and a disabled
// Personal Agent Config Kit, so nothing else flips report.ok on the host running
// the suite. probeUpstream drives the F4 advisory under test.
function doctorOptions(probeUpstream: boolean): Parameters<typeof createDoctorReport>[0] {
  return {
    env: {},
    probeUpstream,
    personalConfigReadiness: buildPersonalConfigReadinessReport({ enabled: false }),
  };
}

// Mock ONLY buildUpstreamContractReport so createDoctorReport's opt-in probe path
// returns a synthetic installedProbe. CreateDoctorReportOptions exposes no
// probe-report injection, so vi.mock is the test mechanism (see plan section 7).
vi.mock("../upstream-contracts.js", async importActual => {
  const actual = await importActual<typeof import("../upstream-contracts.js")>();
  return { ...actual, buildUpstreamContractReport: vi.fn() };
});

const mocked = vi.mocked(buildUpstreamContractReport);

function installedProbeReport(installedProbe: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: "upstream-cli-contracts.v1", installedProbe, acpInstalledProbe: null };
}

function wire(installedProbe: Record<string, unknown> | null): void {
  mocked.mockImplementation((opts?: { probeInstalled?: boolean }) =>
    opts?.probeInstalled
      ? installedProbeReport(installedProbe ?? {})
      : { schemaVersion: "upstream-cli-contracts.v1", installedProbe: null }
  );
}

beforeEach(() => {
  mocked.mockReset();
});

describe("doctor F4 upstream-probe advisory", () => {
  it("adds ONE re-probe next_action when a probed CLI is unverified, without flipping ok", () => {
    wire({
      // untrusted via the rolled-up helpExitedNonzero flag
      codex: { helpExitedNonzero: true, subcommands: {} },
      // untrusted via a subcommand that could not run (available:false)
      gemini: { helpExitedNonzero: false, subcommands: { update: { available: false } } },
      // fully clean: must NOT appear in the advisory
      claude: { helpExitedNonzero: false, subcommands: { config: { available: true } } },
    });

    const report = createDoctorReport(doctorOptions(true));

    const reprobe = report.next_actions.filter(a => a.startsWith("re-probe "));
    expect(reprobe).toHaveLength(1);
    expect(reprobe[0]).toContain("codex");
    expect(reprobe[0]).toContain("gemini");
    expect(reprobe[0]).not.toContain("claude");
    expect(reprobe[0]).toContain("contract is unverified");
    // Doctor stays advisory. This is the mutation anchor for "do not flip ok":
    // changing the block to `report.ok = false` fails this.
    expect(report.ok).toBe(true);
  });

  it("adds no advisory when every probed CLI is clean", () => {
    wire({
      codex: { helpExitedNonzero: false, subcommands: { exec: { available: true } } },
      claude: { helpExitedNonzero: false, subcommands: {} },
    });

    const report = createDoctorReport(doctorOptions(true));

    expect(report.next_actions.some(a => a.startsWith("re-probe "))).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("adds no advisory when the probe did not run", () => {
    wire(null);

    const report = createDoctorReport(doctorOptions(false));

    expect(report.next_actions.some(a => a.startsWith("re-probe "))).toBe(false);
  });
});
