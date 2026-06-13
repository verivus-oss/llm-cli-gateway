/**
 * Parser for Codex CLI `--json` JSONL event stream.
 *
 * Codex emits one JSON object per line, e.g.:
 *   {"type":"thread.started","thread_id":"t-abc"}
 *   {"type":"turn.started","turn_id":"u-001"}
 *   {"type":"item.started","item":{...}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...,...}}
 *   {"type":"turn.failed","error":{...}}
 *   {"type":"error","message":"..."}
 *
 * This parser is lenient: malformed lines are skipped, partial streams are
 * tolerated (usage is `undefined` if no turn.completed event arrived), and
 * error events are surfaced.
 *
 * Cost is intentionally NOT computed here — Codex does not price client-side
 * and U23 only plumbs tokens. A future unit can compute cost from the model
 * registry.
 */

export interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
}

export interface CodexJsonParseResult {
  usage?: CodexUsage;
  error?: string;
  threadId?: string;
  /**
   * The LAST `agent_message` text. This is the reply `codex exec` prints to
   * stdout in text mode: a multi-message turn emits several `agent_message`
   * events but text-mode stdout shows ONLY the final one (verified against
   * codex-cli 0.139.0). `codexDisplayText` returns exactly this for #44.
   */
  finalMessage?: string;
  /**
   * True if ANY line parsed as a JSON object — i.e. stdout is a Codex `--json`
   * event stream, even when no event we specifically handle (thread.started /
   * turn.completed / agent_message …) was present or the schema drifted. Lets
   * `codexDisplayText` distinguish "a codex stream with no reply" (return "")
   * from "not a codex stream at all" (surface stdout verbatim).
   */
  sawEvent?: boolean;
}

export function parseCodexJsonStream(stdout: string): CodexJsonParseResult {
  const lines = stdout.split("\n").filter(line => line.trim().length > 0);

  const result: CodexJsonParseResult = {};
  let lastAgentMessage: string | undefined;

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip preamble/garbage lines that aren't valid JSON.
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    // Any well-formed JSON object line means stdout is a codex `--json` event
    // stream — every codex event is a JSON object, including ones whose `type`
    // the switch below does not branch on (turn.started / item.started) or that
    // drift in schema. codexDisplayText() uses this to return "" rather than
    // leaking raw JSONL when a stream carried no reply.
    result.sawEvent = true;

    switch (parsed.type) {
      case "thread.started":
        if (typeof parsed.thread_id === "string") {
          result.threadId = parsed.thread_id;
        }
        break;
      case "turn.completed": {
        const u = parsed.usage;
        if (u && typeof u === "object") {
          const usage: CodexUsage = {
            input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
            output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
          };
          if (typeof u.cached_input_tokens === "number") {
            usage.cache_read_tokens = u.cached_input_tokens;
          } else if (typeof u.cache_read_input_tokens === "number") {
            usage.cache_read_tokens = u.cache_read_input_tokens;
          } else if (typeof u.cache_read_tokens === "number") {
            usage.cache_read_tokens = u.cache_read_tokens;
          }
          if (typeof u.cache_creation_input_tokens === "number") {
            usage.cache_creation_tokens = u.cache_creation_input_tokens;
          } else if (typeof u.cache_creation_tokens === "number") {
            usage.cache_creation_tokens = u.cache_creation_tokens;
          }
          if (typeof u.cost_usd === "number") {
            usage.cost_usd = u.cost_usd;
          }
          result.usage = usage;
        }
        break;
      }
      case "turn.failed": {
        const err = parsed.error;
        if (typeof err === "string") {
          result.error = err;
        } else if (err && typeof err === "object" && typeof err.message === "string") {
          result.error = err.message;
        } else {
          result.error = "turn failed";
        }
        break;
      }
      case "error":
        if (typeof parsed.message === "string") {
          result.error = parsed.message;
        }
        break;
      case "item.completed": {
        const item = parsed.item;
        if (
          item &&
          typeof item === "object" &&
          item.type === "agent_message" &&
          typeof item.text === "string"
        ) {
          lastAgentMessage = item.text;
        }
        break;
      }
      default:
        break;
    }
  }

  if (lastAgentMessage !== undefined) {
    result.finalMessage = lastAgentMessage;
  }

  return result;
}

/**
 * #44: Derive the caller-facing reply from a Codex `--json` stream.
 *
 * The gateway runs `codex exec --json` on EVERY request so token usage (incl.
 * `cached_input_tokens`) is always recorded in the flight recorder. But in the
 * default `text` output mode the caller still expects the plain reply Codex
 * would have printed to stdout, not the raw JSONL event stream. Codex `exec`
 * text mode (non-TTY) prints ONLY the final `agent_message` — even when a turn
 * emitted several (verified against codex-cli 0.139.0: a two-message turn prints
 * just the last). So `finalMessage` reproduces text-mode stdout exactly.
 *
 * Fallback chain — always returns a string and NEVER leaks the raw JSONL event
 * stream to the caller:
 *   1. the final agent_message, else
 *   2. the parsed error text (error turn), else
 *   3. "" when this IS a codex JSONL event stream (any typed event seen) but
 *      carried no reply — emptier is better than dumping events, else
 *   4. the original `stdout` when it is NOT a codex JSONL stream at all (e.g. a
 *      pre-stream fatal line printed before any event) — worth surfacing.
 */
export function codexDisplayText(stdout: string): string {
  const parsed = parseCodexJsonStream(stdout);
  if (parsed.finalMessage !== undefined) {
    return parsed.finalMessage;
  }
  if (parsed.error !== undefined) {
    return parsed.error;
  }
  // `sawEvent` is set for ANY JSON-object line, so a stream that only emitted
  // events the parser doesn't branch on — or whose schema drifted — still
  // resolves to "" rather than leaking raw JSONL to the caller. Only genuinely
  // non-JSONL stdout (no parseable object line) falls through to `return stdout`.
  if (parsed.sawEvent) {
    return "";
  }
  return stdout;
}

/**
 * #44: the value to persist as the flight-recorder `response` (and surface via
 * llm_request_result / cache-stats) for a codex run. Shared by the sync handler
 * and AsyncJobManager so both writers agree byte-for-byte. In the default `text`
 * mode this is the reconstructed reply (== text-mode stdout); in `json` mode the
 * caller asked for the raw event stream, so it is persisted verbatim. Usage
 * tokens are extracted separately from the raw stdout and are unaffected.
 */
export function codexFrResponse(outputFormat: string | undefined, stdout: string): string {
  return outputFormat === "json" ? stdout : codexDisplayText(stdout);
}
