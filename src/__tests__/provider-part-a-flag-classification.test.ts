/**
 * Phase 4 Part A: classification of `must_cover` CLI flags that the gateway
 * intentionally does NOT wire as passthrough request fields.
 *
 * The DRY contract forbids silent omission: every non-wired must_cover flag must
 * be backed by a typed capability fact (CLAUDE_UNEXPOSED_CLI_FLAGS /
 * CODEX_UNEXPOSED_CLI_FLAGS in request-helpers.ts) with a closed-taxonomy
 * reason, plus these assertions.
 *
 * Test-veracity: deleting a flag entry from the fact list (i.e. silently
 * dropping it) removes it from the map and flips the "records" assertions red;
 * changing its `reason` to a value outside the closed taxonomy flips the
 * taxonomy assertion red.
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_UNEXPOSED_CLI_FLAGS,
  CODEX_UNEXPOSED_CLI_FLAGS,
  type UnexposedFlagReason,
} from "../request-helpers.js";

const VALID_REASONS: readonly UnexposedFlagReason[] = [
  "interactive-only",
  "gateway-managed",
  "admin-deferred",
];

function reasonOf(
  list: readonly { flag: string; reason: UnexposedFlagReason }[],
  flag: string
): UnexposedFlagReason | undefined {
  return list.find(e => e.flag === flag)?.reason;
}

describe("Phase 4 Part A unexposed-flag classification", () => {
  it("every entry uses the closed reason taxonomy and a non-empty detail", () => {
    for (const entry of [...CLAUDE_UNEXPOSED_CLI_FLAGS, ...CODEX_UNEXPOSED_CLI_FLAGS]) {
      expect(VALID_REASONS).toContain(entry.reason);
      expect(entry.flag.startsWith("--")).toBe(true);
      expect(entry.detail.length).toBeGreaterThan(20);
    }
  });

  it("Claude interactive-only / gateway-managed / admin-deferred flags are recorded", () => {
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--tmux")).toBe("interactive-only");
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--background")).toBe("gateway-managed");
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--remote-control")).toBe("gateway-managed");
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--remote")).toBe("admin-deferred");
  });

  it("Codex TUI-only remote flags are recorded as admin-deferred", () => {
    expect(reasonOf(CODEX_UNEXPOSED_CLI_FLAGS, "--remote")).toBe("admin-deferred");
    expect(reasonOf(CODEX_UNEXPOSED_CLI_FLAGS, "--remote-auth-token-env")).toBe("admin-deferred");
  });

  it("Codex removed-upstream exec flags (--search, --ask-for-approval) are classified", () => {
    // BLOCKER 2: both are must_cover but removed from the installed `codex exec`;
    // the MCP inputs warn + emit no argv. Deleting either entry flips this red.
    expect(reasonOf(CODEX_UNEXPOSED_CLI_FLAGS, "--search")).toBe("admin-deferred");
    expect(reasonOf(CODEX_UNEXPOSED_CLI_FLAGS, "--ask-for-approval")).toBe("admin-deferred");
  });

  it("Claude gateway-owned worktree/resume flags are classified as gateway-managed", () => {
    // BLOCKER 3/4: --worktree (slice λ owns worktrees) and --resume (mapped onto
    // --continue/--session-id) are advertised by claude --help but intentionally
    // never emitted. Deleting either entry flips this red.
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--worktree")).toBe("gateway-managed");
    expect(reasonOf(CLAUDE_UNEXPOSED_CLI_FLAGS, "--resume")).toBe("gateway-managed");
  });

  it("no flag is both wired and classified as unexposed (Claude)", () => {
    // These are the Part A flags that ARE wired as request fields; none of them
    // may also appear in the unexposed list.
    const wired = [
      "--include-hook-events",
      "--replay-user-messages",
      "--system-prompt-file",
      "--append-system-prompt-file",
      "--name",
      "--plugin-dir",
      "--plugin-url",
      "--safe-mode",
      "--bare",
      "--debug",
      "--debug-file",
    ];
    const unexposed = new Set(CLAUDE_UNEXPOSED_CLI_FLAGS.map(e => e.flag));
    for (const flag of wired) expect(unexposed.has(flag)).toBe(false);
  });

  it("no flag is both wired and classified as unexposed (Codex)", () => {
    const wired = [
      "--enable",
      "--disable",
      "--strict-config",
      "--oss",
      "--local-provider",
      "--color",
      "--output-last-message",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
    ];
    const unexposed = new Set(CODEX_UNEXPOSED_CLI_FLAGS.map(e => e.flag));
    for (const flag of wired) expect(unexposed.has(flag)).toBe(false);
  });
});
