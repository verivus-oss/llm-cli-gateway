import { describe, it, expect } from "vitest";
import { getProviderDefinition } from "../provider-definitions.js";
import {
  acpMethodAvailability,
  discoverAllProviders,
  discoverProviderCapabilities,
  discoveryContractDrift,
  parseAcpInitialize,
  type DiscoveryOptions,
  type ProbeResult,
  type ProbeRunner,
} from "../provider-capability-discovery.js";

/**
 * A configurable fake probe runner. Keyed by `"<exe> <argv...>"`. Missing keys
 * return empty output (a provider probe that produced nothing). An `Error`
 * value is thrown to simulate an unavailable binary. Mutating the config object
 * between discovery calls reprojects every derived surface with ZERO source
 * edits: this is the whole point of the injection seam.
 */
function makeRunner(config: Record<string, string | Error>): ProbeRunner {
  return async (exe, argv): Promise<ProbeResult> => {
    const key = `${exe} ${argv.join(" ")}`.trim();
    const canned = config[key];
    if (canned === undefined) return { stdout: "", stderr: "", code: 0 };
    if (canned instanceof Error) throw canned;
    return { stdout: canned, stderr: "", code: 0 };
  };
}

const GROK_ROOT_HELP = `Usage: grok [OPTIONS] [COMMAND]

Options:
  -m, --model <MODEL>          Model ID to use
      --effort <EFFORT>        Reasoning effort [possible values: low, medium, high]
      --always-approve         Auto-approve all tool executions
      --resume                 Resume the previous session
      --add-dir <DIR>...       Additional workspace directory

Commands:
  models    List available models
  agent     Run Grok without the interactive UI
  sessions  Manage sessions
  help      Print this message
`;

const GROK_MODELS = `grok-build-0.1\ngrok-4\n`;

function grokAcpInitialize(methods: readonly string[], protocolVersion = 1): string {
  return JSON.stringify({
    protocolVersion,
    agentInfo: { name: "Grok", version: "0.2.77" },
    authMethods: ["oauth"],
    promptCapabilities: ["text", "image"],
    mcpCapabilities: ["stdio", "http"],
    sessionCapabilities: ["new", "load", "cancel"],
    methods,
  });
}

function grokConfig(
  overrides: Partial<Record<string, string | Error>> = {}
): Record<string, string | Error> {
  return {
    "grok --version": "grok 0.2.77 (44e77bec3a)",
    "grok --help": GROK_ROOT_HELP,
    "grok agent --help":
      "Run Grok without the interactive UI\n\nOptions:\n  -h, --help  Print help\n",
    "grok mcp --help": "Manage MCP servers\n\nOptions:\n  -h, --help  Print help\n",
    "grok sessions --help": "Manage sessions\n\nOptions:\n  -h, --help  Print help\n",
    "grok models": GROK_MODELS,
    "grok agent stdio --help": grokAcpInitialize([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
    ]),
    ...overrides,
  };
}

const baseOptions = (config: Record<string, string | Error>): DiscoveryOptions => ({
  runner: makeRunner(config),
  gatewayVersion: "test-gw-1.0.0",
  resolveExecutablePath: () => "/abs/bin/grok",
});

