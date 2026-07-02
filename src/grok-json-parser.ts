/**
 * Parser for Grok Build CLI headless `-p` output in `json` and
 * `streaming-json` modes.
 *
 * The gateway drives Grok through its HEADLESS single-turn surface
 * (`prepareGrokRequest` → `grok -p <prompt> --output-format <plain|json|
 * streaming-json>`). The two structured modes were live-verified against the
 * Grok Build CLI (2026-06-13):
 *
 *   - `-p --output-format json`            → ONE JSON object:
 *       { "text": "...", "stopReason": "...", "sessionId": "...",
 *         "requestId": "...", "thought": "..." }
 *
 *   - `-p --output-format streaming-json`  → NDJSON: a stream of delta objects
 *       { "type": "thought", ... } / { "type": "text", ... }
 *     terminated by a single
 *       { "type": "end", "stopReason": "...", "sessionId": "...",
 *         "requestId": "..." }
 *
 * Capability fact (do NOT fabricate): the Grok `-p` wire emits NO per-request
 * token usage/cost in EITHER structured mode. `usageAbsent` records that fact
 * so downstream telemetry marks usage as genuinely-not-emitted rather than
 * silently dropping it. (The `grok agent stdio` ACP transport DOES expose
 * usage in its `session/prompt` `_meta`; that is a separate surface handled by
 * the ACP runtime, not this `-p` parser.)
 *
 * Lenient by design: malformed lines are skipped, partial streams are
 * tolerated, and both entry points return `null` when stdout is not a Grok
 * structured stream at all (so callers can fall back to raw plain-text stdout).
 * The field-name idioms mirror `codex-json-parser.ts`.
 */

