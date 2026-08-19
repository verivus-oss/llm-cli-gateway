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
  assertProbeArgvCannotRun,
  buildProbeArgv,
  deriveProbeAnchor,
  isProbeSafeFlag,
  interpretProbeOutput,
  parseClapBashCompletion,
  scrapeCandidateFlags,
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
    expect(v.kind === "present" && v.arity).toBe("one");
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
    expect(v).toEqual({ kind: "present", arity: "one", values: null });
  });

  it("distinguishes a BOOLEAN flag from a value-taking one", () => {
    // Only the inline `=` form surfaces this. The space form consumes the
    // sentinel as a positional, so a boolean and a value-taking flag produce
    // byte-identical stderr and arity is unrecoverable. Verbatim from grok 1.0.4.
    const BOOLEAN =
      "error: unexpected value 'ZZZ' for '--always-approve' found; no more were expected";
    expect(interpretProbeOutput(BOOLEAN)).toEqual({
      kind: "present",
      arity: "none",
      values: null,
    });
  });

  it("SAFETY: probe argv contains no bare token that could become a prompt", () => {
    // The real invariant, and the one the `claude completion` billing incident
    // violated: `completion` was a bare token, so it was consumed as a
    // POSITIONAL and became a prompt that reached the model. A token that does
    // not start with `-` is the only thing that can turn a probe into a real
    // invocation.
    for (const token of buildProbeArgv("--effort", "--single")) {
      expect(token.startsWith("-"), `bare token ${token}`).toBe(true);
    }
    expect(buildProbeArgv("--effort", "--single")).toEqual([
      "--effort=ZZZ_GATEWAY_PROBE",
      "--single",
    ]);
  });

  it("SAFETY: refuses to build argv containing a bare token", () => {
    expect(() => assertProbeArgvCannotRun(["--effort=ZZZ", "completion"])).toThrow(
      /not option-shaped/
    );
    expect(() => assertProbeArgvCannotRun(["--effort=ZZZ", "--single"])).not.toThrow();
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

    // NOTE the boundary moved when arity detection landed. An "invalid value"
    // message with no enumerated set is NOT unparsed: it proves the flag exists
    // and takes a value, which is strictly more than we could say before. Only
    // the value SET is unknown.
    //
    // So `values: null` now carries two distinguishable meanings, "no enum" and
    // "enum exists but was not disclosed". They are deliberately not separated
    // in the type, because under fail-open both mean DO NOT ENFORCE and the
    // behavioural consequence is identical. The difference affects guidance
    // quality only, and inventing a distinction with no behavioural effect
    // would be modelling for its own sake.
    const undisclosed = interpretProbeOutput("error: invalid value 'ZZZ' for '--x <X>'");
    expect(undisclosed).toEqual({ kind: "present", arity: "one", values: null });
  });

  it("ABSENCE IS NEVER SUBTRACTIVE: the n1-restored flags probe as absent HERE", () => {
    // The single most important behaviour in this subsystem.
    //
    // Measured on this host 2026-08-18: grok --best-of-n, grok --check and
    // devin --agent-config all return "unexpected argument", i.e. ABSENT, by
    // the strongest signal available. They are also absent from completions and
    // from --help. They are exactly the three capabilities n1 restored, because
    // customers on older CLIs still have them.
    //
    // So a pipeline that trusts its own absence verdict deletes them again,
    // with better evidence than the rebaseliner ever had, for the same wrong
    // reason: the question is not "is it on this machine".
    //
    // This test pins the INPUT half. The merge must treat `absent` as
    // non-subtractive; see the absence-is-never-subtractive invariant in
    // docs/plans/gateway-passthrough-policy.dag.toml.
    const ABSENT_HERE = "error: unexpected argument '--best-of-n' found";
    expect(interpretProbeOutput(ABSENT_HERE)).toEqual({ kind: "absent" });
  });
});

/**
 * Discovery source 2: the help-text scrape.
 *
 * Fixtures are verbatim excerpts of real `--help` output captured 2026-08-18,
 * chosen for the two things a hand-written approximation would smooth over: agy
 * writes its usage to STDERR in Go `flag` style, and vibe wraps a flag name
 * across a line break mid-token.
 */
