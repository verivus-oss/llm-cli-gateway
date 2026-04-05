---
title: "3 AIs Reviewed Simon Willison's Code. They Disagreed on 2 Findings. That's the Point."
published: false
description: "We used llm-cli-gateway and sqry to have Codex and Gemini independently review the same codebase, then Claude adjudicated. 8 findings held up across all three. 2 didn't. The disagreements were more interesting than the findings."
tags: ai, codereview, python, opensource
---

We have a rule at Verivus Labs: before code ships, it gets reviewed by three AI models independently. Not "looks good" reviews -- unconditional approval from Claude, Codex, and Gemini, or it goes back for fixes. We wrote about the mechanics of that process in [The Codex Review Gate](https://medium.com/@wernerk/the-codex-review-gate-how-we-made-ai-agents-review-each-others-work-59e9ff5465f9).

That process works well on our own code. But we wanted to know: does it find real things in code we didn't write? Code that's already well-maintained, well-tested, and well-structured?

Simon Willison's [llm](https://github.com/simonw/llm) is one of the better-engineered CLI tools in the Python ecosystem -- clean architecture, comprehensive plugin system, parameterized SQL throughout. We pointed our tools at it. And filed the findings that survived review.

## The setup

Two of our tools did the heavy lifting.

[sqry](https://github.com/verivus-oss/sqry) is our AST-based code analysis tool. We wrote about it in [The Code Question grep Can't Answer](https://medium.com/@wernerk/the-code-question-grep-cant-answer-057bfc8d7fe2). It parses code like a compiler -- function signatures, call graphs, dependency relationships -- and exposes them through an MCP server. Instead of giving the reviewers raw text to grep through, sqry gave them a structural map: 40 Python source files, 5,499 symbols, 7,277 edges.

[llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) coordinated the reviews. It's our MCP server for multi-LLM orchestration -- Claude, Codex, and Gemini through a single interface with retries, circuit breakers, and session management. Each reviewer got the same prompt and the same sqry access, run in separate sessions with no shared context.

We also built an [llm plugin](https://pypi.org/project/llm-cli-gateway/) that bridges our gateway into Simon's own `llm` ecosystem. Install with `llm install llm-cli-gateway` and you get `gateway-claude`, `gateway-codex`, and `gateway-gemini` as models. The plugin requires Node.js 18+ for the gateway runtime. We wanted to contribute to Simon's ecosystem, not compete with it.

The review target was `simonw/llm` at commit `cad03fb`, reviewed on April 4, 2026.

## What they found

Codex went first. 11 minutes, 307K tokens. It used sqry to navigate the call graph, then fetched source directly from GitHub to verify against specific commits. Found 8 potential issues.

Gemini went second. 8 minutes. Used sqry's hierarchical search and pattern search. Confirmed 5 of Codex's findings, identified 3 new ones.

Then we sent each reviewer's unique findings to the other for cross-validation. At this point we had 11 candidate findings, all confirmed by both Codex and Gemini.

But two reviewers isn't three. So Claude did an independent adjudication pass over the 11 candidates -- reading each relevant source file and providing line-level verdicts. Claude's role was validation, not discovery: it assessed whether each finding was a genuine defect or a defensible design choice.

Claude confirmed 8 findings. It disputed 2. And marked 1 uncertain.

The disputes were the most interesting part.

## The 2 findings Claude rejected

**Uncaught hook exceptions in async tool execution.** Codex and Gemini both flagged that `before_call`/`after_call` hooks in the async path run outside try/except, so a buggy plugin hook crashes the entire parallel tool batch.

Claude disagreed. Its argument: if an after-call hook throws, that is an unexpected error and *should* propagate. Silently swallowing hook failures would mask plugin bugs. The current behavior is a defensible design choice, not a defect.

**Memory exhaustion with large attachments.** Codex and Gemini both noted that `_attachment()` eagerly reads entire files into memory, base64-encodes them (33% expansion), and holds everything in a JSON object simultaneously.

Claude's take: this is inherent to how multimodal API calls work. The content has to be serialized to send it. There's no unnecessary duplication -- it's the minimum work required by the API contract.

Both are fair arguments. And this is exactly why three-way review matters: two models agreeing doesn't make something a defect. The third model asking "is this actually wrong, or is it just uncomfortable?" is what prevents you from filing noise.

## The 1 finding Claude marked uncertain

**Async tool execution racing shared Toolbox state.** Codex and Gemini flagged that the async path batches tool calls into `asyncio.gather()`, which could race if a `Toolbox` instance maintains state across calls. Claude's assessment: the framework's own state management appears safe, but whether the bug manifests depends on plugin-specific behavior. The framework doesn't guarantee sequential execution, and plugins may not expect parallelism. Uncertain -- not clearly a bug, not clearly safe either.

## The 8 findings that held up

Three stood out.

**PDF attachment data persisted in logs.** The `redact_data()` function strips `image_url.url` and `input_audio.data` from logged prompt JSON, but has no case for `file.file_data` -- where PDF attachments are stored as base64. Full PDF contents persist in `logs.db`. Users who share that database could inadvertently expose document contents. Filed as [#1396](https://github.com/simonw/llm/issues/1396).

**Embedding dedup comparing wrong keys.** `embed_multi_with_metadata()` queries by `content_hash` but then filters by comparing incoming *item IDs* against returned *row IDs*. These are semantically different. Duplicate content under a new ID bypasses dedup silently. Filed as [#1397](https://github.com/simonw/llm/issues/1397).

**Stale loop variable in tool logging.** In `log_to_db()`, the `tool_instances` INSERT references `tool.plugin` from a previous loop. Python loop variables leak -- so every tool result gets attributed to whichever toolbox was last in the list. Filed as [#1398](https://github.com/simonw/llm/issues/1398).

The remaining five: a possible migration race window when multiple processes start before migrations complete ([commented on #789](https://github.com/simonw/llm/issues/789#issuecomment-4188034320)), `--async --usage` crash with `AsyncChainResponse`, negative `--chain-limit` failing immediately, `asyncio.run()` called inside running event loops, and `cosine_similarity()` dividing by zero on zero vectors.

Severity ratings are our internal assessment. None have been confirmed by the maintainer yet.

| # | Finding | Validation | Filed |
|---|---------|:----------:|:-----:|
| 1 | PDF data not stripped by `redact_data()` | 3/3 | [#1396](https://github.com/simonw/llm/issues/1396) |
| 2 | Embedding dedup compares wrong keys | 3/3 | [#1397](https://github.com/simonw/llm/issues/1397) |
| 3 | Possible migration race window | 3/3 | [#789](https://github.com/simonw/llm/issues/789#issuecomment-4188034320) |
| 4 | Async tool races shared state | 2/3 | -- |
| 5 | `--async --usage` crash | 3/3 | -- |
| 6 | Stale loop variable in `log_to_db()` | 3/3 | [#1398](https://github.com/simonw/llm/issues/1398) |
| 7 | Negative `--chain-limit` fails | 3/3 | -- |
| 8 | `asyncio.run()` in event loop | 3/3 | -- |
| 9 | Hook exceptions crash batch | 2/3 | -- |
| 10 | Memory with large attachments | 2/3 | -- |
| 11 | `cosine_similarity` / zero | 3/3 | -- |

## What sqry actually did

The reviewers didn't grep through 40 files. sqry gave them structural tools:

- `find_cycles` confirmed zero import cycles and one guarded call cycle (`get_model` <-> `get_async_model`)
- `complexity_metrics` identified `logs_list()` at complexity 43 (622 lines) and `prompt()` at complexity 35 (450 lines, 30 parameters)
- `direct_callers` and `explain_code` let Codex trace the full `_attachment()` -> `log_to_db()` -> `redact_data()` call path that exposed the PDF issue
- `pattern_search` found the stale loop variable pattern across the codebase

This is the difference between asking an LLM "review this code" and giving it the tools to actually understand the code structurally. grep finds text. sqry finds relationships.

## Try it

The `llm` plugin provides the simplest entry point, though it routes through the MCP gateway under the hood. For the kind of structural review described in this article, you'd also want sqry running as an MCP server so the models can navigate call graphs instead of reading raw text.

```bash
# Install the llm plugin (requires Node.js 18+)
llm install llm-cli-gateway

# Basic usage -- this sends prompts through the gateway
llm -m gateway-codex "Review this file for bugs: $(cat src/main.py)"
llm -m gateway-gemini "Review this file for bugs: $(cat src/main.py)"

# For structural review with sqry, use the MCP gateway directly
npm install -g llm-cli-gateway
```

- Gateway: [github.com/verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- Plugin: [pypi.org/project/llm-cli-gateway](https://pypi.org/project/llm-cli-gateway/)
- sqry: [github.com/verivus-oss/sqry](https://github.com/verivus-oss/sqry)

## What we took away

The findings we filed are not confirmed defects -- they're candidates that survived three-way review. The maintainer may disagree with some of them, and that's fine. The point of the exercise was to test the methodology, not to audit Simon's code.

That said, the reviewers did not find SQL injection surfaces in the paths they inspected. The architecture is clean. The issues they found are subtle -- stale loop variables, key mismatches in dedup logic, missing cases in sanitization functions. These are the kind of things that survive human review precisely because the code reads well.

The interesting result wasn't the findings. It was the disagreements. Two models confirming something doesn't make it true. The third model pushing back -- "is this actually wrong?" -- is what separates a useful review from a noisy one.

We're going to keep running this pattern. Not because we think AI review replaces human review, but because three independent perspectives catch things that one perspective, no matter how capable, misses. That's the premise behind [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway), and this was a useful case study.

---

*Werner Kasselman is a software engineer who builds open source developer tools in his spare time, including sqry and llm-cli-gateway. By day he works at ServiceNow. He lives in Australia with his family and blogs at [medium.com/@wernerk](https://medium.com/@wernerk). Views expressed here are his own and do not represent ServiceNow.*
