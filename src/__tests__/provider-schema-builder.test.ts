import { describe, it, expect } from "vitest";
import { getProviderDefinition } from "../provider-definitions.js";
import {
  discoverProviderCapabilities,
  type ProbeRunner,
} from "../provider-capability-discovery.js";
import { buildProviderSchema, flagToFieldName } from "../provider-schema-builder.js";

function makeRunner(config: Record<string, string>): ProbeRunner {
  return async (exe, argv) => {
    const key = `${exe} ${argv.join(" ")}`.trim();
    return { stdout: config[key] ?? "", stderr: "", code: 0 };
  };
}

/**
 * Discover claude with a synthetic root help. Only the help text is varied per
 * test, so a newly-added flag reprojects into a request field with zero source
 * edits (the schema is derived purely from the discovered set).
 */
async function schemaFor(rootHelp: string) {
  const def = getProviderDefinition("claude");
  const set = await discoverProviderCapabilities(def, {
    runner: makeRunner({
      "claude --version": "2.1.198 (Claude Code)",
      "claude --help": rootHelp,
    }),
    gatewayVersion: "test-gw-1.0.0",
    resolveExecutablePath: () => "/abs/bin/claude",
  });
  return buildProviderSchema(set);
}

const BASE_HELP = `Usage: claude [options]

Options:
  -h, --help  Print help
`;

describe("provider-schema-builder", () => {
  it("derives camelCase field names from flags", () => {
    expect(flagToFieldName("--fork-session")).toBe("forkSession");
    expect(flagToFieldName("--model")).toBe("model");
    expect(flagToFieldName("-m")).toBe("m");
    expect(flagToFieldName("--add-dir")).toBe("addDir");
  });

  // Acceptance 4: adding ONLY a fake help flag produces a discovered
  // safely-mapped request field when arity/type/safety are inferable.
  it("maps a newly discovered string-valued flag to a request field", async () => {
    const projection = await schemaFor(`${BASE_HELP}      --model <MODEL>  Model selector\n`);
    const model = projection.fields.find(f => f.flag === "--model");
    expect(model).toBeDefined();
    expect(model?.name).toBe("model");
    expect(model?.zodType).toBe("string");
    expect(model?.argvPlacement).toBe("flag-then-value");
    expect(model?.safety).toBe("safe");
  });

  it("infers enum, number, boolean, and repeatable array field types", async () => {
    const projection = await schemaFor(
      `${BASE_HELP}` +
        "      --effort <EFFORT>  Reasoning effort [possible values: low, medium, high]\n" +
        "      --max-turns <N>    Turn cap\n" +
        "      --fork-session     Fork the current session\n" +
        "      --add-dir <DIR>... Additional workspace directory (repeatable)\n"
    );
    const byFlag = (flag: string) => projection.fields.find(f => f.flag === flag);

    expect(byFlag("--effort")?.zodType).toBe("enum");
    expect(byFlag("--effort")?.enumValues).toEqual(["low", "medium", "high"]);
    expect(byFlag("--max-turns")?.zodType).toBe("number");
    expect(byFlag("--fork-session")?.zodType).toBe("boolean");
    expect(byFlag("--fork-session")?.argvPlacement).toBe("flag");
    expect(byFlag("--add-dir")?.zodType).toBe("string-array");
    expect(byFlag("--add-dir")?.repeatable).toBe(true);
  });

  it("flags a dangerous flag's safety class from its name/description", async () => {
    const projection = await schemaFor(
      `${BASE_HELP}      --dangerously-skip-permissions  Auto-approve everything\n`
    );
    const flag = projection.fields.find(f => f.flag === "--dangerously-skip-permissions");
    expect(flag?.safety).toBe("dangerous");
    expect(flag?.zodType).toBe("boolean");
  });

  // Acceptance 7 (schema level): a flag whose value type cannot be inferred is a
  // discovered-unmapped descriptor, NOT a fabricated request field.
  it("routes an un-typeable valued flag to discovered-unmapped, not a field", async () => {
    const projection = await schemaFor(
      `${BASE_HELP}      --weird <a@b>  Un-typeable placeholder\n`
    );
    expect(projection.fields.find(f => f.flag === "--weird")).toBeUndefined();
    const unmapped = projection.discoveredUnmapped.find(u => u.raw.includes("--weird"));
    expect(unmapped).toBeDefined();
    expect(unmapped?.kind).toBe("flag");
    expect(unmapped?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(unmapped?.reason).toMatch(/could not be inferred/);
  });
});
