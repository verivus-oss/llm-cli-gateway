---
title: "3 AIs Reviewed the Same Codebase. They Disagreed on 2 Findings. Here is What That Taught Us."
published: false
description: "We used llm-cli-gateway and sqry to have Codex and Gemini independently review simonw/llm, then Claude adjudicated. 8 findings held up across all three. 2 were rejected. 1 remained uncertain. A community member then corrected our root cause on one of the confirmed bugs."
tags: ai, codereview, python, opensource
---

We have a rule at Verivus Labs: before code ships, it gets reviewed by three AI models independently. We require unconditional approval from Claude, Codex, and Gemini before anything merges. We wrote about the mechanics of that process in [The Codex Review Gate](https://medium.com/@wernerk/the-codex-review-gate-how-we-made-ai-agents-review-each-others-work-59e9ff5465f9).

That process works well on our own code. We wanted to know whether it finds real things in code we didn't write. Code that is already well maintained and well structured.

Simon Willison's [llm](https://github.com/simonw/llm) is one of the better engineered CLI tools in the Python ecosystem. It has a clean architecture, a comprehensive plugin system, and parameterized SQL throughout. The reviewers independently noted the consistent SQL safety, which speaks to the care that has gone into the project. We pointed our tools at it and filed the findings that survived review.

## The setup

Two of our tools did the heavy lifting.

[sqry](https://github.com/verivus-oss/sqry) is our AST-based code analysis tool. We wrote about it in [The Code Question grep Can't Answer](https://medium.com/@wernerk/the-code-question-grep-cant-answer-057bfc8d7fe2). It parses code structurally, building function signatures, call graphs, and dependency relationships, and exposes them through an MCP server. sqry gave the reviewers a structural map of 40 Python source files containing 5,499 symbols and 7,277 edges.

[llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) coordinated the reviews. It is our MCP server for multi-LLM orchestration. It wraps Claude, Codex, and Gemini through a single interface with retries, circuit breakers, and session management. Each reviewer got the same prompt and the same sqry access, run in separate sessions with no shared context.

We also built an [llm plugin](https://pypi.org/project/llm-cli-gateway/) that bridges our gateway into Simon's own `llm` ecosystem. Install with `llm install llm-cli-gateway` and you get `gateway-claude`, `gateway-codex`, and `gateway-gemini` as models. The plugin requires Node.js 18+ for the gateway runtime. We wanted to contribute to Simon's ecosystem.

The review target was `simonw/llm` at commit `cad03fb`, reviewed on April 4, 2026.

## What they found

Codex went first. 11 minutes, 307K tokens. It used sqry to navigate the call graph, then fetched source directly from GitHub to verify line-level details against the actual commit. It identified 8 potential issues.

Gemini went second. 8 minutes. It used sqry hierarchical search and pattern search. It confirmed 5 of Codex's findings and identified 3 new ones.

We then sent each reviewer's unique findings to the other for cross-validation. At this point we had 11 candidate findings, all confirmed by both Codex and Gemini.

Claude did an independent adjudication pass over the 11 candidates, reading each relevant source file and providing line-level verdicts. Claude's role was validation. It assessed whether each finding was a genuine defect or a defensible design choice.

Claude confirmed 8 findings. It disputed 2. It marked 1 uncertain.

## The 2 findings Claude rejected

Codex and Gemini both flagged that `before_call`/`after_call` hooks in the async path run outside try/except, meaning a buggy plugin hook crashes the entire parallel tool batch.

Claude disagreed. If an after-call hook throws, that is an unexpected error and should propagate. Silently swallowing hook failures would mask plugin bugs. The current behavior is a defensible design choice.

Codex and Gemini both noted that `_attachment()` eagerly reads PDF and local file attachments into memory, base64-encodes them (33% expansion), and holds everything in a JSON object simultaneously.

Claude's assessment was that this is inherent to how multimodal API calls work. The content has to be serialized to send it. There is no unnecessary duplication. It's the minimum work the API requires.

The third model asking whether something is actually wrong, or just uncomfortable, is what prevents filing noise.

## The 1 finding Claude marked uncertain

Codex and Gemini flagged that the async path batches tool calls into `asyncio.gather()`, which could race if a `Toolbox` instance maintains state across calls. Claude's assessment was that the framework's own state management appears safe, but whether the issue manifests depends on plugin-specific behavior. The framework does not guarantee sequential execution, and plugins may not expect parallelism.

## The 8 findings that held up

Three stood out.

`redact_data()` strips `image_url.url` and `input_audio.data` from logged prompt JSON, but has no case for `file.file_data`, where PDF attachments are stored as base64. Full PDF contents persist in `logs.db`. Users who share that database could inadvertently expose document contents. Filed as [#1396](https://github.com/simonw/llm/issues/1396).

`embed_multi_with_metadata()` queries existing rows by `content_hash`, correct, but then `SELECT`s those rows' `id` column and filters the incoming batch by checking whether each new item's ID appears in that set. The `id` column is the user-provided identifier (the table's PK is `(collection_id, id)`). So the filter asks "does an existing row have the same ID?" when it should ask "does the content already exist?" Same content under a different ID bypasses dedup entirely. The single-item `embed()` method gets this right: it checks `count_where("content_hash = ? and collection_id = ?")` with no ID comparison at all. Filed as [#1397](https://github.com/simonw/llm/issues/1397).

Our original filing described the `id` column as a database row ID. [@kaiisfree](https://github.com/kaiisfree) [read the code and corrected us](https://github.com/simonw/llm/issues/1397#issuecomment-4188393711): it is the user-provided ID. The bug is real. The fix is the same. But our explanation of the mechanism was wrong. More on this below.

In `log_to_db()`, the `tool_instances` INSERT references `tool.plugin` from a previous loop. Python loop variables retain their last value after the loop ends, so for Toolbox-backed tools, every tool result gets attributed to whichever toolbox was last in the list. Filed as [#1398](https://github.com/simonw/llm/issues/1398).

The remaining five: a possible migration race window when multiple processes start before migrations complete ([commented on #789](https://github.com/simonw/llm/issues/789#issuecomment-4188034320)), a potential `--async --usage` crash with `AsyncChainResponse`, negative `--chain-limit` failing immediately, `asyncio.run()` called inside running event loops, and `cosine_similarity()` dividing by zero on zero vectors. These weren't filed because we felt they needed more investigation before committing to a public issue report.

Severity ratings are our internal assessment. None have been confirmed by the maintainer yet.

| # | Finding | Validation | Filed |
|---|---------|:----------:|:-----:|
| 1 | PDF data not stripped by `redact_data()` | 3/3 | [#1396](https://github.com/simonw/llm/issues/1396) |
| 2 | Embedding dedup compares wrong keys | 3/3 | [#1397](https://github.com/simonw/llm/issues/1397) |
| 3 | Possible migration race window | 3/3 | [#789](https://github.com/simonw/llm/issues/789#issuecomment-4188034320) |
| 4 | Async tool races shared state | uncertain | |
| 5 | `--async --usage` crash | 3/3 | |
| 6 | Stale loop variable in `log_to_db()` | 3/3 | [#1398](https://github.com/simonw/llm/issues/1398) |
| 7 | Negative `--chain-limit` fails | 3/3 | |
| 8 | `asyncio.run()` in event loop | 3/3 | |
| 9 | Hook exceptions crash batch | rejected | |
| 10 | Memory with large attachments | rejected | |
| 11 | `cosine_similarity` / zero | 3/3 | |

## What sqry contributed

sqry gave the reviewers structural navigation instead of text search:

- `find_cycles` confirmed zero import cycles and one guarded call cycle (`get_model` calling `get_async_model` and vice versa)
- `complexity_metrics` identified `logs_list()` at complexity 43 (622 lines) and `prompt()` at complexity 35 (450 lines, 30 parameters)
- `direct_callers` and `explain_code` let Codex trace the full `_attachment()` to `log_to_db()` to `redact_data()` call path that exposed the PDF issue
- `pattern_search` found the stale loop variable pattern across the codebase

Structural navigation means the reviewers could follow call paths and dependency chains rather than searching for keywords. That is the difference between asking "where is this function called" and actually knowing.

## Try it

The `llm` plugin provides the simplest entry point. It routes through the MCP gateway under the hood. For structural review like we describe in this article, you would also want sqry running as an MCP server so the models can navigate call graphs.

```bash
# Install the llm plugin (requires Node.js 18+)
llm install llm-cli-gateway

# Basic usage
llm -m gateway-codex "Review this file for bugs: $(cat src/main.py)"
llm -m gateway-gemini "Review this file for bugs: $(cat src/main.py)"

# For structural review with sqry, use the MCP gateway directly
npm install -g llm-cli-gateway
```

- Gateway: [github.com/verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- Plugin: [pypi.org/project/llm-cli-gateway](https://pypi.org/project/llm-cli-gateway/)
- sqry: [github.com/verivus-oss/sqry](https://github.com/verivus-oss/sqry)

## What we took away

The findings we filed are candidates that survived three-way review. The maintainer may disagree with some of them. The point of the exercise was to test the methodology, and we are grateful to Simon for building `llm` in the open where this kind of analysis is possible.

The reviewers didn't find SQL injection surfaces in the paths they inspected. The issues they found are subtle. Stale loop variables, key mismatches in dedup logic, missing cases in sanitization functions. The code reads well, which is exactly why these things persist.

The disagreements were the most useful part. Two models confirming something does not make it true. Claude rejecting findings that Codex and Gemini agreed on forced us to think about what qualifies as a defect versus a design choice. We wouldn't have drawn that distinction on our own.

Within hours of filing [#1397](https://github.com/simonw/llm/issues/1397), [@kaiisfree](https://github.com/kaiisfree) read the code and corrected our root cause framing. We had described the `id` column as an auto-increment row ID. It is the user-provided identifier. The primary key is `(collection_id, id)`. The bug and fix are the same, but our explanation of the mechanism was wrong. We've updated Finding 2 above to reflect the correction.

This exposed something we hadn't considered. All three models described the `id` column the same way we did. When every reviewer shares an assumption, cross-validation can't challenge it. In this run, with these three models, a column named `id` was treated as an auto-increment row identifier by default. A human reading the schema caught what the models didn't. We can't say whether more models would have helped. What we can say is that this kind of framing error requires domain verification that multi-LLM review alone doesn't provide.

We'll keep running this pattern. Three independent perspectives catch things that one perspective misses. If you try it on your own codebase and find things we should know about, we'd like to hear from you.

---

*Werner Kasselman is a software engineer who builds open source developer tools in his spare time, including sqry and llm-cli-gateway. By day he works at ServiceNow. He lives in Australia with his family and blogs at [medium.com/@wernerk](https://medium.com/@wernerk). Views expressed here are his own and do not represent ServiceNow.*
