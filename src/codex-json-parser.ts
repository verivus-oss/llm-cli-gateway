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
  finalMessage?: string;
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
