/**
 * Parsers for Gemini CLI `-o json` (single object) and `-o stream-json`
 * (NDJSON event stream) output.
 *
 * `-o json` emits a single JSON object with:
 *   - `response`: string final model output
 *   - `usageMetadata`: { promptTokenCount, candidatesTokenCount,
 *                        cachedContentTokenCount?, totalTokenCount }
 *
 * `-o stream-json` emits one JSON object per line:
 *   - `{ "type": "init", "session_id": "...", "model": "..." }`
 *   - `{ "type": "message", "role": "user", "content": "..." }`
 *   - `{ "type": "message", "role": "assistant", "content": "...", "delta": true }` (repeated)
 *   - `{ "type": "result", "status": "success", "stats": { "input_tokens": N,
 *        "output_tokens": N, "cached": N, ... } }`
 *
 * Both parsers return null when stdout is unparseable. Both populate the same
 * `GeminiJsonParseResult` shape so `extractUsageAndCost` can branch on
 * outputFormat without further dispatch.
 */

export interface GeminiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
}

export interface GeminiJsonParseResult {
  usage?: GeminiUsage;
  response?: string;
  /**
   * Session/conversation id. Present in the `stream-json` init event
   * (`{ "type": "init", "session_id": "..." }`) and extracted here so a
   * deferred Gemini job keeps the id needed to resume (`--conversation <id>`).
   * `-o json` (single object) does not emit a session id, so it stays
   * undefined there (typed capability fact: id absent on that transport).
   */
  sessionId?: string;
  /**
   * Stop reason mapped from the terminal `result` event `status`
   * ("success" / "error" / …), WHERE upstream supplies it. Undefined when no
   * result event carried a status.
   */
  stopReason?: string;
}

export function parseGeminiJson(stdout: string): GeminiJsonParseResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const result: GeminiJsonParseResult = {};

  if (typeof parsed.response === "string") {
    result.response = parsed.response;
  }

  // Defensive: `-o json` does not emit a session id today, but if a build ever
  // adds one at the top level, surface it rather than silently dropping it.
  if (typeof parsed.session_id === "string") {
    result.sessionId = parsed.session_id;
  } else if (typeof parsed.sessionId === "string") {
    result.sessionId = parsed.sessionId;
  }
  if (typeof parsed.status === "string") {
    result.stopReason = parsed.status;
  }

  const meta = parsed.usageMetadata;
  if (meta && typeof meta === "object") {
    const input = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : undefined;
    const output =
      typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : undefined;
    if (input !== undefined || output !== undefined) {
      const usage: GeminiUsage = {
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
      };
      if (typeof meta.cachedContentTokenCount === "number") {
        usage.cache_read_tokens = meta.cachedContentTokenCount;
      }
      result.usage = usage;
    }
  }

  return result;
}

/**
 * Parse Gemini `-o stream-json` NDJSON output. Concatenates assistant `delta`
 * message content into `response`, extracts the terminal `result.stats` payload
 * into `usage`. Returns null when stdout contains no parseable JSON line.
 */
export function parseGeminiStreamJson(stdout: string): GeminiJsonParseResult | null {
  if (!stdout) {
    return null;
  }

  const lines = stdout.split(/\r?\n/);
  const result: GeminiJsonParseResult = {};
  const assistantChunks: string[] = [];
  let sawAnyLine = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Gemini stream-json lines are individual JSON objects; non-JSON
    // chatter (warnings, "Ripgrep not available", etc.) is silently
    // ignored so a stray banner line doesn't poison usage extraction.
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    sawAnyLine = true;

    // The `init` event carries the session id (previously dropped). Extract it
    // so a deferred Gemini job retains the id needed to resume the conversation.
    if (event.type === "init" && typeof event.session_id === "string") {
      result.sessionId = event.session_id;
      continue;
    }

    if (
      event.type === "message" &&
      event.role === "assistant" &&
      typeof event.content === "string"
    ) {
      assistantChunks.push(event.content);
      continue;
    }

    if (event.type === "result") {
      if (typeof event.status === "string") {
        result.stopReason = event.status;
      }
    }

    if (event.type === "result" && event.stats && typeof event.stats === "object") {
      const stats = event.stats;
      const input = typeof stats.input_tokens === "number" ? stats.input_tokens : undefined;
      const output = typeof stats.output_tokens === "number" ? stats.output_tokens : undefined;
      if (input !== undefined || output !== undefined) {
        const usage: GeminiUsage = {
          input_tokens: input ?? 0,
          output_tokens: output ?? 0,
        };
        if (typeof stats.cached === "number") {
          usage.cache_read_tokens = stats.cached;
        }
        result.usage = usage;
      }
    }
  }

  if (!sawAnyLine) {
    return null;
  }

  if (assistantChunks.length > 0) {
    result.response = assistantChunks.join("");
  }

  return result;
}
