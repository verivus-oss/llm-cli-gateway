/**
 * Generic provider flag pass-through.
 *
 * The tests are split by WHAT each rule protects, because that is the
 * distinction the whole policy turns on: a rule that protects the gateway host
 * or our own argv is legitimate, and a rule that decides whether a provider
 * supports something is the defect this subsystem exists to remove.
 */
import { describe, expect, it } from "vitest";
import {
  buildPassthroughArgv,
  deniedClassFor,
  OFF_MACHINE_DENIED_CLASSES,
} from "../provider-passthrough.js";

const LOCAL = { remote: false, provider: "grok", alreadyEmitted: [] as string[] };
const REMOTE = { remote: true, provider: "grok", alreadyEmitted: [] as string[] };

describe("pass-through emission", () => {
  it("reaches a flag the gateway has never heard of", () => {
    // The entire point. `--best-of-n` is absent from our reference host and has
    // no named parameter, and a customer on grok 0.2.101 still has it.
    const r = buildPassthroughArgv({ "--best-of-n": "3" }, LOCAL);
    expect(r.args).toEqual(["--best-of-n", "3"]);
    expect(r.rejected).toEqual([]);
  });

  it("emits a boolean flag alone, and skips an inactive one", () => {
    const r = buildPassthroughArgv({ "--verbatim": true, "--minimal": false }, LOCAL);
    expect(r.args).toEqual(["--verbatim"]);
  });

  it("REPEATS a list rather than joining it", () => {
    // For an unknown flag the gateway does not know csv from repeat, and no safe
    // probe recovers it. Repeat is the honest default: a CLI that wants a joined
    // list can be reached by passing the joined string, and a CLI that wants
    // repetition cannot be reached from a joined string at all.
    const r = buildPassthroughArgv({ "--rules": ["a", "b"] }, LOCAL);
    expect(r.args).toEqual(["--rules", "a", "--rules", "b"]);
    expect(buildPassthroughArgv({ "--rules": "a,b" }, LOCAL).args).toEqual(["--rules", "a,b"]);
  });

  it("preserves the caller's key order", () => {
    const r = buildPassthroughArgv({ "--b": "1", "--a": "2" }, LOCAL);
    expect(r.args).toEqual(["--b", "1", "--a", "2"]);
  });
});

describe("what is enforced for EVERY caller (argv, not capability)", () => {
  it("refuses a value that could be parsed as another option", () => {
    // retained_enforcement.non_option_value_guard, and the single most important
    // check in the file. This is argument injection, not capability, so it
    // applies to a local caller too.
    const r = buildPassthroughArgv({ "--rules": "--always-approve" }, LOCAL);
    expect(r.args).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/must not start with/);
  });

  it("refuses a key that packs a value, which would bypass value sanitising", () => {
    const r = buildPassthroughArgv({ "--rules=--always-approve": true }, LOCAL);
    expect(r.args).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/not a flag name/);
  });

  it("refuses a key that is not option-shaped at all", () => {
    // A bare key would become a positional, which for these CLIs is the prompt.
    for (const key of ["bestOfN", "", " --x", "--", "-"]) {
      expect(buildPassthroughArgv({ [key]: "v" }, LOCAL).args, key).toEqual([]);
    }
  });

  it("refuses a flag the gateway is already emitting for this request", () => {
    // Protects OUR argv and OUR parsing, not the customer: two --output-format
    // tokens make the response unparseable. Derived from the assembled argv, so
    // there is no hand-authored list of reserved flags to go stale.
    const r = buildPassthroughArgv(
      { "--output-format": "json" },
      { ...LOCAL, alreadyEmitted: ["--output-format", "json", "--single"] }
    );
    expect(r.args).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/already emitting/);
  });

  it("refuses a duplicate within one request", () => {
    const r = buildPassthroughArgv({ "--x": "1" }, { ...LOCAL, alreadyEmitted: [] });
    expect(r.args).toEqual(["--x", "1"]);
  });

  it("accepts a short flag, because the dialects disagree on spelling", () => {
    // Go's flag package accepts `-model` for what its own help prints as
    // `--model`. Refusing the single-dash form would be the gateway overruling
    // the binary on its own spelling.
    expect(buildPassthroughArgv({ "-p": true }, LOCAL).args).toEqual(["-p"]);
  });
});

describe("access mode is the whole posture", () => {
  it("ON-MACHINE: a local caller is unrestricted", () => {
    // A local caller can run the binary directly in a shell, so refusing them a
    // flag protects nothing and only makes the gateway the worse way to reach
    // their own tool.
    const r = buildPassthroughArgv(
      {
        "--dangerously-skip-permissions": true,
        "--sandbox": "none",
        "--plugin-dir": "/opt/plugins",
        "--yolo": true,
      },
      LOCAL
    );
    expect(r.rejected).toEqual([]);
    expect(r.args).toContain("--dangerously-skip-permissions");
  });

  it("OFF-MACHINE: the same flags are refused, with a reason naming the class", () => {
    for (const flag of ["--dangerously-skip-permissions", "--sandbox", "--plugin-dir", "--yolo"]) {
      const r = buildPassthroughArgv({ [flag]: true }, REMOTE);
      expect(r.args, flag).toEqual([]);
      expect(r.rejected[0].reason, flag).toMatch(/refused for remote HTTP\/OAuth callers/);
    }
  });

  it("OFF-MACHINE: does not become a hole around the shipped H1 host-path gate", () => {
    // H1 in index.ts already rejects host-path and plugin FIELDS for remote
    // principals. A raw flag surface reaches the same CLI argument, so without
    // this the new parameter would quietly undo a control that already ships.
    for (const flag of ["--add-dir", "--cwd", "--plugin-url", "--mcp-config", "--settings"]) {
      expect(buildPassthroughArgv({ [flag]: "/etc" }, REMOTE).args, flag).toEqual([]);
    }
  });

  it("OFF-MACHINE: catches the spelling nobody has invented yet", () => {
    // The reason the deny list is by CLASS. Every one of these is a real
    // spelling in play across the installed binaries today, and they share no
    // common substring an exact list would have generalised from. A list of
    // spellings is per-provider data that goes stale on every upstream release,
    // and a miss is a silent approval bypass rather than a visible error.
    for (const flag of [
      "--yolo",
      "--always-approve",
      "--auto-approve",
      "--approve-for-me",
      "--approve-mcps",
      "--allow-dangerously-skip-permissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--permission-mode",
      "--approval-mode",
      "--trust",
      // Not a real flag anywhere: the point is that an unseen spelling in the
      // same class is refused without anyone adding it.
      "--disable-all-approvals",
    ]) {
      expect(deniedClassFor(flag), flag).not.toBeNull();
    }
  });

  it("OFF-MACHINE: an ordinary capability flag is NOT refused", () => {
    // Over-refusal is the intended direction, but it has to stop somewhere or
    // the remote surface is no surface at all.
    for (const flag of ["--best-of-n", "--effort", "--model", "--max-turns", "--rules"]) {
      expect(deniedClassFor(flag), flag).toBeNull();
    }
  });

  it("every deny class states why it is host safety, not capability", () => {
    for (const cls of OFF_MACHINE_DENIED_CLASSES) {
      expect(cls.id).toMatch(/^[a-z-]+$/);
      expect(cls.reason.length).toBeGreaterThan(30);
    }
  });
});