const AGY_HELP_STDERR_FIXTURE = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
`;

const VIBE_HELP_WRAPPED_FIXTURE = `  -p, --prompt [TEXT]   Run in programmatic mode: send prompt, output
                        response, and exit. Tool approval follows the selected
                        --agent (or 'default_agent' config); pass --auto-
                        approve or --yolo to allow all tool calls.
  --max-turns N         Maximum number of assistant turns (only applies in
`;

describe("help scrape", () => {
  it("nominates every long flag written in the text", () => {
    expect(scrapeCandidateFlags(AGY_HELP_STDERR_FIXTURE)).toEqual([
      "--add-dir",
      "--agent",
      "--continue",
    ]);
  });

  it("reads flags out of prose, not only out of a usage column", () => {
    // `--yolo` appears ONLY in a sentence here. A help parser that understood
    // the format would attribute it to nothing and drop it; the scrape does not
    // understand the format, which is why it keeps it.
    expect(scrapeCandidateFlags(VIBE_HELP_WRAPPED_FIXTURE)).toContain("--yolo");
  });

  it("OVER-COLLECTION IS THE DESIGN: a line-wrapped token still nominates", () => {
    // vibe wraps `--auto-approve` after the hyphen. The scrape yields `--auto`,
    // which is not a flag. That costs one probe, comes back `absent`, and under
    // absence-is-never-subtractive removes nothing. Missing a REAL flag is the
    // failure that matters, and this direction of error is the safe one.
    const candidates = scrapeCandidateFlags(VIBE_HELP_WRAPPED_FIXTURE);
    expect(candidates).toContain("--auto");
    expect(candidates).not.toContain("--auto-");
  });

  it("does not nominate a bare end-of-options marker", () => {
    expect(scrapeCandidateFlags("run -- everything after is positional")).toEqual([]);
  });

  it("does not nominate short flags, which the probe cannot safely adjudicate", () => {
    expect(scrapeCandidateFlags("  -p, --print   run once")).toEqual(["--print"]);
  });

  it("deduplicates and sorts, so the probe runs once per distinct candidate", () => {
    expect(scrapeCandidateFlags("--model x --agent y --model z")).toEqual(["--agent", "--model"]);
  });

  it("EMPTY IS NOT ABSENT: no candidates is a fact about the text, not the binary", () => {
    // The caller must not record this as "the binary has no flags". agy on
    // stdout alone produces exactly this, and it has 20 flags.
    expect(scrapeCandidateFlags("")).toEqual([]);
  });

  it("STREAM TRAP: agy's help is on stderr, so a stdout-only read finds nothing", () => {
    const stdout = "";
    const stderr = AGY_HELP_STDERR_FIXTURE;
    expect(scrapeCandidateFlags(stdout)).toEqual([]);
    expect(scrapeCandidateFlags(stdout + stderr).length).toBeGreaterThan(0);
  });
});

/**
 * Discovery source 3, the other three dialects.
 *
 * Every string here is verbatim stderr from the installed binaries, captured
 * 2026-08-18. The interpreter matches on the MESSAGE, never on which provider
 * produced it, so these are dialect tests and not provider tests.
 */
describe("probe interpretation across dialects", () => {
  it("argparse: recovers the real value set", () => {
    // vibe --output=ZZZ --agent
    const v = interpretProbeOutput(
      "vibe: error: argument --output: invalid choice: 'ZZZ' (choose from 'text', 'json', 'streaming')"
    );
    expect(v).toEqual({ kind: "present", arity: "one", values: ["text", "json", "streaming"] });
  });

  it("argparse: a boolean given a value reads as arity none", () => {
    // vibe --yolo=ZZZ --agent
    expect(
      interpretProbeOutput(
        "vibe: error: argument --auto-approve/--yolo: ignored explicit argument 'ZZZ'"
      )
    ).toEqual({ kind: "present", arity: "none", values: null });
  });

  it("argparse: an unknown flag reads as absent", () => {
    expect(interpretProbeOutput("vibe: error: unrecognized arguments: --not-real-xyz=ZZZ")).toEqual(
      { kind: "absent" }
    );
  });

  it("Go flag: an unknown flag reads as absent", () => {
    expect(interpretProbeOutput("flags provided but not defined: -not-real-xyz")).toEqual({
      kind: "absent",
    });
  });

  it("commander: an unknown flag reads as absent", () => {
    expect(interpretProbeOutput("error: unknown option '--not-real-xyz'")).toEqual({
      kind: "absent",
    });
  });

  it("clap reaching the anchor PROVES the flag parsed clean", () => {
    // clap validates left to right and reports the first failure, so the
    // anchor's error can only surface once the flag under test was accepted.
    // Measured on grok: --permission-mode and --not-real-xyz never get here.
    expect(
      interpretProbeOutput("error: a value is required for '--model <MODEL>' but none was supplied")
    ).toEqual({ kind: "present", arity: "one", values: null });
  });

  it("THE ANCHOR MASK: the other three dialects reaching the anchor proves NOTHING", () => {
    // The defect this test exists to pin. argparse, Go flag and commander
    // report an unknown flag LAST, after the missing-argument check, so the
    // anchor error is what comes back for a real flag and a fictional one
    // alike. Measured on agy, where these three return byte-identical stderr:
    //
    //   agy --effort=ZZZ --model        -> flag needs an argument: -model
    //   agy --mode=ZZZ --model          -> flag needs an argument: -model
    //   agy --not-real-xyz=ZZZ --model  -> flag needs an argument: -model
    //
    // Reading that as `present` fabricates arity for a flag that does not
    // exist, which is what happened to every agy candidate before this was
    // measured. `unparsed` is the only honest verdict.
    for (const anchorError of [
      "flag needs an argument: -model", // Go flag
      "vibe: error: argument --agent: expected one argument", // argparse
      "error: option '--model <model>' argument missing", // commander
    ]) {
      expect(interpretProbeOutput(anchorError).kind, anchorError).toBe("unparsed");
    }
  });

  it("declines to guess on a message it does not recognise", () => {
    // Fail-open still offers the flag; what it must not do is invent arity.
    expect(interpretProbeOutput("error: something entirely new").kind).toBe("unparsed");
  });
});

describe("deriveProbeAnchor", () => {
  it("takes an angle-bracket placeholder, which means the value is REQUIRED", () => {
    expect(deriveProbeAnchor("  -m, --model <MODEL>   Pick one\n")).toBe("--model");
  });

  it("takes a bare uppercase metavar, which argparse also requires", () => {
    expect(deriveProbeAnchor("  --agent NAME          Agent to use\n")).toBe("--agent");
  });

  it("REFUSES a square-bracket placeholder, whose value is optional", () => {
    // `--worktree [NAME]` omitted is legal, so the probe would RUN the CLI.
    expect(deriveProbeAnchor("  --worktree [NAME]     Run inside a worktree\n")).toBeNull();
  });

  it("does not mistake a capitalised description word for a metavar", () => {
    // The real hazard is ONE space then a capitalised word, which is exactly how
    // a metavar is spaced. Only the all-caps requirement separates them, so the
    // input has to be single-spaced or the test proves nothing.
    expect(deriveProbeAnchor("  --dry-run Perform a trial run\n")).toBeNull();
    expect(deriveProbeAnchor("  --workdir DIR Change to this directory\n")).toBe("--workdir");
  });

  it("refuses an anchor that could DO something", () => {
    expect(deriveProbeAnchor("  --login <TOKEN>   Sign in\n")).toBeNull();
  });

  it("excludes the flag under test, so a flag is never its own anchor", () => {
    const help = "  --model <M>  x\n  --agent <A>  y\n";
    expect(deriveProbeAnchor(help)).toBe("--agent");
    expect(deriveProbeAnchor(help, ["--agent"])).toBe("--model");
  });

  it("returns null for help that prints no placeholder at all", () => {
    // agy, a Go flag binary. No anchor means the provider is recorded as
    // unprobeable, never probed with a guessed anchor.
    expect(deriveProbeAnchor("  --effort   Reasoning effort\n  --model    Model\n")).toBeNull();
  });

  it("is deterministic, so a regenerated seed is diffable", () => {
    const help = "  --zulu <Z>  z\n  --alpha <A>  a\n  --mike <M>  m\n";
    expect(deriveProbeAnchor(help)).toBe("--alpha");
  });
});

describe("isProbeSafeFlag", () => {
  it("refuses action-class flags, because commander accepts and ignores a value", () => {
    for (const flag of ["--update", "--logout", "--reauthenticate", "--uninstall", "--reset"]) {
      expect(isProbeSafeFlag(flag), flag).toBe(false);
    }
  });

  it("allows an ordinary flag", () => {
    expect(isProbeSafeFlag("--output-format")).toBe(true);
  });
});
