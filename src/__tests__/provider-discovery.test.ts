/**
 * Discovery source 1: shell completions.
 *
 * The parsing tests run on captured fixtures so they are deterministic and
 * offline. The LIVE probes against the installed binaries are opt-in via
 * DISCOVERY_LIVE=1, because a test suite that spawns seven CLIs is neither
 * hermetic nor fast, and CI has none of them installed.
 *
 * Fixtures are deliberately verbatim excerpts of real output from grok 1.0.4
 * and codex-cli 0.147.0. A hand-written approximation of a completion script
 * would test the approximation, and the two real CLIs disagree in exactly the
 * way that matters (see the separator note below).
 */
import { describe, expect, it } from "vitest";
import {
  allFlags,
  buildProbeArgv,
  interpretProbeOutput,
  parseClapBashCompletion,
} from "../provider-discovery.js";

/**
 * grok 1.0.4: explicit `__subcmd__` separator, so the command path is exact.
 * Includes `--compaction-mode` and `--reasoning-effort`, both of which are
 * ABSENT from `grok --help` and are the reason completions are source 1.
 */
const GROK_FIXTURE = `
_grok() {
    case "\${cmd},\${i}" in
            ",$1")
                cmd="grok"
                ;;
            grok,agent)
                cmd="grok__subcmd__agent"
                ;;
    esac
    case "\${cmd}" in
        grok)
            opts="-p -h --output-format --effort --reasoning-effort --compaction-mode --compaction-detail --help [PROMPT] agent models"
            ;;
        grok__subcmd__agent)
            opts="-m -h --model --leader-socket --help stdio headless"
            ;;
    esac
}
`;

/**
 * codex-cli 0.147.0: bare `__` separator, which ALSO stands in for a dash
 * inside a command name. `codex__app__server__daemon` cannot be distinguished
 * from a path of four commands, so the path is reported ambiguous rather than
 * guessed.
 */
const CODEX_FIXTURE = `
_codex() {
    case "\${cmd}" in
        codex)
            opts="-c -h --config --enable --help exec apply"
            ;;
        codex__app__server)
            opts="-h --listen --stdio --help"
            ;;
    esac
}
`;

describe("completions parsing", () => {
  it("extracts the root command's flags and subcommands", () => {
    const cmds = parseClapBashCompletion(GROK_FIXTURE, "grok");
    expect(cmds).not.toBeNull();
    const root = cmds!.find(c => c.path.length === 0)!;
    expect(root.flags).toContain("--output-format");
    expect(root.shortFlags).toContain("-p");
    expect(root.subcommands).toEqual(["agent", "models"]);
  });

  it("recovers flags that the CLI hides from --help", () => {
    // The whole reason completions are source 1. These four are absent from
    // `grok --help` output and one of them (`--effort`) is where a
    // hand-maintained contract had invented an enum the binary does not have.
    const flags = allFlags(parseClapBashCompletion(GROK_FIXTURE, "grok")!);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--compaction-mode",
        "--compaction-detail",
        "--effort",
        "--reasoning-effort",
      ])
    );
  });

  it("attributes flags to the subcommand that accepts them", () => {
    const cmds = parseClapBashCompletion(GROK_FIXTURE, "grok")!;
    const agent = cmds.find(c => c.path.join(" ") === "agent")!;
    expect(agent.pathConfidence).toBe("exact");
    expect(agent.flags).toContain("--leader-socket");
    // Attribution is the point: a root-only flag must not leak into a subcommand.
    expect(agent.flags).not.toContain("--output-format");
  });

  it("marks a path ambiguous rather than guessing, when the encoding is lossy", () => {
    const cmds = parseClapBashCompletion(CODEX_FIXTURE, "codex")!;
    const sub = cmds.find(c => c.path.length > 0)!;
    expect(sub.pathConfidence).toBe("ambiguous");
    // The FLAG SET is still exact, which is what the argv builder consumes.
    expect(sub.flags).toContain("--listen");
  });

  it("separates positionals and subcommands from flags", () => {
    const cmds = parseClapBashCompletion(GROK_FIXTURE, "grok")!;
    const root = cmds.find(c => c.path.length === 0)!;
    // `[PROMPT]` is a positional placeholder, not a capability a caller passes.
    expect(root.flags).not.toContain("[PROMPT]");
    expect(root.subcommands).not.toContain("[PROMPT]");
    expect(root.flags.every(f => f.startsWith("--"))).toBe(true);
  });

  it("returns null for text that is not a clap completion, rather than empty", () => {
    // CONTROL, and load-bearing under fail-open: "could not parse" and "parsed,
    // and the flag is absent" are different facts. Only the second is evidence
    // about the binary. Returning [] for unparseable input would silently
    // convert the first into the second.
    expect(parseClapBashCompletion("I don't see a task in your message.", "claude")).toBeNull();
    expect(parseClapBashCompletion("", "grok")).toBeNull();
  });
});

