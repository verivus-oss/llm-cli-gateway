/**
 * ACP flight-recorder redaction tests (plan step define-acp-flight-recorder-redaction).
 *
 * The headline guarantee: inserting an ACP request whose prompt/response/error
 * carry sentinel prompt text, a JSON-RPC body, file contents, terminal output,
 * a local path, and a credential marker yields flight-recorder entries that
 * contain NONE of those sentinels.
 */
import { describe, expect, it } from "vitest";

import {
  buildAcpFlightResult,
  buildAcpFlightStart,
  redactAcpTextForFlight,
  summarizeAcpPromptForFlight,
  summarizeAcpResponseForFlight,
} from "../acp/flight-redaction.js";
import type { ContentBlock } from "../acp/types.js";

// Sentinels that must NEVER appear in a flight-recorder entry.
const PROMPT_SENTINEL = "SENTINEL-PROMPT-TEXT";
const JSONRPC_SENTINEL = '{"jsonrpc":"2.0","method":"session/prompt","secret":"SENTINEL-JSONRPC"}';
const FILE_SENTINEL = "SENTINEL-FILE-CONTENTS-export const KEY=1";
const TERMINAL_SENTINEL = "SENTINEL-TERMINAL-OUTPUT $ cat secret";
const PATH_SENTINEL = "/home/werner/.config/SENTINEL-PATH.key";
const CRED_SENTINEL = "Bearer sk-SENTINELCREDENTIALabcdef0123456789";

const ALL_SENTINELS = [
  PROMPT_SENTINEL,
  "SENTINEL-JSONRPC",
  FILE_SENTINEL,
  TERMINAL_SENTINEL,
  PATH_SENTINEL,
  "SENTINELCREDENTIAL",
];

function block(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

describe("ACP flight-redaction — summaries", () => {
  it("summarizes a prompt as a block count, never the text", () => {
    const out = summarizeAcpPromptForFlight([block(PROMPT_SENTINEL), block("more")]);
    expect(out).toBe("[acp prompt: 2 content blocks]");
    expect(out).not.toContain(PROMPT_SENTINEL);
  });

  it("summarizes a response as a length, never the text", () => {
    const out = summarizeAcpResponseForFlight(`${FILE_SENTINEL}${TERMINAL_SENTINEL}`);
    expect(out).toMatch(/^\[acp response: \d+ chars\]$/);
    expect(out).not.toContain(FILE_SENTINEL);
    expect(out).not.toContain(TERMINAL_SENTINEL);
  });
});

describe("ACP flight-redaction — redactAcpTextForFlight", () => {
  it("collapses JSON/JSON-RPC bodies", () => {
    expect(redactAcpTextForFlight(`error near ${JSONRPC_SENTINEL}`)).not.toContain(
      "SENTINEL-JSONRPC"
    );
  });
  it("strips local paths and credentials", () => {
    const out = redactAcpTextForFlight(`failed at ${PATH_SENTINEL} with ${CRED_SENTINEL}`);
    expect(out).not.toContain(PATH_SENTINEL);
    expect(out).not.toContain("SENTINELCREDENTIAL");
  });
});

describe("ACP flight-redaction — buildAcpFlightStart", () => {
  it("records a summarized prompt + provider/model/session, never the raw prompt", () => {
    const start = buildAcpFlightStart({
      correlationId: "c1",
      provider: "mistral",
      model: "vibe",
      prompt: [block(PROMPT_SENTINEL), block(JSONRPC_SENTINEL)],
      gatewaySessionId: "gw-123",
    });
    expect(start.cli).toBe("mistral");
    expect(start.model).toBe("vibe");
    expect(start.sessionId).toBe("gw-123");
    expect(start.prompt).toBe("[acp prompt: 2 content blocks]");
    expect(JSON.stringify(start)).not.toContain(PROMPT_SENTINEL);
    expect(JSON.stringify(start)).not.toContain("SENTINEL-JSONRPC");
  });

  it("enforces the gw-* invariant: drops a non-gateway session id (never persists a provider id)", () => {
    const start = buildAcpFlightStart({
      correlationId: "c3",
      provider: "grok",
      model: "grok",
      prompt: [block("x")],
      gatewaySessionId: "tough-chess", // a provider ACP id, NOT a gateway id
    });
    expect(start.sessionId).toBeUndefined();
    expect(JSON.stringify(start)).not.toContain("tough-chess");
  });

  it("preserves a valid gw-* session id", () => {
    const start = buildAcpFlightStart({
      correlationId: "c4",
      provider: "grok",
      model: "grok",
      prompt: [block("x")],
      gatewaySessionId: "gw-valid-123",
    });
    expect(start.sessionId).toBe("gw-valid-123");
  });
});

describe("ACP flight-redaction — buildAcpFlightResult", () => {
  it("records a summarized response + redacted error, never the raw bodies", () => {
    const result = buildAcpFlightResult({
      responseText: `${FILE_SENTINEL}\n${TERMINAL_SENTINEL}\n${JSONRPC_SENTINEL}`,
      durationMs: 12,
      status: "failed",
      exitCode: 1,
      errorMessage: `crash at ${PATH_SENTINEL} token ${CRED_SENTINEL} body ${JSONRPC_SENTINEL}`,
    });
    expect(result.response).toMatch(/^\[acp response: \d+ chars\]$/);
    expect(result.status).toBe("failed");
    const serialized = JSON.stringify(result);
    for (const sentinel of ALL_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});

describe("ACP flight-redaction — end-to-end sentinel sweep", () => {
  it("emits no sentinel across both the start and result entries", () => {
    const start = buildAcpFlightStart({
      correlationId: "c2",
      provider: "devin",
      model: "swe-1-6-slow",
      prompt: [block(PROMPT_SENTINEL), block(FILE_SENTINEL)],
      gatewaySessionId: "gw-abc",
    });
    const result = buildAcpFlightResult({
      responseText: `${FILE_SENTINEL} ${TERMINAL_SENTINEL} ${JSONRPC_SENTINEL}`,
      durationMs: 5,
      status: "completed",
      exitCode: 0,
      errorMessage: `${PATH_SENTINEL} ${CRED_SENTINEL}`,
    });
    const combined = JSON.stringify(start) + JSON.stringify(result);
    for (const sentinel of ALL_SENTINELS) {
      expect(combined).not.toContain(sentinel);
    }
  });
});
