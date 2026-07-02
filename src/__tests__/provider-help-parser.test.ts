import { describe, it, expect } from "vitest";

import { parseHelpText } from "../provider-help-parser.js";

// Real `claude mcp --help` (claude 2.1.198). Subcommands like `get <name>`,
// `login [options] <name>`, `remove [options] <name>`, and
// `add [options] <name> <commandOrUrl> [args...]` put the usage arg one SINGLE
// space after the name, and the block includes indented example lines.
const CLAUDE_MCP_HELP = `Usage: claude mcp [options] [command]

Configure and manage MCP servers

Options:
  -h, --help                            Display help for command

Commands:
  add [options] <name> <commandOrUrl> [args...]  Add an MCP server to Claude Code.

  Examples:
    # Add HTTP server:
    claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

    # Add stdio server with environment variables:
    claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server
  add-from-claude-desktop [options]     Import MCP servers from Claude Desktop
                                        (Mac and WSL only)
  add-json [options] <name> <json>      Add an MCP server (stdio or SSE) with a
                                        JSON string
  get <name>                            Get details about an MCP server.
  help [command]                        display help for command
  list                                  List configured MCP servers.
  login [options] <name>                Authenticate with an MCP server (HTTP,
                                        SSE, or claude.ai connector)
  logout <name>                         Clear stored OAuth credentials for an
                                        MCP server
  remove [options] <name>               Remove an MCP server
  reset-project-choices                 Reset all approved and rejected
                                        project-scoped (.mcp.json) servers
  serve [options]                       Start the Claude Code MCP server
`;

describe("provider-help-parser subcommand extraction (BLOCKER 3)", () => {
  it("extracts arg-bearing subcommands whose usage arg follows a single space", () => {
    const parsed = parseHelpText(CLAUDE_MCP_HELP);
    const names = new Set(parsed.subcommands.map(s => s.name));

    // Mutation probe: revert the parser regex to the name-then-2-spaces form
    // (`/^([a-zA-Z][a-zA-Z0-9_-]*)(?:\\s{2,}(.*))?$/`) -> get/login/logout/remove/
    // add/add-json/add-from-claude-desktop are all dropped -> these flip red.
    for (const expected of [
      "add",
      "add-from-claude-desktop",
      "add-json",
      "get",
      "list",
      "login",
      "logout",
      "remove",
      "reset-project-choices",
      "serve",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("keeps the leading NAME token and its description for arg-bearing subcommands", () => {
    const byName = new Map(parseHelpText(CLAUDE_MCP_HELP).subcommands.map(s => [s.name, s]));
    expect(byName.get("get")?.description).toMatch(/Get details about an MCP server/);
    expect(byName.get("login")?.description).toMatch(/Authenticate with an MCP server/);
    expect(byName.get("remove")?.description).toMatch(/Remove an MCP server/);
  });

  it("does not misclassify `help`, indented examples, or flag lines as subcommands", () => {
    const names = new Set(parseHelpText(CLAUDE_MCP_HELP).subcommands.map(s => s.name));
    // `help` is skipped by design.
    expect(names.has("help")).toBe(false);
    // Indented example lines like `claude mcp add --transport http ...` (single
    // spaces, plain words, no 2-space description gap) must NOT become a
    // subcommand named `claude`.
    expect(names.has("claude")).toBe(false);
    expect(names.has("Examples")).toBe(false);
    // The `-h, --help` line is a flag, not a subcommand.
    expect(names.has("h")).toBe(false);
  });
});
