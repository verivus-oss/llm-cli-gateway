// Public discovery is generated from a development build, while published
// package builds strip the internal MCP registry. Keep the projection and the
// fail-closed check together so Pages never publishes host-specific aliases.

import {
  PUBLIC_INTERNAL_MCP_ALIASES,
  findInternalMcpAliases,
} from "./internal-mcp-alias-policy.mjs";

export { PUBLIC_INTERNAL_MCP_ALIASES };

const internalAliasSet = new Set(PUBLIC_INTERNAL_MCP_ALIASES);

/**
 * Convert private development schema details to the public package contract.
 * A development build closes mcpServers to host-specific aliases; the stripped
 * package accepts an open string instead. Dropping an affected enum preserves
 * that public behavior without leaking the private values.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function projectPublicMcpAliases(value) {
  if (Array.isArray(value)) return value.map(projectPublicMcpAliases);
  if (!value || typeof value !== "object") return value;

  const projected = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      key === "enum" &&
      Array.isArray(candidate) &&
      candidate.some(item => typeof item === "string" && internalAliasSet.has(item))
    ) {
      continue;
    }
    projected[key] = projectPublicMcpAliases(candidate);
  }
  return projected;
}

/**
 * Fail closed when a public discovery artifact contains an internal MCP alias.
 * Projection handles known schema enums; this catches any future leak through a
 * description, example, or a different schema shape.
 *
 * @param {unknown} value
 * @param {string} artifact
 * @returns {void}
 */
export function assertNoPublicInternalMcpAliases(value, artifact) {
  const text = JSON.stringify(value);
  const leaked = findInternalMcpAliases(text, PUBLIC_INTERNAL_MCP_ALIASES);
  if (leaked.length > 0) {
    throw new Error(`${artifact} exposes internal MCP aliases: ${leaked.join(", ")}`);
  }
}
