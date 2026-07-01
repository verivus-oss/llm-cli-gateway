export const CLI_TYPES = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "mistral",
  "devin",
  "cursor",
] as const;

export type CliType = (typeof CLI_TYPES)[number];

/**
 * Known API-backed provider ids baked into the in-tree config. `grok-api` is
 * the HTTP provider that predates Slice 0.5.
 */
export const API_PROVIDER_TYPES = ["grok-api"] as const;
export type KnownApiProviderType = (typeof API_PROVIDER_TYPES)[number];
