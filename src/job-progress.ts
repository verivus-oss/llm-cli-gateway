import { StringDecoder } from "node:string_decoder";

export type JobProgressPhase =
  "queued" | "starting" | "thinking" | "tool" | "writing" | "completed" | "failed";

export type JobProgressKind =
  "lifecycle" | "reasoning" | "tool_start" | "tool_error" | "output" | "terminal" | "activity";

export type JobProgressCapability = "structured" | "activity_only" | "lifecycle_only";

export interface JobProgressEvent {
  seq: number;
  ts: string;
  phase: JobProgressPhase;
  kind: JobProgressKind;
  message: string;
  source: "gateway" | "provider";
}

export interface JobProgressSnapshot {
  capability: JobProgressCapability;
  lastActivityAt: string;
  /** Highest sequence emitted by this job, including events not present in this page. */
  lastSeq: number;
  /** Explicit alias for `lastSeq`, separating the global high-water mark from the page cursor. */
  highWaterSeq: number;
  /** Pass this value as the next `afterProgressSeq` to continue forward without skipping. */
  nextAfterSeq: number;
  /** True when another retained event exists after `nextAfterSeq`. */
  hasMore: boolean;
  droppedCount: number;
  events: JobProgressEvent[];
}

export interface StoredJobProgress {
  version: 1;
  capability: JobProgressCapability;
  lastActivityAt: string;
  lastSeq: number;
  droppedCount: number;
  events: JobProgressEvent[];
}

const MAX_EVENT_MESSAGE_BYTES = 512;
const MAX_EVENTS = 64;
const MAX_EVENTS_BYTES = 32 * 1024;
const MAX_STORED_PROGRESS_BYTES = MAX_EVENTS_BYTES + 8 * 1024;
const MAX_PARTIAL_LINE_BYTES = 64 * 1024;
const COALESCE_WINDOW_MS = 1_000;
// An event whose phase/kind is not listed here fails validation, which drops
// the whole stored projection (parseStoredJobProgress returns null) rather
// than throwing. Only ever widen these lists; removing a variant that some
// gateway version actually emitted would silently discard durable progress.
const PROGRESS_PHASES: readonly JobProgressPhase[] = [
  "queued",
  "starting",
  "thinking",
  "tool",
  "writing",
  "completed",
  "failed",
];
const PROGRESS_KINDS: readonly JobProgressKind[] = [
  "lifecycle",
  "reasoning",
  "tool_start",
  "tool_error",
  "output",
  "terminal",
  "activity",
];

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes - 3) {
    end -= 1;
  }
  return `${value.slice(0, end)}...`;
}

function safeMessage(value: string): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return truncateUtf8(normalized || "Provider activity", MAX_EVENT_MESSAGE_BYTES);
}

function projectEventMessage(
  kind: JobProgressKind,
  source: "gateway" | "provider",
  value: string
): string {
  // Provider tool names are untrusted free-form strings. They can contain
  // paths, URIs, repository names, or secrets even when they look like simple
  // identifiers. Persist only the event category, never the supplied name.
  if (source === "provider" && kind === "tool_start") return "Using a provider tool";
  return safeMessage(value);
}

function eventBytes(event: JobProgressEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function isProgressEvent(value: unknown): value is JobProgressEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<JobProgressEvent>;
  return (
    Number.isInteger(event.seq) &&
    (event.seq ?? 0) > 0 &&
    typeof event.ts === "string" &&
    Number.isFinite(Date.parse(event.ts)) &&
    PROGRESS_PHASES.includes(event.phase as JobProgressPhase) &&
    PROGRESS_KINDS.includes(event.kind as JobProgressKind) &&
    typeof event.message === "string" &&
    !event.message.includes("\0") &&
    Buffer.byteLength(event.message, "utf8") <= MAX_EVENT_MESSAGE_BYTES &&
    (event.source === "gateway" || event.source === "provider")
  );
}

