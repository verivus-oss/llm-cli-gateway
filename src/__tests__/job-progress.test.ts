import { describe, expect, it } from "vitest";
import { JobProgressTracker, parseStoredJobProgress } from "../job-progress.js";

describe("JobProgressTracker", () => {
  it("normalizes Claude structured activity without persisting thought or tool input", () => {
    const tracker = new JobProgressTracker(
      "claude",
      "stream-json",
      null,
      "2026-01-01T00:00:00.000Z"
    );
    const secret = "do not persist this private reasoning";
    const absolutePath = "/home/operator/private/repo";
    const payload = [
      JSON.stringify({ type: "system", session_id: "native-secret" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: secret }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { path: absolutePath, token: "secret" } },
          ],
        },
      }),
      "",
    ].join("\n");

    tracker.ingest("stdout", Buffer.from(payload), new Date("2026-01-01T00:00:01.000Z"));
    const serialized = tracker.serialize();
    const snapshot = tracker.snapshot();

    expect(snapshot.capability).toBe("structured");
    expect(snapshot.events.map(event => event.kind)).toEqual([
      "lifecycle",
      "reasoning",
      "tool_start",
    ]);
    expect(snapshot.events.at(-1)?.message).toBe("Using a provider tool");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(absolutePath);
    expect(serialized).not.toContain("native-secret");
  });

  it.each([
    "/home/operator/private/repo",
    String.raw`C:\Users\operator\private\repo`,
    "file:///home/operator/private/repo",
    "mcp:private-repository-tool",
    "customer_secret_token_12345",
  ])("never projects an untrusted provider tool name into progress: %s", untrustedName => {
    const cases = [
      {
        provider: "claude",
        outputFormat: "stream-json",
        event: {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: untrustedName }] },
        },
      },
      {
        provider: "codex",
        outputFormat: "json",
        event: {
          type: "item.started",
          item: { type: "mcp_tool_call", name: untrustedName },
        },
      },
      {
        provider: "grok",
        outputFormat: "streaming-json",
        event: { type: "tool_start", name: untrustedName },
      },
    ];

    for (const testCase of cases) {
      const tracker = new JobProgressTracker(testCase.provider, testCase.outputFormat);
      tracker.ingest("stdout", Buffer.from(`${JSON.stringify(testCase.event)}\n`));

      expect(tracker.snapshot().events.at(-1)?.message).toBe("Using a provider tool");
      expect(tracker.serialize()).not.toContain(untrustedName);
    }
  });

  it("redacts provider tool names while hydrating legacy stored progress", () => {
    const secretPath = "/home/operator/private/repo";
    const stored = JSON.stringify({
      version: 1,
      capability: "structured",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      lastSeq: 1,
      droppedCount: 0,
      events: [
        {
          seq: 1,
          ts: "2026-01-01T00:00:01.000Z",
          phase: "tool",
          kind: "tool_start",
          message: `Using tool ${secretPath}`,
          source: "provider",
        },
      ],
    });

    const parsed = parseStoredJobProgress(stored);
    expect(parsed?.events[0]?.message).toBe("Using a provider tool");
    expect(JSON.stringify(parsed)).not.toContain(secretPath);
  });

  it("frames JSONL across split UTF-8 chunks", () => {
    const tracker = new JobProgressTracker("codex", "json");
    const line = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "你好" } })}\n`;
    const encoded = Buffer.from(line, "utf8");
    const split = encoded.indexOf(Buffer.from("你", "utf8")) + 1;

    tracker.ingest("stdout", encoded.subarray(0, split), new Date("2026-01-01T00:00:01.000Z"));
    tracker.ingest("stdout", encoded.subarray(split), new Date("2026-01-01T00:00:02.000Z"));

    expect(tracker.snapshot().events.at(-1)).toMatchObject({
      phase: "writing",
      kind: "output",
      message: "Provider is writing output",
    });
    expect(tracker.serialize()).not.toContain("你好");
  });

  it.each(["command_execution", "mcp_tool_call", "file_change"])(
    "emits one Codex %s start and drops updates and successful completion",
    itemType => {
      const tracker = new JobProgressTracker("codex", "json");
      const payload = [
        { type: "item.started", item: { type: itemType, status: "in_progress" } },
        { type: "item.updated", item: { type: itemType, status: "in_progress" } },
        { type: "item.completed", item: { type: itemType, status: "completed" } },
      ]
        .map(event => JSON.stringify(event))
        .join("\n");

      tracker.ingest("stdout", Buffer.from(`${payload}\n`));

      expect(tracker.snapshot().events).toEqual([
        expect.objectContaining({
          phase: "tool",
          kind: "tool_start",
          message: "Using a provider tool",
        }),
      ]);
    }
  );

  it.each(["command_execution", "mcp_tool_call", "file_change"])(
    "surfaces failed Codex %s completion as an error",
    itemType => {
      const tracker = new JobProgressTracker("codex", "json");
      tracker.ingest(
        "stdout",
        Buffer.from(
          `${JSON.stringify({
            type: "item.completed",
            item: { type: itemType, status: "failed" },
          })}\n`
        )
      );

      expect(tracker.snapshot().events).toEqual([
        expect.objectContaining({
          phase: "tool",
          kind: "tool_error",
          message: "Provider tool reported an error",
        }),
      ]);
    }
  );

  it("does not infer Codex JSONL from the provider name alone", () => {
    const tracker = new JobProgressTracker("codex");
    tracker.ingest(
      "stdout",
      Buffer.from(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })}\n`
      )
    );

    expect(tracker.snapshot()).toMatchObject({
      capability: "activity_only",
      events: [expect.objectContaining({ kind: "activity" })],
    });
  });

  it("truthfully labels providers without structured adapters as activity only", () => {
    const tracker = new JobProgressTracker("mistral", "streaming");
    tracker.ingest("stderr", Buffer.from("private provider log"));
    const snapshot = tracker.snapshot();

    expect(snapshot.capability).toBe("activity_only");
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      phase: "thinking",
      kind: "activity",
      message: "Provider process is active",
    });
    expect(tracker.serialize()).not.toContain("private provider log");
  });

  it("bounds and paginates the event ring", () => {
    const tracker = new JobProgressTracker("devin");
    for (let i = 0; i < 100; i += 1) {
      tracker.emit("tool", "tool_start", `Using tool tool_${i}`, "provider", new Date(i * 2_000));
    }
    const snapshot = tracker.snapshot(95, 3);

    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.map(event => event.seq)).toEqual([96, 97, 98]);
    expect(snapshot).toMatchObject({
      nextAfterSeq: 98,
      highWaterSeq: 100,
      lastSeq: 100,
      hasMore: true,
    });
    expect(snapshot.droppedCount).toBe(36);
  });

  it("pages forward from the returned cursor without skipping retained events", () => {
    const tracker = new JobProgressTracker("devin");
    for (let index = 1; index <= 5; index += 1) {
      tracker.emit("tool", "tool_start", `Using tool tool_${index}`);
    }

    const first = tracker.snapshot(0, 2);
    const second = tracker.snapshot(first.nextAfterSeq, 2);
    const third = tracker.snapshot(second.nextAfterSeq, 2);
    const exhausted = tracker.snapshot(third.nextAfterSeq, 2);

    expect(first.events.map(event => event.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextAfterSeq: 2, highWaterSeq: 5, hasMore: true });
    expect(second.events.map(event => event.seq)).toEqual([3, 4]);
    expect(second).toMatchObject({ nextAfterSeq: 4, highWaterSeq: 5, hasMore: true });
    expect(third.events.map(event => event.seq)).toEqual([5]);
    expect(third).toMatchObject({ nextAfterSeq: 5, highWaterSeq: 5, hasMore: false });
    expect(exhausted.events).toEqual([]);
    expect(exhausted).toMatchObject({ nextAfterSeq: 5, highWaterSeq: 5, hasMore: false });

    expect([...first.events, ...second.events, ...third.events].map(event => event.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("hydrates only validated versioned state", () => {
    const tracker = new JobProgressTracker("grok", "streaming-json");
    tracker.emit("queued", "lifecycle", "Job queued");
    const parsed = parseStoredJobProgress(tracker.serialize());

    expect(parsed?.version).toBe(1);
    expect(parsed?.events[0]?.message).toBe("Job queued");
    expect(parseStoredJobProgress('{"version":2}')).toBeNull();
    expect(parseStoredJobProgress("not-json")).toBeNull();
  });
});
