import { describe, expect, it } from "vitest";
import {
  PACKED_INTERNAL_MCP_ALIASES,
  PUBLIC_INTERNAL_MCP_ALIASES,
  findInternalMcpAliases,
} from "./internal-mcp-alias-policy.mjs";

describe("internal MCP alias policy", () => {
  it("detects canonical MCP tool names in the public-site gate", () => {
    expect(findInternalMcpAliases("mcp__sqry__query", PUBLIC_INTERNAL_MCP_ALIASES)).toEqual([
      "sqry",
    ]);
    expect(findInternalMcpAliases("mcp__ref_tools__search", PUBLIC_INTERNAL_MCP_ALIASES)).toEqual([
      "ref_tools",
    ]);
  });

  it("detects canonical gateway aliases in the packed-release gate", () => {
    expect(
      findInternalMcpAliases("mcp__gtwy__claude_request", PACKED_INTERNAL_MCP_ALIASES)
    ).toEqual(["gtwy"]);
    expect(findInternalMcpAliases("mcp__exa__search", PACKED_INTERNAL_MCP_ALIASES)).toEqual([
      "exa",
    ]);
  });

  it("does not match unrelated alphanumeric text or uppercase environment names", () => {
    expect(
      findInternalMcpAliases("example exact EXA_API_KEY", PACKED_INTERNAL_MCP_ALIASES)
    ).toEqual([]);
  });
});
