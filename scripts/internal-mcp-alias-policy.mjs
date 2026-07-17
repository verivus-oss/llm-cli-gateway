export const PUBLIC_INTERNAL_MCP_ALIASES = Object.freeze([
  "sqry",
  "exa",
  "ref_tools",
  "trstr",
  "agent_browser",
  "agent-browser",
]);

export const PACKED_INTERNAL_MCP_ALIASES = Object.freeze(["gtwy", ...PUBLIC_INTERNAL_MCP_ALIASES]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match an alias as a token delimited by non-alphanumeric characters. MCP's
 * canonical tool form uses underscores (`mcp__alias__tool`), so JavaScript
 * word boundaries are insufficient because underscore is a word character.
 *
 * @param {string} text
 * @param {string} alias
 * @returns {boolean}
 */
export function containsInternalMcpAlias(text, alias) {
  return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(alias)}(?=$|[^A-Za-z0-9])`).test(text);
}

/**
 * @param {string} text
 * @param {readonly string[]} aliases
 * @returns {string[]}
 */
export function findInternalMcpAliases(text, aliases) {
  return aliases.filter(alias => containsInternalMcpAlias(text, alias));
}
