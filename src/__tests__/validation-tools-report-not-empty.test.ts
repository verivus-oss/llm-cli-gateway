/**
 * The validation tools must return a REAL report, not `{}`.
 *
 * s5 made startValidationRun asynchronous. Its result is placed into the object
 * `textResponse` serialises, and that object is structurally loose, so
 * TypeScript accepted a Promise in the `report` field without a word. A promise
 * JSON.stringifies to `{}`, so five tools returned
 *
 *     { "success": true, "tool": "second_opinion", "report": {} }
 *
 * and reported success. The gateway's own cross-LLM review surface.
 *
 * Nothing caught it. Not tsc, because the field accepts it. Not
 * no-floating-promises, because the promise IS consumed. Not
 * no-misused-promises, because the slot is not a void-returning function. Not
 * the promise-in-boolean gate, because there is no boolean position. And not
 * the suite: reverting the fix at all five sites left every existing test
 * passing, which is how the defect could exist at all.
 *
 * This is that missing control. It asserts on the SERIALISED response, because
 * serialisation is where a promise becomes `{}` and is therefore the only place
 * the defect is observable.
 */
import { describe, expect, it } from "vitest";
import type { AsyncJobResult, AsyncJobSnapshot, JobLimiterSnapshot } from "../async-job-manager.js";
import { registerValidationTools, type ValidationToolDeps } from "../validation-tools.js";
import type { ValidationProvider } from "../validation-normalizer.js";

const EMPTY_LIMITER: JobLimiterSnapshot = {
  maxRunning: 100,
  maxRunningPerProvider: 100,
  maxQueued: 100,
  running: 0,
  queued: 0,
  runningByProvider: {},
  queuedByProvider: {},
  rejected: 0,
  timedOut: 0,
  saturated: false,
};

function snapshot(id: string, cli: string): AsyncJobSnapshot {
  return {
    id,
    cli,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    correlationId: `corr-${id}`,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    exited: false,
  };
}

const cliInstalled = (provider: ValidationProvider) =>
  ({
    provider,
    displayName: provider,
    command: provider,
    installed: true,
    version: `${provider}-fake`,
    versionCommand: [provider, "--version"],
    loginStatus: "authenticated",
    loginCheck: {
      method: "not_checked",
      command: null,
      credentialStore: "not_checked",
      detail: "",
    },
    guidance: {
      provider,
      displayName: provider,
      install: { summary: "", commands: [] },
      login: { summary: "", commands: [], credentialHandling: "none" },
      verification: { command: "", expected: "" },
    },
  }) as never;

function registerAndCapture(): Map<string, (args: never) => Promise<unknown>> {
  let n = 0;
  const manager = {
    async startJobWithDedup(
      cli: string
    ): Promise<{ snapshot: AsyncJobSnapshot; deduped: boolean }> {
      return { snapshot: snapshot(`job-${++n}`, cli), deduped: false };
    },
    getLimiterSnapshot(): JobLimiterSnapshot {
      return EMPTY_LIMITER;
    },
    async getJobResult(): Promise<AsyncJobResult | null> {
      return null;
    },
    async getJobSnapshot(): Promise<AsyncJobSnapshot | null> {
      return null;
    },
  };
  const handlers = new Map<string, (args: never) => Promise<unknown>>();
  const server = {
    tool(
      name: string,
      _desc: string,
      _schema: unknown,
      _ann: unknown,
      cb: (args: never) => Promise<unknown>
    ) {
      handlers.set(name, cb);
    },
  };
  const deps: ValidationToolDeps = {
    asyncJobManager: manager as never,
    getProviderRuntimeStatus: cliInstalled,
  };
  registerValidationTools(server as never, deps);
  return handlers;
}

/**
 * Assert on BOTH halves of the response, because each catches the defect in a
 * different way and neither is redundant.
 *
 * `textResponse` returns the report's `humanReadable` string when it can find
 * one, and falls back to JSON.stringify(body) when it cannot. A promise has no
 * `humanReadable`, so the broken form emits literally `{"report": {}}` while
 * the fixed form emits the human-readable report. That makes the TEXT a sharp
 * signal.
 *
 * structuredContent carries the live value, so there the promise survives as a
 * thenable rather than collapsing. Checking it directly for `then` is the most
 * literal statement of the defect there is: a report must not be awaitable.
 */
function assertRealReport(tool: string, response: unknown): void {
  const res = response as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { report?: unknown };
  };
  const text = res.content?.find(part => part.type === "text")?.text ?? "";
  expect(text, `${tool} returned no text content`).not.toBe("");
  // Exactly what a stringified promise looks like in this response shape.
  expect(text, `${tool} serialised an EMPTY report`).not.toContain('"report": {}');

  const report = res.structuredContent?.report as Record<string, unknown> | undefined;
  expect(report, `${tool} carried no report`).toBeDefined();
  expect(
    typeof (report as { then?: unknown }).then,
    `${tool} report is a PROMISE, not a report`
  ).not.toBe("function");
  expect(Array.isArray(report!.results), `${tool} report has no results array`).toBe(true);
}

describe("validation tools return a real report, not a serialised promise", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
    {
      tool: "validate_with_models",
      args: { question: "is this correct?", models: ["claude", "codex"], focus: "correctness" },
    },
    {
      // Singular `model` and an `answer`, not a `models` list. Taken from the
      // handler signature, because guessing the argument name is how a control
      // ends up asserting on an error response instead of on a report.
      tool: "second_opinion",
      args: { question: "is this correct?", answer: "yes", model: "claude" },
    },
    {
      tool: "red_team_review",
      args: { content: "some change", models: ["claude", "codex"] },
    },
    {
      tool: "consensus_check",
      args: { claim: "the sky is blue", models: ["claude", "codex"] },
    },
    {
      tool: "ask_model",
      args: { question: "what is 2 + 2?", model: "claude" },
    },
  ];

  it.each(cases)("$tool serialises a populated report", async ({ tool, args }) => {
    const handlers = registerAndCapture();
    const handler = handlers.get(tool);
    expect(handler, `${tool} was not registered`).toBeDefined();

    assertRealReport(tool, await handler!(args as never));
  });
});
