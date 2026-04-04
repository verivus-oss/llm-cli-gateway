# llm-gateway

An [llm](https://llm.datasette.io/) plugin that provides access to Claude, Codex, and Gemini
through the [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) MCP server.

## Installation

    llm install llm-gateway

## Usage

    llm -m gateway-claude "Explain this function"
    llm -m gateway-codex "Implement a binary search"
    llm -m gateway-gemini "Review this code for bugs"

## Requirements

- Node.js 18+ (for the gateway runtime)
- At least one of: Claude Code CLI, Codex CLI, Gemini CLI