/**
 * Source 3: the invalid-value probe.
 *
 * Fixtures are verbatim stderr from grok 1.0.4, captured by running the probes
 * this module generates. Every one exited 2, i.e. argument-parsing failure, so
 * nothing dispatched.
 */
describe("invalid-value probe", () => {
  const ABSENT = "error: unexpected argument '--not-a-real-flag' found\n\nUsage: grok [OPTIONS]";
  const ENUM =
    "error: invalid value 'ZZZ' for '--permission-mode <MODE>'\n" +
    "  [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]";
  const ACCEPTED = "error: a value is required for '--single <PROMPT>' but none was supplied";

  it("reports a flag the binary rejects as absent", () => {
    expect(interpretProbeOutput(ABSENT)).toEqual({ kind: "absent" });
  });

  it("recovers the real value set when the binary enumerates one", () => {
    const v = interpretProbeOutput(ENUM);
    expect(v.kind).toBe("present");
    expect(v.kind === "present" && v.values).toEqual([
      "default",
      "acceptEdits",
      "auto",
      "dontAsk",
      "bypassPermissions",
      "plan",
    ]);
  });

  it("reports a flag that accepted an arbitrary value as having NO value set", () => {
    // This is the verdict that would have prevented the grok --effort defect:
    // the contract asserted a five-level enum for a flag the binary does not
    // constrain, and `values` is enforced as a rejection list.
    const v = interpretProbeOutput(ACCEPTED);
    expect(v).toEqual({ kind: "present", values: null });
  });

  it("CONTROL: the enum message outranks the missing-value message", () => {
    // clap reports an enum violation IN PREFERENCE TO the missing-value error,
    // so for a constrained flag the enum message is what comes back. Without
    // this control, "an error was produced" would read as "the flag was
    // rejected", and every constrained flag would be misclassified as absent.
    expect(interpretProbeOutput(ENUM).kind).toBe("present");
    expect(interpretProbeOutput(ABSENT).kind).toBe("absent");
  });

  it("keeps unparsed distinct from absent", () => {
    // Load-bearing under fail-open. `absent` is evidence about the binary;
    // `unparsed` is evidence about our parser. Collapsing the second into the
    // first is how a discovery system silently removes capability.
    expect(interpretProbeOutput("").kind).toBe("unparsed");
    expect(interpretProbeOutput("error: invalid value 'ZZZ' for '--x <X>'").kind).toBe("unparsed");
  });

  it("SAFETY: probe argv can never form a runnable invocation", () => {
    // Structural, not a convention to remember. The headless flag is emitted
    // with NO value, so the CLI fails at argument parsing before dispatch.
    // `claude completion` reached the model during this work because
    // `completion` parsed as a prompt, turning an enumeration into a billed
    // inference call.
    const argv = buildProbeArgv("--effort", "--single");
    expect(argv.at(-1)).toBe("--single");
    // Nothing follows the headless flag, so its required value is missing.
    expect(argv.filter(a => a === "--single")).toHaveLength(1);
    expect(argv).toEqual(["--effort", "ZZZ_GATEWAY_PROBE", "--single"]);
  });
});
