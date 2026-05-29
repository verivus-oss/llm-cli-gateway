/**
 * NDJSON parser for Claude `--output-format stream-json --include-partial-messages`.
 *
 * Each line of stdout is a complete JSON object. This parser extracts the
 * final result text, cost, usage, and metadata from the stream.
 */

export interface StreamJsonUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface StreamJsonResult {
  text: string;
  costUsd: number | null;
  usage: StreamJsonUsage | null;
  sessionId: string | null;
  model: string | null;
  durationApiMs: number | null;
  isError: boolean;
  numTurns: number | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse completed NDJSON stdout from `claude --output-format stream-json --include-partial-messages`.
 *
 * Parsing strategy:
 * 1. Split by newlines, filter empty lines
 * 2. JSON.parse each line, skip malformed lines
 * 3. Find the `type=result` event — contains final text, cost, usage
 * 4. Fall back to the last `type=assistant` event if no result event
 * 5. Extract `model` from `type=system` (init) event
 *
 * No rawEvents stored — the stdout buffer is already in memory.
 */
export function parseStreamJson(stdout: string): StreamJsonResult {
  const lines = stdout.split("\n").filter(line => line.trim().length > 0);

  let resultEvent: any = null;
  let assistantEvent: any = null;
  let systemEvent: any = null;

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    if (parsed.type === "result") {
      resultEvent = parsed;
    } else if (parsed.type === "assistant") {
      assistantEvent = parsed;
    } else if (parsed.type === "system" && parsed.subtype === "init") {
      systemEvent = parsed;
    }
  }

  // Extract from result event (preferred)
  if (resultEvent) {
    const usage = resultEvent.usage
      ? {
          inputTokens: numberOrZero(resultEvent.usage.input_tokens),
          outputTokens: numberOrZero(resultEvent.usage.output_tokens),
          cacheReadInputTokens: numberOrZero(resultEvent.usage.cache_read_input_tokens),
          cacheCreationInputTokens: numberOrZero(resultEvent.usage.cache_creation_input_tokens),
        }
      : null;

    return {
      text: typeof resultEvent.result === "string" ? resultEvent.result : "",
      costUsd: numberOrNull(resultEvent.total_cost_usd),
      usage,
      sessionId: stringOrNull(resultEvent.session_id) ?? stringOrNull(systemEvent?.session_id),
      model: stringOrNull(systemEvent?.model) ?? stringOrNull(resultEvent.model),
      durationApiMs: numberOrNull(resultEvent.duration_api_ms),
      isError: resultEvent.is_error === true,
      numTurns: numberOrNull(resultEvent.num_turns),
    };
  }

  // Fallback: extract text from assistant event
  if (assistantEvent) {
    const message = assistantEvent.message;
    let text = "";
    if (message?.content && Array.isArray(message.content)) {
      text = message.content
        .filter(
          (block: any) =>
            block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string"
        )
        .map((block: any) => block.text)
        .join("");
    }

    return {
      text,
      costUsd: null,
      usage: null,
      sessionId: stringOrNull(systemEvent?.session_id),
      model: stringOrNull(systemEvent?.model) ?? stringOrNull(message?.model),
      durationApiMs: null,
      isError: false,
      numTurns: null,
    };
  }

  // No result or assistant event found — return empty
  return {
    text: "",
    costUsd: null,
    usage: null,
    sessionId: stringOrNull(systemEvent?.session_id),
    model: stringOrNull(systemEvent?.model),
    durationApiMs: null,
    isError: false,
    numTurns: null,
  };
}