export function parseStoredJobProgress(value: string | null | undefined): StoredJobProgress | null {
  if (!value) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_STORED_PROGRESS_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = parsed as Partial<StoredJobProgress>;
    if (
      state.version !== 1 ||
      !["structured", "activity_only", "lifecycle_only"].includes(state.capability as string) ||
      typeof state.lastActivityAt !== "string" ||
      !Number.isFinite(Date.parse(state.lastActivityAt)) ||
      !Number.isInteger(state.lastSeq) ||
      (state.lastSeq ?? -1) < 0 ||
      !Number.isInteger(state.droppedCount) ||
      (state.droppedCount ?? -1) < 0 ||
      !Array.isArray(state.events)
    ) {
      return null;
    }
    const events = state.events;
    if (
      events.length > MAX_EVENTS ||
      !events.every(isProgressEvent) ||
      events.some((event, index) => index > 0 && event.seq <= events[index - 1]!.seq) ||
      (events.at(-1)?.seq ?? 0) > (state.lastSeq ?? 0) ||
      events.reduce((sum, event) => sum + eventBytes(event), 0) > MAX_EVENTS_BYTES
    ) {
      return null;
    }
    return {
      version: 1,
      capability: state.capability!,
      lastActivityAt: state.lastActivityAt,
      lastSeq: state.lastSeq!,
      droppedCount: state.droppedCount!,
      events: state.events.map(event => ({
        ...event,
        message: projectEventMessage(event.kind, event.source, event.message),
      })),
    };
  } catch {
    return null;
  }
}

interface ProgressSignal {
  phase: JobProgressPhase;
  kind: JobProgressKind;
  message: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  return objectRecord(record[key]);
}

function claudeSignal(event: Record<string, unknown>): ProgressSignal | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "system") {
    return { phase: "starting", kind: "lifecycle", message: "Provider session initialized" };
  }
  if (type === "assistant") {
    const message = nestedRecord(event, "message");
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const raw of content) {
      const block = objectRecord(raw);
      if (!block) continue;
      if (block.type === "tool_use") {
        return {
          phase: "tool",
          kind: "tool_start",
          message: "Using a provider tool",
        };
      }
      if (block.type === "thinking") {
        return {
          phase: "thinking",
          kind: "reasoning",
          message: "Provider reasoning activity",
        };
      }
      if (block.type === "text") {
        return { phase: "writing", kind: "output", message: "Provider is writing output" };
      }
    }
  }
  if (type === "result") {
    return { phase: "writing", kind: "output", message: "Provider produced a result" };
  }
  return null;
}

function codexSignal(event: Record<string, unknown>): ProgressSignal | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" || type === "turn.started") {
    return { phase: "starting", kind: "lifecycle", message: "Provider turn started" };
  }
  if (type === "turn.failed" || type === "error") {
    return { phase: "tool", kind: "tool_error", message: "Provider reported an error" };
  }
  if (type === "turn.completed") {
    return { phase: "writing", kind: "output", message: "Provider turn produced output" };
  }
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = nestedRecord(event, "item");
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (["command_execution", "mcp_tool_call", "file_change"].includes(itemType)) {
      if (type === "item.completed") {
        return item?.status === "failed"
          ? {
              phase: "tool",
              kind: "tool_error",
              message: "Provider tool reported an error",
            }
          : null;
      }
      // An update is a state-change notification, not the explicit start or
      // terminal completion event. Drop it to avoid duplicate tool starts.
      if (type === "item.updated") return null;
      return {
        phase: "tool",
        kind: "tool_start",
        message: "Using a provider tool",
      };
    }
    if (["reasoning", "analysis"].includes(itemType)) {
      return {
        phase: "thinking",
        kind: "reasoning",
        message: "Provider reasoning activity",
      };
    }
    if (itemType === "agent_message") {
      return { phase: "writing", kind: "output", message: "Provider is writing output" };
    }
  }
  return null;
}

function grokSignal(event: Record<string, unknown>): ProgressSignal | null {
  const rawType = event.type ?? event.event;
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  if (type.includes("error")) {
    return { phase: "tool", kind: "tool_error", message: "Provider reported an error" };
  }
  if (type.includes("tool")) {
    return {
      phase: "tool",
      kind: "tool_start",
      message: "Using a provider tool",
    };
  }
  if (type.includes("thought") || type.includes("reason")) {
    return { phase: "thinking", kind: "reasoning", message: "Provider reasoning activity" };
  }
  if (type.includes("text") || type.includes("content") || type.includes("result")) {
    return { phase: "writing", kind: "output", message: "Provider is writing output" };
  }
  return null;
}

function structuredSignal(provider: string, line: string): ProgressSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = objectRecord(value);
  if (!record) return null;
  if (provider === "claude") return claudeSignal(record);
  if (provider === "codex") return codexSignal(record);
  if (provider === "grok") return grokSignal(record);
  return null;
}

function structuredCapability(provider: string, outputFormat?: string): boolean {
  return (
    (provider === "claude" && outputFormat === "stream-json") ||
    (provider === "codex" && outputFormat === "json") ||
    (provider === "grok" && outputFormat === "streaming-json")
  );
}

export type JobProgressCapabilityOverride = JobProgressCapability;

