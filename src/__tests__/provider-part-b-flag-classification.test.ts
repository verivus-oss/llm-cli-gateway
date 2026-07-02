/**
 * Phase 4 Part B: classification of Gemini / Mistral `must_cover` CLI flags that
 * the gateway intentionally does NOT wire as passthrough request fields.
 *
 * The DRY contract forbids silent omission: every non-wired must_cover flag must
 * be backed by a typed capability fact (GEMINI_UNEXPOSED_CLI_FLAGS /
 * MISTRAL_UNEXPOSED_CLI_FLAGS in request-helpers.ts) with a closed-taxonomy
 * reason, plus these assertions. Grok has zero non-wired must_cover flags, so it
 * has no unexposed list; Devin's five non-wired flags are carried in the devin
 * contract's `acknowledgedUpstreamFlags` (upstream-contracts.ts).
 *
 * Test-veracity: deleting a flag entry from a fact list (i.e. silently dropping
 * it) removes it from the map and flips the "records" assertions red; changing
 * its `reason` to a value outside the closed taxonomy flips the taxonomy
 * assertion red; wiring one of these flags as a request field without removing
 * it here flips the "no flag both wired and unexposed" assertions red.
 */
import { describe, expect, it } from "vitest";
import {
  GEMINI_UNEXPOSED_CLI_FLAGS,
  MISTRAL_UNEXPOSED_CLI_FLAGS,
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

describe("Phase 4 Part B unexposed-flag classification", () => {
  it("every entry uses the closed reason taxonomy and a non-empty detail", () => {
    for (const entry of [...GEMINI_UNEXPOSED_CLI_FLAGS, ...MISTRAL_UNEXPOSED_CLI_FLAGS]) {
      expect(VALID_REASONS).toContain(entry.reason);
      expect(entry.flag.startsWith("--")).toBe(true);
      expect(entry.detail.length).toBeGreaterThan(20);
    }
  });

  it("Gemini interactive-only / admin-deferred flags are recorded", () => {
    expect(reasonOf(GEMINI_UNEXPOSED_CLI_FLAGS, "--prompt-interactive")).toBe("interactive-only");
    expect(reasonOf(GEMINI_UNEXPOSED_CLI_FLAGS, "--log-file")).toBe("admin-deferred");
  });

  it("Gemini --print-timeout is now wired (no longer classified as unexposed)", () => {
    // Graduated from gateway-managed to a passthrough request field; it must not
    // reappear in the unexposed list. Re-adding it here flips this red.
    expect(reasonOf(GEMINI_UNEXPOSED_CLI_FLAGS, "--print-timeout")).toBeUndefined();
  });

  it("Mistral setup / maintenance flags are recorded as admin-deferred", () => {
    expect(reasonOf(MISTRAL_UNEXPOSED_CLI_FLAGS, "--setup")).toBe("admin-deferred");
    expect(reasonOf(MISTRAL_UNEXPOSED_CLI_FLAGS, "--check-upgrade")).toBe("admin-deferred");
  });

  it("no flag is both wired and classified as unexposed (Gemini)", () => {
    // Gemini must_cover flags that ARE wired as request fields (prepareGeminiRequest).
    const wired = [
      "--print",
      "--model",
      "--add-dir",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--project",
      "--new-project",
      "--print-timeout",
      "--conversation",
      "--continue",
    ];
    const unexposed = new Set(GEMINI_UNEXPOSED_CLI_FLAGS.map(e => e.flag));
    for (const flag of wired) expect(unexposed.has(flag)).toBe(false);
  });

  it("no flag is both wired and classified as unexposed (Mistral)", () => {
    // Mistral must_cover flags that ARE wired (prepareMistralRequest). --auto-approve
    // / --yolo are covered as the permissionMode "auto-approve" alias (--agent).
    const wired = [
      "-p",
      "--output",
      "--agent",
      "--enabled-tools",
      "--trust",
      "--max-turns",
      "--max-price",
      "--max-tokens",
      "--workdir",
      "--add-dir",
      "--resume",
      "--continue",
    ];
    const unexposed = new Set(MISTRAL_UNEXPOSED_CLI_FLAGS.map(e => e.flag));
    for (const flag of wired) expect(unexposed.has(flag)).toBe(false);
  });
});
