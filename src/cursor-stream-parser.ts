/**
 * Cursor Agent `--print --output-format stream-json` NDJSON.
 *
 * Measured against cursor-agent 2026.08.31-4057e58 in
 * docs/evidence/c1-capture-ceiling-2026-09-02.md:
 *   - `{ "type": "system", "subtype": "init", "cwd": ..., "session_id": ...,
 *        "model": ..., "permissionMode": ... }`
 *   - `{ "type": "user"|"assistant", "message": { role, content: [...] } }`
 *   - `{ "type": "thinking", "subtype": "delta", "text": ... }`   reasoning
 *   - `{ "type": "tool_call", "subtype": "started"|"completed",
 *        "tool_call": { "<name>ToolCall": { args, result } } }`   call + RESULT
 *   - `{ "type": "result", "subtype": "success", "is_error": false,
 *        "session_id": ..., "usage": { inputTokens, outputTokens,
 *        cacheReadTokens, cacheWriteTokens } }`
 *
 * The session id was on this wire and was not being extracted, so a cursor job
 * recorded no `provider_session_id` despite carrying one on every line.
 */

export interface CursorStreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
}

export interface CursorStreamParseResult {
  sessionId?: string;
  stopReason?: string;
  response?: string;
  usage?: CursorStreamUsage;
}

function cursorUsage(value: unknown): CursorStreamUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  if (typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") return null;
  const usage: CursorStreamUsage = {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
  };
  if (typeof u.cacheReadTokens === "number") usage.cache_read_tokens = u.cacheReadTokens;
  return usage;
}

/** Returns null when stdout carries no parseable Cursor event. */
export function parseCursorStreamJson(stdout: string): CursorStreamParseResult | null {
  if (!stdout) return null;
  const result: CursorStreamParseResult = {};
  let sawEvent = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.type !== "string") continue;
    sawEvent = true;
    if (typeof event.session_id === "string") result.sessionId = event.session_id;
    if (event.type === "result") {
      // `subtype` names the outcome ("success"); `is_error` is the boolean the
      // CLI sets alongside it. Prefer the name, fall back to the boolean, so an
      // unnamed failure is still reported as one.
      if (typeof event.subtype === "string") result.stopReason = event.subtype;
      else if (typeof event.is_error === "boolean")
        result.stopReason = event.is_error ? "error" : "success";
      if (typeof event.result === "string") result.response = event.result;
      const usage = cursorUsage(event.usage);
      if (usage) result.usage = usage;
    }
  }

  return sawEvent ? result : null;
}