export interface GrokJsonParseResult {
  /** Final assistant text (json `text`, or concatenated streaming `text` deltas). */
  text?: string;
  /** Upstream stop reason (json `stopReason` / streaming `end.stopReason`). */
  stopReason?: string;
  /** Provider session id needed to resume (json `sessionId` / streaming `end.sessionId`). */
  sessionId?: string;
  /** Upstream request id, when present. */
  requestId?: string;
  /** Concatenated reasoning/thought text, when Grok emits it. */
  thought?: string;
  /** Surfaced error text, when Grok reports one. */
  error?: string;
  /**
   * True when at least one well-formed JSON object was seen. Lets callers
   * distinguish "a Grok structured stream that carried no reply" from
   * "not a Grok structured stream at all" (parse returns null in the latter).
   */
  sawEvent?: boolean;
  /**
   * Typed capability fact: the Grok `-p` wire never carries token usage/cost
   * in json or streaming-json mode. Always `true` for a parsed Grok structured
   * result; consumers must NOT invent usage numbers when this is set.
   */
  usageAbsent: true;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Pull the incremental text payload out of a streaming delta object. The REAL
 * Grok `-p --output-format streaming-json` wire carries the delta payload in a
 * `data` field (`{ type: "text", data: "hello" }`), confirmed by the live
 * capture in test-veracity-regressions-slice-epsilon.test.ts. `text` is the
 * json-mode field name and is accepted here too, with `content` / `delta`
 * retained as defensive fallbacks so a minor upstream rename does not silently
 * drop the reply.
 */
function deltaText(event: Record<string, unknown>): string | undefined {
  return str(event.data) ?? str(event.text) ?? str(event.content) ?? str(event.delta);
}

function deltaThought(event: Record<string, unknown>): string | undefined {
  return (
    str(event.data) ??
    str(event.thought) ??
    str(event.text) ??
    str(event.content) ??
    str(event.delta)
  );
}

/**
 * Parse a single JSON object from text that may be wrapped in non-JSON banner
 * lines. Tries a whole-buffer parse first, then the substring from the first
 * `{` to the last `}`, so a stray deprecation/warning line does not discard all
 * telemetry from an otherwise valid object. Rejects arrays. Returns null when no
 * JSON object can be recovered.
 */
function parseTolerantGrokObject(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through to substring recovery
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse Grok `-p --output-format json` output (a single JSON object).
 * Returns `null` when stdout is empty or not a JSON object.
 */
export function parseGrokJson(stdout: string): GrokJsonParseResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseTolerantGrokObject(trimmed);
  if (!parsed) {
    return null;
  }

  const result: GrokJsonParseResult = { sawEvent: true, usageAbsent: true };
  const text = str(parsed.text);
  if (text !== undefined) result.text = text;
  const stopReason = str(parsed.stopReason);
  if (stopReason !== undefined) result.stopReason = stopReason;
  const sessionId = str(parsed.sessionId);
  if (sessionId !== undefined) result.sessionId = sessionId;
  const requestId = str(parsed.requestId);
  if (requestId !== undefined) result.requestId = requestId;
  const thought = str(parsed.thought);
  if (thought !== undefined) result.thought = thought;
  const error = str(parsed.error);
  if (error !== undefined) result.error = error;

  return result;
}

/**
 * Parse Grok `-p --output-format streaming-json` NDJSON output: concatenates
 * `text` deltas into `text` and `thought` deltas into `thought`, and lifts the
 * terminal `{type:"end", ...}` metadata (stopReason / sessionId / requestId).
 * Returns `null` when stdout contains no parseable JSON line.
 */
export function parseGrokStreamingJson(stdout: string): GrokJsonParseResult | null {
  if (!stdout) {
    return null;
  }

  const lines = stdout.split(/\r?\n/);
  const result: GrokJsonParseResult = { usageAbsent: true };
  const textChunks: string[] = [];
  const thoughtChunks: string[] = [];
  let sawAnyLine = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON banner/warning chatter is ignored so it can't poison parsing.
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    sawAnyLine = true;

    switch (str(event.type)) {
      case "text": {
        const t = deltaText(event);
        if (t !== undefined) textChunks.push(t);
        break;
      }
      case "thought": {
        const t = deltaThought(event);
        if (t !== undefined) thoughtChunks.push(t);
        break;
      }
      case "end": {
        const stopReason = str(event.stopReason);
        if (stopReason !== undefined) result.stopReason = stopReason;
        const sessionId = str(event.sessionId);
        if (sessionId !== undefined) result.sessionId = sessionId;
        const requestId = str(event.requestId);
        if (requestId !== undefined) result.requestId = requestId;
        break;
      }
      case "error": {
        const error = str(event.error) ?? str(event.message);
        if (error !== undefined) result.error = error;
        break;
      }
      default:
        break;
    }
  }

  if (!sawAnyLine) {
    return null;
  }

  result.sawEvent = true;
  if (textChunks.length > 0) result.text = textChunks.join("");
  if (thoughtChunks.length > 0) result.thought = thoughtChunks.join("");

  return result;
}

/**
 * Dispatch on the caller-facing `outputFormat`. Returns `null` for `plain`
 * (or undefined) mode, where stdout is already the human reply and there is
 * nothing structured to parse.
 */
export function parseGrokOutput(
  outputFormat: string | undefined,
  stdout: string
): GrokJsonParseResult | null {
  if (outputFormat === "json") return parseGrokJson(stdout);
  if (outputFormat === "streaming-json") return parseGrokStreamingJson(stdout);
  return null;
}

/**
 * Derive the caller-facing reply from Grok structured output. In `json` mode
 * the caller asked for the raw object, so it is returned verbatim (mirrors the
 * codex `json` contract). In `streaming-json` mode the raw NDJSON is not a
 * human reply, so the concatenated `text` deltas are returned; a stream that
 * carried no reply resolves to "" rather than leaking raw NDJSON. `plain`
 * (or unparseable) stdout is returned unchanged.
 */
export function grokDisplayText(outputFormat: string | undefined, stdout: string): string {
  if (outputFormat === "json") {
    return stdout;
  }
  if (outputFormat === "streaming-json") {
    const parsed = parseGrokStreamingJson(stdout);
    if (!parsed) return stdout;
    if (parsed.text !== undefined) return parsed.text;
    if (parsed.error !== undefined) return parsed.error;
    return "";
  }
  return stdout;
}
