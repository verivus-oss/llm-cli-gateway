/**
 * U26 — `codex_fork_session` tool.
 *
 * Verifies the pure `prepareCodexForkRequest` helper builds the expected
 * `codex fork ...` argv, enforces the (sessionId | forkLast) XOR constraint,
 * and rejects gateway-prefixed session IDs via `validateSessionId`.
 */
import { describe, expect, it } from "vitest";
import { prepareCodexForkRequest } from "../request-helpers.js";

describe("U26 — codex_fork_session (prepareCodexForkRequest)", () => {
  it("emits [\"fork\", \"--last\", PROMPT] when forkLast=true", () => {
    const { args } = prepareCodexForkRequest({ forkLast: true, prompt: "hello" });
    expect(args).toEqual(["fork", "--last", "hello"]);
  });

  it("emits [\"fork\", <UUID>, PROMPT] when sessionId is supplied", () => {
    const { args } = prepareCodexForkRequest({
      sessionId: "abc-123",
      prompt: "hello",
    });
    expect(args).toEqual(["fork", "abc-123", "hello"]);
  });

  it("throws when neither sessionId nor forkLast is set", () => {
    expect(() => prepareCodexForkRequest({ prompt: "hello" })).toThrow(
      /one of sessionId or forkLast is required/
    );
  });

  it("throws when both sessionId and forkLast are set", () => {
    expect(() =>
      prepareCodexForkRequest({
        sessionId: "abc-123",
        forkLast: true,
        prompt: "hello",
      })
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a gateway-prefixed sessionId via validateSessionId", () => {
    expect(() =>
      prepareCodexForkRequest({ sessionId: "gw-fake", prompt: "hi" })
    ).toThrow(/reserved prefix/);
  });

  it("preserves the prompt as the final positional regardless of mode", () => {
    expect(
      prepareCodexForkRequest({ forkLast: true, prompt: "multi word prompt" }).args[2]
    ).toBe("multi word prompt");
    expect(
      prepareCodexForkRequest({
        sessionId: "uuid-1",
        prompt: "multi word prompt",
      }).args[2]
    ).toBe("multi word prompt");
  });
});