describe("provider-capability-discovery", () => {
  // Acceptance 1: startup discovery gathers version, root help, subcommand help,
  // model catalog, and ACP capability data where available.
  it("gathers version, root help, subcommand help, model catalog, and ACP data", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(def, baseOptions(grokConfig()));

    expect(set.status).toBe("ok");
    expect(set.version).toBe("grok 0.2.77 (44e77bec3a)");
    expect(set.rootHelp.flags.map(f => f.name)).toContain("--model");
    expect(Object.keys(set.subcommandHelp)).toContain("agent --help");
    expect(set.modelCatalog.raw).toContain("grok-build-0.1");
    expect(set.acpInitialize?.knownMethods).toContain("session/prompt");
    // Evidence records what was probed, without secrets.
    expect(set.sourceEvidence.some(e => e.startsWith("version:"))).toBe(true);
    expect(set.sourceEvidence.some(e => e.startsWith("acp-initialize:"))).toBe(true);
  });

  it("discoverAllProviders is fault-isolated (a missing binary never rejects the batch)", async () => {
    const sets = await discoverAllProviders({
      runner: makeRunner({}), // every probe returns empty; version present but blank
      gatewayVersion: "test-gw-1.0.0",
      resolveExecutablePath: exe => `/abs/bin/${exe}`,
    });
    // One entry per provider definition, none rejected.
    expect(sets.size).toBeGreaterThanOrEqual(7);
    for (const set of sets.values()) {
      expect(["ok", "degraded", "error"]).toContain(set.status);
    }
  });

  // Acceptance 5: adding only a fake help subcommand yields a captured
  // provider-subcommand (name + description + checksum) available for projection.
  it("adding only a fake help subcommand surfaces it as a discovered subcommand", async () => {
    const withNewSub = GROK_ROOT_HELP.replace(
      "  help      Print this message",
      "  worktree  Manage git worktrees\n  help      Print this message"
    );
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      baseOptions(grokConfig({ "grok --help": withNewSub }))
    );
    const worktree = set.rootHelp.subcommands.find(s => s.name === "worktree");
    expect(worktree).toBeDefined();
    expect(worktree?.description).toBe("Manage git worktrees");
    expect(worktree?.helpChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  // Acceptance 6: adding only a fake ACP initialize capability updates provider
  // ACP availability + generic ACP method availability, no source edits.
  it("adding only a fake ACP initialize method updates ACP method availability", async () => {
    const def = getProviderDefinition("grok");
    const before = await discoverProviderCapabilities(def, baseOptions(grokConfig()));
    expect(acpMethodAvailability(before).knownMethods).not.toContain("session/set_mode");

    const after = await discoverProviderCapabilities(
      def,
      baseOptions(
        grokConfig({
          "grok agent stdio --help": grokAcpInitialize([
            "initialize",
            "session/new",
            "session/prompt",
            "session/cancel",
            "session/set_mode",
          ]),
        })
      )
    );
    const availability = acpMethodAvailability(after);
    expect(availability.acpAvailable).toBe(true);
    expect(availability.knownMethods).toContain("session/set_mode");
    // The ACP initialize checksum changed, so the cache key must change too.
    expect(after.checksums.acpInitialize).not.toBe(before.checksums.acpInitialize);
  });

  // Acceptance 7: discovered-but-unmapped flags AND ACP extension methods are
  // reported with evidence (raw + checksum + reason), not hidden.
  it("reports unmapped flags and ACP extension methods with evidence", async () => {
    // A non-ASCII flag token cannot be mapped; an unknown ACP method is an
    // extension method with no spec schema.
    const weirdHelp = GROK_ROOT_HELP.replace(
      "  -m, --model <MODEL>          Model ID to use",
      "  -m, --model <MODEL>          Model ID to use\n  --\u{1F4A5}weird-flag           Does something unmappable"
    );
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      baseOptions(
        grokConfig({
          "grok --help": weirdHelp,
          "grok agent stdio --help": grokAcpInitialize([
            "initialize",
            "session/prompt",
            "grok/telepathy", // extension method not in the ACP spec
          ]),
        })
      )
    );

    const weirdFlag = set.discoveredUnmapped.find(u => u.kind === "flag");
    expect(weirdFlag).toBeDefined();
    expect(weirdFlag?.raw).toContain("weird-flag");
    expect(weirdFlag?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(weirdFlag?.reason.length).toBeGreaterThan(0);

    const extension = set.discoveredUnmapped.find(u => u.kind === "acp-method");
    expect(extension?.raw).toBe("grok/telepathy");
    expect(extension?.reason).toMatch(/not known to the ACP spec/);
    expect(set.acpInitialize?.extensionMethods).toContain("grok/telepathy");
    expect(set.acpInitialize?.knownMethods).not.toContain("grok/telepathy");
  });

  it("degrades (not error) when a non-identity probe fails but version resolves", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      baseOptions(grokConfig({ "grok models": new Error("ENOENT") }))
    );
    expect(set.status).toBe("degraded");
    expect(set.degradedReason).toMatch(/model catalog probe failed/);
  });

  it("returns an error set when the version (identity) probe fails", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      baseOptions(grokConfig({ "grok --version": new Error("ENOENT") }))
    );
    expect(set.status).toBe("error");
    expect(set.version).toBe("");
    expect(set.degradedReason).toMatch(/version probe failed/);
  });

  it("parseAcpInitialize returns kind 'none' for non-JSON help text", () => {
    const parsed = parseAcpInitialize("Run the agent over stdio\n\nOptions:\n  -h, --help\n");
    expect(parsed.kind).toBe("none");
  });

  // B3: an ACP initialize response that LOOKS like JSON but is malformed is a
  // validation failure (kind 'invalid'), surfaced by discovery as degraded, not
  // a crash. Non-JSON help text stays 'none' (normal, not degraded).
  it("parseAcpInitialize returns kind 'invalid' for malformed JSON-ish output", () => {
    const truncated = parseAcpInitialize('{"protocolVersion": 1, "methods": [');
    expect(truncated.kind).toBe("invalid");
    if (truncated.kind === "invalid") expect(truncated.reason).toMatch(/not valid JSON/);

    const wrongShape = parseAcpInitialize('{"protocolVersion": {"nested": "object"}}');
    // protocolVersion must be a number|string; an object fails validation.
    expect(wrongShape.kind).toBe("invalid");
  });

  it("degrades discovery when the ACP initialize response is malformed JSON", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      baseOptions(grokConfig({ "grok agent stdio --help": '{"protocolVersion": 1, "methods": [' }))
    );
    expect(set.status).toBe("degraded");
    expect(set.degradedReason).toMatch(/acp initialize invalid/);
    expect(set.acpInitialize).toBeNull();
  });

  it("passes through unknown ACP extension methods while validating known shape", () => {
    const parsed = parseAcpInitialize(
      JSON.stringify({
        result: {
          protocolVersion: 1,
          methods: ["initialize", "session/prompt", "grok/telepathy"],
        },
      })
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.value.knownMethods).toContain("session/prompt");
      expect(parsed.value.extensionMethods).toEqual(["grok/telepathy"]);
    }
  });

  it("surfaces installed-vs-contract mismatch as a discovery event", () => {
    const def = getProviderDefinition("grok");
    return discoverProviderCapabilities(def, baseOptions(grokConfig())).then(set => {
      const drift = discoveryContractDrift(set);
      expect(drift.cli).toBe("grok");
      expect(drift.contractTargetVersion).toBe("grok 0.2.77 (44e77bec3a)");
      expect(drift.versionMatchesContract).toBe(true);
      expect(["clean", "drift"]).toContain(drift.status);
    });
  });
});
