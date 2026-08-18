/**
 * Generic provider flag pass-through.
 *
 * n3 of docs/plans/gateway-passthrough-policy.dag.toml, and the precondition
 * the rest of the policy was missing.
 *
 * WHY THIS EXISTS. Before this module there was no way for a caller to send a
 * flag the gateway had not hand-declared as a named Zod field. Discovery could
 * find `--best-of-n` on a customer's grok 0.2.101, report its arity and its
 * value set, and the caller still could not use it, because the tool schema is
 * an implicit allowlist. The schema, not the contract, was the thing pinning
 * capability to what a human had typed. Every other node in the policy is
 * decorative until this exists.
 *
 * WHAT IS ENFORCED, AND WHY EACH ONE IS NOT A CAPABILITY JUDGEMENT.
 *
 * Nothing here decides whether a provider supports a flag. That question is
 * answered by the binary, which is the authority (p1). What is enforced is the
 * `retained_enforcement` set: argv that is malformed, argv that would hang the
 * gateway, and argv that would smuggle an option through a value. Those protect
 * the gateway host and our own output parsing, never the customer from their
 * own CLI.
 *
 * ACCESS MODE SPLITS THE POSTURE. Decided 2026-08-19, following p4/p5:
 *
 *   ON-MACHINE (stdio, local caller). Unrestricted. A local caller can already
 *   run the binary directly in a shell, so a gateway that refuses them a flag
 *   protects nothing and merely makes itself the worse way to reach their own
 *   tool.
 *
 *   OFF-MACHINE (HTTP/OAuth, remote caller). A small deny list, by CLASS rather
 *   than by exact spelling. A remote caller cannot reach the host any other way,
 *   and the gateway already confines them: workspace-confined paths, and the H1
 *   gate in index.ts that rejects host-path and plugin fields outright. Without
 *   the deny list this module would be a hole cut around that shipped control,
 *   since `providerFlags: {"--plugin-dir": "/etc"}` reaches the same CLI
 *   argument the named field is rejected for.
 *
 * THE DENY LIST IS BY PATTERN, DELIBERATELY. An exact list of flag spellings is
 * the wrong shape for a fail-closed control: it is per-provider data, it goes
 * stale on every upstream release, and a miss is a silent approval bypass. The
 * spellings in play today across the installed binaries already include
 * `--yolo`, `--always-approve`, `--auto-approve`, `--approve-for-me`,
 * `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and
 * `--dangerously-bypass-approvals-and-sandbox`, and the next release will
 * invent another. Matching the class catches the one nobody has written yet.
 *
 * Over-refusal off-machine is the intended direction here and costs a remote
 * caller little: the gateway's own curated parameters (`approvalStrategy`,
 * `workingDir` against a registered workspace) still work off-machine with their
 * existing gates. What is refused is the RAW surface, not the capability.
 */
import { sanitizeCliArgValue } from "./request-helpers.js";
import { assertCliArgUtf8Size } from "./cli-input-limits.js";

/** One caller-supplied flag value. `true` emits the flag alone. */
export type PassthroughValue = string | number | boolean | readonly string[];

/** Caller-supplied flags, keyed by the flag exactly as the binary spells it. */
export type PassthroughFlags = Readonly<Record<string, PassthroughValue>>;

/**
 * Flag names the gateway will accept as a key.
 *
 * Shape only. A leading dash is required, and `=` and whitespace are excluded so
 * a caller cannot pack a value into the key and bypass value sanitisation. Both
 * `--long` and `-s` are permitted because the dialects in play disagree: Go's
 * flag package accepts `-model` for what its own help prints as `--model`.
 */
const FLAG_NAME = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Classes refused for OFF-MACHINE callers only, each with the reason it is a
 * host-safety rule rather than a capability judgement.
 *
 * Matched against the flag name with dashes normalised, so `--dangerouslySkip`
 * and `--dangerously-skip` are the same class.
 */
export const OFF_MACHINE_DENIED_CLASSES: readonly {
  readonly id: string;
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  {
    id: "approval-bypass",
    pattern: /yolo|dangerous|bypass|approve|approval|permission|trust/i,
    reason:
      "would let a remote caller disable the approval gate on a CLI running on the gateway host",
  },
  {
    id: "sandbox",
    pattern: /sandbox/i,
    reason: "would let a remote caller weaken or disable the provider's own sandbox",
  },
  {
    id: "host-code-and-config",
    pattern: /mcp-?config|plugin|extension|setting|config|profile/i,
    reason:
      "would load code or configuration from the gateway host, which is the H1 host-path gate's whole subject",
  },
  {
    id: "host-paths",
    pattern: /add-?dir|^cwd$|workdir|working-?dir|worktree|directory/i,
    reason:
      "remote callers are confined to a registered workspace; a raw path flag reopens the host filesystem",
  },
];

