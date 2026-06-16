/**
 * ACP session/update event normalizer (plan step `normalize-session-updates`).
 *
 * Converts streamed ACP `session/update` notifications into:
 *
 *   - a structured, gateway-neutral {@link AcpProgressEvent} for each update
 *     (suitable for async-job progress logs and, after the Slice B6 redaction
 *     helpers, the flight recorder), and
 *   - an accumulated final response text for the synchronous reply
 *     ({@link AcpEventNormalizer.finalText}), built ONLY from the agent's
 *     message chunks (not its private thoughts, and not user echoes).
 *
 * Content redaction (`redact or summarize file content events`): binary/content
 * blocks (`image`, `audio`, `resource`, `resource_link`) are NEVER embedded.
 * Their base64/URI payloads are replaced with a short `[image]` / `[audio]` /
 * `[resource]` placeholder in both the accumulated text and the progress event,
 * so file/content bytes can never leak through a normalized update. Only `text`
 * blocks contribute their text.
 */

import type { ContentBlock, SessionUpdateNotification } from "./types.js";

/** A normalized, gateway-neutral progress event for one `session/update`. */
export type AcpProgressEvent =
  | { readonly kind: "agent_message"; readonly text: string }
  | { readonly kind: "agent_thought"; readonly text: string }
  | { readonly kind: "user_message"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly status?: string;
      readonly toolKind?: string;
    }
  | {
      readonly kind: "tool_update";
      readonly toolCallId: string;
      readonly status?: string;
      readonly title?: string;
    }
  | { readonly kind: "plan"; readonly entryCount: number }
  | { readonly kind: "mode"; readonly currentModeId: string }
  | { readonly kind: "usage"; readonly size: number; readonly used: number }
  | { readonly kind: "other"; readonly sessionUpdate: string };

/** Field accessor that tolerates the open `ContentBlock` / update shapes. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Summarize a single content block to a display string WITHOUT ever embedding
 * binary/resource payloads. `text` blocks return their text; every other block
 * type returns a short `[type]` placeholder (no base64 data, no resource URI).
 */
export function summarizeContentBlock(block: ContentBlock): string {
  if (block.type === "text") {
    return str(block.text) ?? "";
  }
  // image / audio / resource / resource_link / unknown: summarize only.
  return `[${block.type}]`;
}

/** Pull the display text from a message-chunk update's `content` block. */
function chunkText(update: Record<string, unknown>): string {
  const content = update.content;
  if (content && typeof content === "object") {
    return summarizeContentBlock(content as ContentBlock);
  }
  return "";
}

/**
 * Normalize a single `session/update` into a structured {@link AcpProgressEvent}.
 * Unknown discriminators degrade to `{ kind: "other" }` so a new provider
 * variant never crashes the stream. Pure; accumulates nothing.
 */
export function normalizeSessionUpdate(notification: SessionUpdateNotification): AcpProgressEvent {
  const update = notification.update as Record<string, unknown>;
  const variant = str(update.sessionUpdate) ?? "";
  switch (variant) {
    case "agent_message_chunk":
      return { kind: "agent_message", text: chunkText(update) };
    case "agent_thought_chunk":
      return { kind: "agent_thought", text: chunkText(update) };
    case "user_message_chunk":
      return { kind: "user_message", text: chunkText(update) };
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: str(update.toolCallId) ?? "",
        title: str(update.title) ?? "",
        status: str(update.status),
        toolKind: str(update.kind),
      };
    case "tool_call_update":
      return {
        kind: "tool_update",
        toolCallId: str(update.toolCallId) ?? "",
        status: str(update.status),
        title: str(update.title),
      };
    case "plan":
      return {
        kind: "plan",
        entryCount: Array.isArray(update.entries) ? update.entries.length : 0,
      };
    case "current_mode_update":
      return { kind: "mode", currentModeId: str(update.currentModeId) ?? "" };
    case "usage_update":
      return {
        kind: "usage",
        size: typeof update.size === "number" ? update.size : 0,
        used: typeof update.used === "number" ? update.used : 0,
      };
    default:
      // available_commands_update and any unknown/future variant.
      return { kind: "other", sessionUpdate: variant };
  }
}

/**
 * Stateful normalizer for one ACP turn. Feed it each `session/update`; it
 * returns the per-update {@link AcpProgressEvent} and accumulates the final
 * agent response text (agent message chunks only — never thoughts, tool calls,
 * or user echoes).
 */
export class AcpEventNormalizer {
  private text = "";

  /**
   * Normalize one update, accumulate agent message text, and return the
   * structured event for streaming/logging.
   */
  handle(notification: SessionUpdateNotification): AcpProgressEvent {
    const event = normalizeSessionUpdate(notification);
    if (event.kind === "agent_message") {
      this.text += event.text;
    }
    return event;
  }

  /** The accumulated agent response text for the synchronous reply. */
  get finalText(): string {
    return this.text;
  }
}