export class JobProgressTracker {
  private stdoutDecoder = new StringDecoder("utf8");
  private stdoutCarry = "";
  private readonly events: JobProgressEvent[] = [];
  private lastSeq = 0;
  private droppedCount = 0;
  private lastActivityAt: string;
  private readonly capability: JobProgressCapability;

  constructor(
    private readonly provider: string,
    outputFormat?: string,
    stored?: StoredJobProgress | null,
    startedAt: string = new Date().toISOString(),
    capabilityOverride?: JobProgressCapabilityOverride
  ) {
    // A validated durable projection records the capability that was observed
    // when the job actually ran. Hydration must not re-derive it from argv,
    // because privacy-sensitive jobs deliberately persist a redacted argv.
    this.capability =
      stored?.capability ??
      capabilityOverride ??
      (structuredCapability(provider, outputFormat) ? "structured" : "activity_only");
    this.lastActivityAt = stored?.lastActivityAt ?? startedAt;
    if (stored) {
      this.lastSeq = stored.lastSeq;
      this.droppedCount = stored.droppedCount;
      this.events.push(...stored.events.map(event => ({ ...event })));
    }
  }

  emit(
    phase: JobProgressPhase,
    kind: JobProgressKind,
    message: string,
    source: "gateway" | "provider" = "gateway",
    at: Date = new Date()
  ): JobProgressEvent {
    const ts = at.toISOString();
    this.lastActivityAt = ts;
    const previous = this.events.at(-1);
    const coalescible = kind === "activity" || kind === "output" || kind === "reasoning";
    if (
      coalescible &&
      previous?.kind === kind &&
      previous.phase === phase &&
      previous.source === source &&
      at.getTime() - new Date(previous.ts).getTime() < COALESCE_WINDOW_MS
    ) {
      return previous;
    }
    const event: JobProgressEvent = {
      seq: ++this.lastSeq,
      ts,
      phase,
      kind,
      message: projectEventMessage(kind, source, message),
      source,
    };
    this.events.push(event);
    this.prune();
    return event;
  }

  ingest(stream: "stdout" | "stderr", chunk: Buffer, at: Date = new Date()): void {
    this.lastActivityAt = at.toISOString();
    if (stream !== "stdout" || this.capability !== "structured") {
      this.emit("thinking", "activity", "Provider process is active", "provider", at);
      return;
    }
    this.stdoutCarry += this.stdoutDecoder.write(chunk);
    if (Buffer.byteLength(this.stdoutCarry, "utf8") > MAX_PARTIAL_LINE_BYTES) {
      this.stdoutCarry = "";
      this.stdoutDecoder = new StringDecoder("utf8");
      this.droppedCount += 1;
      this.emit("thinking", "activity", "Provider process is active", "provider", at);
      return;
    }
    const lines = this.stdoutCarry.split("\n");
    this.stdoutCarry = lines.pop() ?? "";
    let emitted = false;
    for (const line of lines) {
      const signal = structuredSignal(this.provider, line.trim());
      if (!signal) continue;
      this.emit(signal.phase, signal.kind, signal.message, "provider", at);
      emitted = true;
    }
    if (!emitted) {
      this.emit("thinking", "activity", "Provider process is active", "provider", at);
    }
  }

  snapshot(afterSeq = 0, limit = MAX_EVENTS): JobProgressSnapshot {
    const boundedLimit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(limit)));
    const cursor = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
    const matching = this.events.filter(event => event.seq > cursor);
    const events = matching.slice(0, boundedLimit).map(event => ({ ...event }));
    return {
      capability: this.capability,
      lastActivityAt: this.lastActivityAt,
      lastSeq: this.lastSeq,
      highWaterSeq: this.lastSeq,
      nextAfterSeq: events.at(-1)?.seq ?? cursor,
      hasMore: matching.length > events.length,
      droppedCount: this.droppedCount,
      events,
    };
  }

  serialize(): string {
    const snapshot = this.snapshot(0, MAX_EVENTS);
    return JSON.stringify({
      version: 1,
      capability: snapshot.capability,
      lastActivityAt: snapshot.lastActivityAt,
      lastSeq: snapshot.lastSeq,
      droppedCount: snapshot.droppedCount,
      events: snapshot.events,
    } satisfies StoredJobProgress);
  }

  private prune(): void {
    let totalBytes = this.events.reduce((sum, event) => sum + eventBytes(event), 0);
    while (this.events.length > MAX_EVENTS || totalBytes > MAX_EVENTS_BYTES) {
      const removed = this.events.shift();
      if (!removed) break;
      totalBytes -= eventBytes(removed);
      this.droppedCount += 1;
    }
  }
}
