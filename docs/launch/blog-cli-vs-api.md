# Why CLI Wrapping Beats API Proxying for Multi-LLM Development

*Published 2026-03-31 by VerivusAI Labs*

The multi-LLM orchestration space has a dozen tools now. LiteLLM, PAL MCP, Claude Octopus, Zen MCP -- most of them proxy API calls to multiple providers. You send a prompt, they forward it to OpenAI or Anthropic or Google's API, and you get text back.

**llm-cli-gateway** does something different. It wraps the CLI binaries -- `claude`, `codex`, `gemini` -- as child processes. When you call `codex_request`, the gateway literally spawns `codex --quiet` with your prompt. This is not a philosophical distinction. It changes what the tool can do.

## What CLI tools have that APIs don't

When you install Codex or Claude Code, you get a full agent runtime. Codex runs in a sandboxed environment where it can read your files, execute shell commands, write code, and run tests. Claude Code has tool use, file access, and project context. Gemini CLI has similar capabilities.

API endpoints give you none of this. The OpenAI chat completions API takes a prompt and returns text. It cannot read your codebase. It cannot run your tests. It cannot verify that its suggested fix actually compiles. When PAL MCP sends your code review request to the OpenAI API, the model is reviewing code it can see in the prompt but cannot interact with. When llm-cli-gateway sends the same request to Codex, the CLI agent can read adjacent files, check imports, and (when sandbox permissions allow) run the test suite.

This matters most for implementation tasks. Asking an API to "implement retry logic in executor.ts" gets you a code block you have to paste. Asking the Codex CLI to do it gets you a working implementation written directly into your files, with the agent verifying its own changes.

## Session continuity is built in

Claude Code has `--continue`. Gemini CLI has `--resume`. These flags pick up where the last conversation left off, including full tool-use history and file context.

llm-cli-gateway uses these natively. When you create a session and make multiple requests, Claude sessions pass `--continue` and Gemini sessions pass `--resume`. The CLI maintains the real conversation state -- you are not reconstructing context from a message array.

API-based orchestrators have to manage conversation state themselves. They store message histories, token-count them to stay under limits, and replay them with each request. This works, but it is a reimplementation of something the CLI tools already handle, and it loses the tool-use context that CLI sessions preserve.

## Auth is already solved

If you have run `codex login` or `claude auth`, you are done. The gateway inherits your existing authentication. There are no API keys to configure in the gateway, no `.env` files with secrets, no key rotation to manage.

API proxies need keys for every provider. LiteLLM needs your OpenAI key, your Anthropic key, your Google key -- all stored somewhere the proxy can read them. This is a real attack surface. llm-cli-gateway has zero credentials in its configuration.

## CLIs evolve faster

New model capabilities tend to land in CLI tools before they appear in stable API endpoints. Claude Code got extended thinking, tool use improvements, and new context window handling before the API equivalents were generally available. Codex shipped its sandbox architecture as a CLI feature. Because llm-cli-gateway wraps the binary, you get these features the moment you update the CLI. No gateway changes required.

## The "All-Agents-MCP archived itself" counterargument

There is a fair objection here. The All-Agents-MCP project (14 stars, now archived) tried CLI wrapping and the author concluded that "direct CLI + Skills is better than wrapping CLIs." They were right -- partially.

Raw CLI wrapping is not enough. If all you do is spawn `codex --quiet -p "do something"` and return the output, you have built a thin shell that adds overhead without adding value. The author was correct that direct CLI usage is simpler.

What changes the equation is opinionated workflow on top of the wrapping. llm-cli-gateway adds:

- **Approval gates with risk scoring** (0-13 points across 7 dimensions, with strict/balanced/permissive policies)
- **Auto-async deferral** at 45 seconds, so sync MCP calls do not time out
- **12 workflow skills** built from running multi-LLM patterns across 11+ production repos
- **The Codex review gate** -- iterate with Codex until unconditional approval
- **Multi-LLM consensus** -- three agents must independently agree
- **Session continuity** using real CLI flags, not bookkeeping
- **Circuit breakers and retry logic** per CLI

The archived project wrapped CLIs. We wrap CLIs and then add the patterns that make multi-LLM orchestration actually work in production.

## Concrete comparison: "Review this code with Codex"

With **PAL MCP** (API-based): Your request goes to the OpenAI API. The model sees whatever code you included in the prompt. It returns review comments as text. It cannot check if its suggestions compile, cannot read files you did not include, cannot verify anything. If the response takes longer than your MCP timeout, the call fails.

With **llm-cli-gateway** (CLI-based): The gateway spawns `codex --quiet` with your prompt. Codex reads the actual files in your repository. It can check related code, look at test files, examine configuration. If the call exceeds 45 seconds, it transparently becomes an async job you can poll. Session state persists for follow-up requests. The response includes findings from an agent that interacted with your codebase, not just one that read a text snippet.

## The trade-offs (honest version)

CLI wrapping is not universally better. The trade-offs are real:

- **Local installation required.** Every developer needs the CLI tools installed. You cannot run this in a serverless cloud function. API proxies work from anywhere with HTTP access.
- **Heavier execution.** Spawning a CLI process is slower and uses more resources than an HTTP API call. A Codex invocation might take 30-90 seconds. An API call returns in 2-5 seconds.
- **Three CLI tools to maintain.** Updates, authentication, and compatibility across `claude`, `codex`, and `gemini` are your responsibility. API keys are simpler to manage at scale.
- **Sandbox limitations.** CLI sandboxes vary. Codex cannot always execute shell commands depending on configuration. Claude Code's tool use depends on permissions. These constraints do not exist with pure API calls (because APIs cannot execute anything).

For teams doing serious multi-LLM development work -- where agents need to read code, run tests, and build on each other's output -- the CLI approach gives you capabilities that API proxying fundamentally cannot provide. For teams that need lightweight, cloud-native multi-model routing, API proxies like LiteLLM are the right choice.

We built llm-cli-gateway for the first group.

---

*llm-cli-gateway is MIT licensed. npm: [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway) | GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)*