/** Why a flag was refused, in a form a caller can act on. */
export interface PassthroughRejection {
  readonly flag: string;
  readonly reason: string;
}

export interface PassthroughResult {
  /** argv tokens to append, in the caller's key order. */
  readonly args: string[];
  /** Flags refused, with the reason. Empty on full acceptance. */
  readonly rejected: readonly PassthroughRejection[];
}

export interface PassthroughOptions {
  /** True for HTTP/OAuth callers. Drives the deny list and nothing else. */
  readonly remote: boolean;
  /** Provider name, for size-limit diagnostics only. */
  readonly provider: string;
  /**
   * argv the gateway has already assembled for this request. A caller may not
   * pass a flag the gateway is emitting itself.
   *
   * This is derived from the request, never from a hand-authored list of
   * "reserved" flags, which would be provider data and would go stale. It
   * protects OUR argv construction and OUR output parsing: two `--output-format`
   * tokens make the response unparseable, and a second `--model` silently wins
   * or loses depending on the dialect.
   */
  readonly alreadyEmitted: readonly string[];
}

/**
 * Turn caller-supplied flags into argv tokens.
 *
 * Emission, for a flag whose arity the gateway does not know:
 *   true          -> `--flag`
 *   string|number -> `--flag`, `value`
 *   string[]      -> `--flag v` per item, REPEATED
 *
 * The repeat form is the honest default for an unknown flag: a CLI that wants a
 * comma-separated list accepts a string the caller can build itself, whereas a
 * CLI that wants repetition cannot be reached from a joined string at all. The
 * gateway does not guess which, because that is a provider fact and no safe
 * probe recovers it.
 *
 * `false` and `undefined` emit nothing, so a caller can pass a flag map with
 * inactive entries rather than building it conditionally.
 */
export function buildPassthroughArgv(
  flags: PassthroughFlags | undefined,
  options: PassthroughOptions
): PassthroughResult {
  const args: string[] = [];
  const rejected: PassthroughRejection[] = [];
  if (!flags) return { args, rejected };

  const emitted = new Set(options.alreadyEmitted);
  for (const [flag, value] of Object.entries(flags)) {
    if (value === false || value === undefined || value === null) continue;

    if (!FLAG_NAME.test(flag)) {
      rejected.push({
        flag,
        reason:
          "not a flag name: expected a leading dash and no '=' or whitespace, e.g. \"--best-of-n\"",
      });
      continue;
    }
    if (emitted.has(flag)) {
      rejected.push({
        flag,
        reason:
          "the gateway is already emitting this flag for this request; use the named parameter instead",
      });
      continue;
    }
    const denied = options.remote ? deniedClassFor(flag) : null;
    if (denied) {
      rejected.push({
        flag,
        reason: `refused for remote HTTP/OAuth callers (${denied.id}): ${denied.reason}. Local stdio callers are unaffected.`,
      });
      continue;
    }

    const values = value === true ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
    let bad = false;
    for (const v of values) {
      try {
        // retained_enforcement.non_option_value_guard: a VALUE must never be
        // parseable as another option. This applies to every caller, local
        // included, because it is argument injection and not capability.
        sanitizeCliArgValue(v, flag);
        assertCliArgUtf8Size(v, { provider: options.provider, inputName: flag });
      } catch (error) {
        rejected.push({ flag, reason: (error as Error).message });
        bad = true;
        break;
      }
    }
    if (bad) continue;

    if (values.length === 0) args.push(flag);
    else for (const v of values) args.push(flag, v);
    emitted.add(flag);
  }
  return { args, rejected };
}

/** The deny class a flag falls into for a remote caller, or null. */
export function deniedClassFor(flag: string): (typeof OFF_MACHINE_DENIED_CLASSES)[number] | null {
  const normalised = flag
    .replace(/^-+/, "")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  for (const cls of OFF_MACHINE_DENIED_CLASSES) {
    if (cls.pattern.test(normalised)) return cls;
  }
  return null;
}
