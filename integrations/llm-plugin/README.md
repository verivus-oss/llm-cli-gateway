# llm-gateway

An [llm](https://llm.datasette.io/) plugin that provides access to Claude, Codex, Gemini, Grok, and Mistral (Vibe)
through the [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) MCP server.

## Installation

    llm install llm-gateway

## Usage

    llm -m gateway-claude "Explain this function"
    llm -m gateway-codex "Implement a binary search"
    llm -m gateway-gemini "Review this code for bugs"
    llm -m gateway-grok "Find race conditions in this concurrent code"
    llm -m gateway-mistral "Refactor this Python module for readability"

## Requirements

- Node.js 18+ (for the gateway runtime)
- At least one of: Claude Code CLI, Codex CLI, Gemini CLI, Grok CLI, or Mistral Vibe CLI
