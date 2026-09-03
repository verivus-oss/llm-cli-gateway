export interface ProviderCapturePlan {
  /** Exact argv launched and persisted. */
  args: string[];
  /** Grammar of the durable capture, distinct from the caller presentation. */
  captureFormat: string | null;
  /** Whether this grammar carries reasoning and tool activity when upstream emits them. */
  transcriptCapable: boolean;
}

export function captureFormatCarriesTranscript(provider: string, format: string | null): boolean {
  return (
    (provider === "claude" && format === "stream-json") ||
    (provider === "codex" && format === "json") ||
    (provider === "gemini" && format === "stream-json") ||
    (provider === "grok" && format === "streaming-json") ||
    (provider === "mistral" && format === "streaming") ||
    (provider === "cursor" && format === "stream-json")
  );
}

function hasJsonEvent(
  stdout: string,
  predicate: (event: Record<string, unknown>) => boolean
): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (predicate(value as Record<string, unknown>)) return true;
      }
    } catch {
      // Provider banners and partial trailing lines are not terminal events.
    }
  }
  return false;
}

/** True only when a rich provider wire contains its terminal event. */
export function providerCaptureStreamIsComplete(
  provider: string,
  format: string | null,
  stdout: string
): boolean {
  if (format === "api-response") return true;
  if (!captureFormatCarriesTranscript(provider, format)) return false;
  switch (provider) {
    case "claude":
      return hasJsonEvent(stdout, event => event.type === "result");
    case "codex":
      return hasJsonEvent(
        stdout,
        event => event.type === "turn.completed" || event.type === "turn.failed"
      );
    case "gemini":
      return hasJsonEvent(stdout, event => event.type === "result" || event.event === "result");
    case "grok":
      return hasJsonEvent(stdout, event => event.type === "end" || event.type === "error");
    case "mistral":
      return hasJsonEvent(
        stdout,
        event =>
          typeof event.generationStatus === "string" &&
          event.generationStatus !== "running" &&
          event.generationStatus !== "pending"
      );
    case "cursor":
      return hasJsonEvent(stdout, event => event.type === "result");
    default:
      return false;
  }
}

function replaceOrInsertValueFlag(args: string[], flag: string, value: string): void {
  const optionEnd = args.indexOf("--");
  const searchEnd = optionEnd >= 0 ? optionEnd : args.length;
  for (let index = 0; index < searchEnd; index += 1) {
    if (args[index] !== flag) continue;
    if (index + 1 < searchEnd) args[index + 1] = value;
    else args.splice(index + 1, 0, value);
    return;
  }
  args.splice(searchEnd, 0, flag, value);
}

function ensureBooleanFlag(args: string[], flag: string): void {
  const optionEnd = args.indexOf("--");
  const searchEnd = optionEnd >= 0 ? optionEnd : args.length;
  if (args.slice(0, searchEnd).includes(flag)) return;
  args.splice(searchEnd, 0, flag);
}

/**
 * Select the richest provider wire. The caller's requested format is a
 * presentation projected from this capture after the process exits.
 */
export function planProviderCapture(
  provider: string,
  callerArgs: readonly string[],
  callerOutputFormat: string | undefined
): ProviderCapturePlan {
  const args = [...callerArgs];
  switch (provider) {
    case "claude": {
      replaceOrInsertValueFlag(args, "--output-format", "stream-json");
      ensureBooleanFlag(args, "--include-partial-messages");
      ensureBooleanFlag(args, "--verbose");
      return { args, captureFormat: "stream-json", transcriptCapable: true };
    }
    case "codex":
      return {
        args,
        captureFormat: args.includes("--json") ? "json" : (callerOutputFormat ?? null),
        transcriptCapable: args.includes("--json"),
      };
    case "gemini": {
      replaceOrInsertValueFlag(args, "--output-format", "stream-json");
      return { args, captureFormat: "stream-json", transcriptCapable: true };
    }
    case "grok": {
      replaceOrInsertValueFlag(args, "--output-format", "streaming-json");
      return { args, captureFormat: "streaming-json", transcriptCapable: true };
    }
    case "mistral": {
      replaceOrInsertValueFlag(args, "--output", "streaming");
      return { args, captureFormat: "streaming", transcriptCapable: true };
    }
    case "cursor": {
      replaceOrInsertValueFlag(args, "--output-format", "stream-json");
      return { args, captureFormat: "stream-json", transcriptCapable: true };
    }
    case "devin":
      return { args, captureFormat: "atif-v1.7", transcriptCapable: false };
    default:
      return { args, captureFormat: callerOutputFormat ?? null, transcriptCapable: false };
  }
}
