/**
 * Mistral Vibe `--output streaming` NDJSON.
 *
 * Measured against vibe 2.24.5 in docs/evidence/c1-capture-ceiling-2026-09-02.md.
 * One JSON object per line, every one stamped with the same `sessionId` and
 * `turnId`:
 *   - `{ "type": "message", "role": "user"|"assistant", "content": [...] }`
 *   - `{ "type": "reasoning", "text": "..." }`            reasoning PROSE
 *   - `{ "type": "effect", "title": "read_file",
 *        "detail": { "toolName": ..., "input": {...} } }` tool call and result
 *
 * WHY THIS MATTERS BEYOND ONE COLUMN. `parseVibeMetaJson` reads token and cost
 * usage from `~/.vibe/logs/session/<id>/meta.json` and returns nothing when the
 * id starts with `gw-`. Every fresh mistral request mints a `gw-*` id, so
 * mistral usage was unreachable. The real Vibe UUID was on this wire the whole
 * time and was being discarded because the gateway asked for `text`.
 *
 * `generationStatus` is per entry, not per turn, so the stop reason is the
 * LAST entry's status and not the first one seen.
 */

export interface VibeStreamParseResult {
  sessionId?: string;
  stopReason?: string;
  response?: string;
}

function assistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map(block => block.text);
  return parts.length > 0 ? parts.join("") : null;
}

/** Returns null when stdout carries no parseable Vibe entry. */
export function parseVibeStream(stdout: string): VibeStreamParseResult | null {
  if (!stdout) return null;
  const result: VibeStreamParseResult = {};
  let sawEntry = false;
  let lastAssistant: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON chatter (banners, trust prompts) is not an entry.
      continue;
    }
    if (typeof entry.sessionId !== "string" || typeof entry.type !== "string") continue;
    sawEntry = true;
    result.sessionId = entry.sessionId;
    if (typeof entry.generationStatus === "string") {
      result.stopReason = entry.generationStatus;
    }
    if (entry.type === "message" && entry.role === "assistant") {
      const text = assistantText(entry.content);
      if (text !== null) lastAssistant = text;
    }
  }

  if (!sawEntry) return null;
  if (lastAssistant !== null) result.response = lastAssistant;
  return result;
}
