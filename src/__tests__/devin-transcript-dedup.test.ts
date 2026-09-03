/**
 * The devin export path, and its removal from the dedup identity.
 *
 * `devinTranscriptDedupArgs` shipped with no test at all: a cross-LLM review
 * replaced its body with `return [...args]` and 4842 tests stayed green. The
 * helper was correct and unprotected, which is the same as unwritten the next
 * time someone edits it.
 *
 * The behaviour under test is not "the token appears". It is that two requests
 * differing ONLY in correlation id produce the same dedup identity, because the
 * gateway-minted path embeds that id and the identity is what decides whether
 * the second request runs at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  devinTranscriptDedupArgs,
  devinTranscriptPath,
  DEVIN_TRANSCRIPT_DIRNAME,
} from "../devin-transcript.js";
import { prepareDevinRequest, resolveGatewayServerRuntime } from "../index.js";

let fakeHome: string;
let realHome: string | undefined;
beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "devin-dedup-home-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function prepFor(correlationId: string, extra: Record<string, unknown> = {}) {
  const prep = prepareDevinRequest(
    {
      prompt: "PROMPT",
      optimizePrompt: false,
      operation: "devin_request",
      correlationId,
      ...extra,
    } as never,
    resolveGatewayServerRuntime()
  );
  if (!("args" in prep)) throw new Error("prepareDevinRequest returned an error response");
  return prep;
}

describe("devinTranscriptDedupArgs", () => {
  const TOKEN = "[gateway-devin-transcript]";

  it("replaces the path element and nothing else", () => {
    const args = ["-p", "hi", "--export", "/home/u/x.json", "--sandbox"];
    expect(devinTranscriptDedupArgs(args, "/home/u/x.json")).toEqual([
      "-p",
      "hi",
      "--export",
      TOKEN,
      "--sandbox",
    ]);
  });

  it("substitutes a token, so an identity function is not a passing implementation", () => {
    // The mutation that survived the shipped suite was `return [...args]`.
    const args = ["--export", "/home/u/x.json"];
    expect(devinTranscriptDedupArgs(args, "/home/u/x.json")).not.toEqual(args);
    expect(devinTranscriptDedupArgs(args, "/home/u/x.json")).toContain(TOKEN);
  });

  it("leaves the caller's argv untouched", () => {
    const args = ["--export", "/home/u/x.json"];
    devinTranscriptDedupArgs(args, "/home/u/x.json");
    expect(args).toEqual(["--export", "/home/u/x.json"]);
  });

  it("returns a copy unchanged when there is no gateway-minted path", () => {
    const args = ["-p", "hi"];
    const out = devinTranscriptDedupArgs(args, null);
    expect(out).toEqual(args);
    expect(out).not.toBe(args);
  });

  it("returns a copy unchanged when the path is not in the argv", () => {
    const args = ["-p", "hi"];
    expect(devinTranscriptDedupArgs(args, "/home/u/absent.json")).toEqual(args);
  });

  it("replaces only the first occurrence, so a prompt quoting the path survives", () => {
    const p = "/home/u/x.json";
    expect(devinTranscriptDedupArgs(["--export", p, "-p", p], p)).toEqual([
      "--export",
      TOKEN,
      "-p",
      p,
    ]);
  });
});

describe("the prepared dedup identity", () => {
  it("is identical for two requests that differ only in correlation id", () => {
    const a = prepFor("corr-one");
    const b = prepFor("corr-two");
    expect(a.args).not.toEqual(b.args);
    expect(a.dedupArgs).toEqual(b.dedupArgs);
  });

  it("carries the minted path in the launched argv, and only there", () => {
    const prep = prepFor("corr-one");
    expect(prep.args).toContain(devinTranscriptPath("corr-one", fakeHome));
    expect(prep.dedupArgs).not.toContain(devinTranscriptPath("corr-one", fakeHome));
    expect(prep.args.join(" ")).toContain(DEVIN_TRANSCRIPT_DIRNAME);
  });

  it("keeps a CALLER-supplied export path in the identity", () => {
    // Two requests exporting to different destinations differ in an effect the
    // caller can observe, so they are not the same request and must not dedup.
    const a = prepFor("corr-one", { exportSession: "/tmp/a.json" });
    const b = prepFor("corr-one", { exportSession: "/tmp/b.json" });
    expect(a.dedupArgs).not.toEqual(b.dedupArgs);
    expect(a.dedupArgs).toContain("/tmp/a.json");
  });

  it("is the argv itself when the caller declines the export", () => {
    const prep = prepFor("corr-one", { exportSession: false });
    expect(prep.args).not.toContain("--export");
    expect(prep.dedupArgs).toEqual(prep.args);
  });
});
