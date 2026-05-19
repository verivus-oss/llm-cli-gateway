/**
 * Parser for Gemini CLI `-o json` output.
 *
 * Gemini emits a single JSON object with:
 *   - `response`: string final model output
 *   - `usageMetadata`: { promptTokenCount, candidatesTokenCount,
 *                        cachedContentTokenCount?, totalTokenCount }
 *
 * Returns null when stdout is not parseable as JSON. Returns an object with
 * only `response` when usageMetadata is missing.
 */

export interface GeminiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
}

export interface GeminiJsonParseResult {
  usage?: GeminiUsage;
  response?: string;
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

  const meta = parsed.usageMetadata;
  if (meta && typeof meta === "object") {
    const input =
      typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : undefined;
    const output =
      typeof meta.candidatesTokenCount === "number"
        ? meta.candidatesTokenCount
        : undefined;
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
