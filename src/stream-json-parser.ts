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
    const usage = resultEvent.usage ? {
      inputTokens: resultEvent.usage.input_tokens ?? 0,
      outputTokens: resultEvent.usage.output_tokens ?? 0,
      cacheReadInputTokens: resultEvent.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: resultEvent.usage.cache_creation_input_tokens ?? 0,
    } : null;

    return {
      text: resultEvent.result ?? "",
      costUsd: resultEvent.total_cost_usd ?? null,
      usage,
      sessionId: resultEvent.session_id ?? systemEvent?.session_id ?? null,
      model: systemEvent?.model ?? resultEvent.model ?? null,
      durationApiMs: resultEvent.duration_api_ms ?? null,
      isError: resultEvent.is_error === true,
      numTurns: resultEvent.num_turns ?? null,
    };
  }

  // Fallback: extract text from assistant event
  if (assistantEvent) {
    const message = assistantEvent.message;
    let text = "";
    if (message?.content && Array.isArray(message.content)) {
      text = message.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
    }

    return {
      text,
      costUsd: null,
      usage: null,
      sessionId: systemEvent?.session_id ?? null,
      model: systemEvent?.model ?? message?.model ?? null,
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
    sessionId: systemEvent?.session_id ?? null,
    model: systemEvent?.model ?? null,
    durationApiMs: null,
    isError: false,
    numTurns: null,
  };
}
