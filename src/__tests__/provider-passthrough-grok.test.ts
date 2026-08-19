/**
 * n3 end to end on grok: does a flag the gateway has never heard of actually
 * reach argv?
 *
 * The unit tests in provider-passthrough.test.ts prove the builder. This proves
 * the WIRING, which is the half that has silently failed before: a parameter can
 * exist in the Zod schema, in the params type and in the prepare function's
 * signature and still never be forwarded by the callback, and every unit test
 * stays green while the capability is unreachable.
 */
import { describe, expect, it } from "vitest";
import { createGatewayServer, prepareGrokRequest } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { SessionManager } from "../session-manager.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

const REMOTE: GatewayRequestContext = { transport: "http", authScopes: [], authPrincipal: "p1" };

const BASE = {
  prompt: "hi",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "grok_request",
};

function argvOf(result: unknown): string[] {
  if (typeof result === "object" && result !== null && "args" in result) {
    return (result as { args: string[] }).args;
  }
  throw new Error(`expected a prepared request, got an error response: ${JSON.stringify(result)}`);
}

function errorText(result: unknown): string {
  if (typeof result === "object" && result !== null && !("args" in result)) {
    return (result as { content: { text: string }[] }).content[0].text;
  }
  throw new Error("expected an error response");
}

describe("grok pass-through, end to end", () => {
  it("reaches argv with a flag that has no named parameter", () => {
    // --best-of-n is absent from our reference host's grok 1.0.4 and has no
    // gateway parameter. A customer on an older grok still has it, and before
    // this wiring there was no way for them to send it.
    const args = argvOf(
      prepareGrokRequest({ ...BASE, providerFlags: { "--best-of-n": "3" } } as never)
    );
    expect(args.join(" ")).toContain("--best-of-n 3");
  });

  it("appends AFTER the gateway's own flags, so it cannot displace them", () => {
    const args = argvOf(
      prepareGrokRequest({
        ...BASE,
        outputFormat: "json",
        providerFlags: { "--verbatim": true },
      } as never)
    );
    expect(args.indexOf("--verbatim")).toBeGreaterThan(args.indexOf("--output-format"));
  });

  it("REFUSES LOUDLY rather than dropping a flag it will not pass", () => {
    // A silent drop is the same harm as removing a capability from the
    // contract: the caller asked for something, did not get it, and was not
    // told. The refusal names the flag and the reason.
    const res = prepareGrokRequest({
      ...BASE,
      outputFormat: "json",
      providerFlags: { "--output-format": "text" },
    } as never);
    expect(errorText(res)).toContain("--output-format");
    expect(errorText(res)).toContain("already emitting");
  });

  it("refuses a value that could be parsed as another option", () => {
    const res = prepareGrokRequest({
      ...BASE,
      providerFlags: { "--rules": "--always-approve" },
    } as never);
    expect(errorText(res)).toMatch(/must not start with/);
  });

  it("LOCAL callers are unrestricted", () => {
    const args = argvOf(
      prepareGrokRequest({
        ...BASE,
        providerFlags: { "--dangerously-skip-permissions": true },
      } as never)
    );
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("REMOTE callers are refused EVERY raw flag, not four pattern classes", () => {
    // The deny-list this replaces admitted --cd, --prompt-file, -c and fourteen
    // more. An ordinary capability flag is in this list on purpose.
    for (const flag of [
      "--dangerously-skip-permissions",
      "--add-dir",
      "--cd",
      "-c",
      "--best-of-n",
    ]) {
      const res = runWithRequestContext(REMOTE, () =>
        prepareGrokRequest({ ...BASE, providerFlags: { [flag]: true } } as never)
      );
      expect(errorText(res), flag).toContain("refused for remote HTTP/OAuth callers");
    }
  });

  it("LOCAL callers keep ordinary capability flags, which is where they belong", () => {
    const args = argvOf(
      prepareGrokRequest({ ...BASE, providerFlags: { "--best-of-n": "3" } } as never)
    );
    expect(args.join(" ")).toContain("--best-of-n 3");
  });
});

/**
 * REACHABILITY, not registration.
 *
 * Everything above calls `prepareGrokRequest` directly, which proves the
 * builder and the prepare function agree but says nothing about the tool
 * CALLBACK. A parameter can exist in the Zod schema, in the params interface and
 * in the prepare signature, and still be dropped by the callback's destructure,
 * with every test above staying green while the capability is unreachable.
 *
 * So this drives the registered tool. The probe is a flag that must be REFUSED:
 * the refusal text is produced only inside prepareGrokRequest, so seeing it
 * proves the value travelled the whole path. A silently dropped parameter would
 * instead let the request proceed to launch, which is a visibly different
 * outcome and not a passing test.
 */
describe("pass-through reaches every registered tool callback", () => {
  const server = createGatewayServer({
    sessionManager: new SessionManager(
      join(mkdtempSync(join(tmpdir(), "gw-pt-")), "sessions.json")
    ),
    asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
    persistence: {
      backend: "memory",
      path: null,
      dsn: null,
      retentionDays: 30,
      dedupWindowMs: 3600000,
      acknowledgeEphemeral: true,
      ownsOrphanRecovery: false,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    },
  });

  it.each([
    "claude_request",
    "codex_request",
    "gemini_request",
    "grok_request",
    "mistral_request",
    "devin_request",
    "cursor_request",
    "claude_request_async",
    "codex_request_async",
    "gemini_request_async",
    "grok_request_async",
    "mistral_request_async",
    "devin_request_async",
    "cursor_request_async",
  ])("%s forwards providerFlags from the callback into argv construction", async toolName => {
    const registered = (
      server as unknown as Record<
        string,
        Record<
          string,
          {
            handler: (
              a: Record<string, unknown>,
              e?: Record<string, unknown>
            ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
            inputSchema?: { parse: (a: unknown) => unknown };
          }
        >
      >
    )._registeredTools;
    const tool = registered[toolName];
    expect(tool, `${toolName} not registered`).toBeDefined();
    const args = {
      prompt: "hi",
      approvalStrategy: "legacy",
      providerFlags: { "--rules": "--always-approve" },
    };
    const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
    const result = await tool.handler(parsed as Record<string, unknown>, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must not start with/);
  });
});
