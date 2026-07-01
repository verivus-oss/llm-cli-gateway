/**
 * The canonical CLI provider enum. This tuple is the ENUM SOURCE for provider
 * identity: `src/provider-definitions.ts` keys its registry off it
 * (`satisfies Record<CliType, ProviderDefinition>`), so every provider surface
 * derives from here. This file is on the `provider:surfaces:check` allowlist
 * because it is the one sanctioned place that spells the provider names out.
 * Do not copy this list into any other module; import the registry instead.
 */
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
