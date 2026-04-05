---
title: "We Pointed 3 AIs at Each Other's Blind Spots and Found 11 Real Bugs"
published: false
description: "How we used Codex and Gemini to independently review the same codebase, cross-validated every finding, and discovered bugs that single-model review missed."
tags: ai, codereview, python, opensource
---

Every AI model has blind spots. The interesting question is whether different models have *different* blind spots -- and if you can exploit that asymmetry to catch more bugs.

We built a tool that orchestrates Claude Code, Codex, and Gemini through a single interface. To test whether multi-LLM review actually works, we pointed it at a well-maintained open source project and asked two models to independently review the code, then cross-validate each other's findings.

They found 11 real bugs. Every single finding was confirmed by both reviewers.

## What is multi-LLM orchestration

The idea is straightforward: instead of asking one model to review your code, you ask two or three, each working independently, then have them verify each other's results.

This works because different models are trained on different data, have different architectural biases, and tend to notice different things. Codex might trace a call path through six files and spot a type mismatch. Gemini might pattern-match on a code structure and recognize a known class of bug. Neither catches everything, but together they cover more ground.

The tool that makes this practical is [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway), a TypeScript MCP server we built. It wraps the Claude Code, Codex, and Gemini CLIs with retry logic, circuit breakers, and session management. We also wrote an [llm plugin](https://pypi.org/project/llm-cli-gateway/) that bridges it into Simon Willison's excellent `llm` ecosystem -- install with `llm install llm-cli-gateway` and you get `gateway-claude`, `gateway-codex`, and `gateway-gemini` as models.

## The experiment

We chose Simon Willison's [llm](https://github.com/simonw/llm) as the review target. It is actively maintained, well-structured Python with parameterized SQL throughout (no injection bugs -- both reviewers confirmed that independently). Reviewing good code is a better test of the methodology than reviewing sloppy code, because the findings have to be real.

The process:

1. **Structural analysis.** [sqry](https://github.com/verivus-oss/sqry), an AST-based code analysis tool, indexed the codebase: 40 files, 5,499 symbols, 7,277 edges. This gave the reviewers a semantic map -- function signatures, call graphs, dependency relationships -- rather than raw text to grep through.

2. **Codex review.** 11 minutes, 307K tokens. Codex used sqry for structural navigation and fetched source directly from GitHub for commit-level verification. Found 8 issues.

3. **Gemini review.** 8 minutes, working independently. Used sqry's hierarchical search and pattern search. Confirmed 5 of Codex's findings and discovered 3 new ones.

4. **Cross-validation.** Each reviewer's unique findings were sent to the other for independent verification. All 11 findings were dual-confirmed.

## What they found

Three findings stood out.

### PDF content leaking into logs

The `redact_data()` function sanitizes prompt JSON before writing it to the SQLite log database. It strips `image_url.url` when it starts with `data:` and `input_audio.data`. But it does not strip `file.file_data`, which is where PDF attachments are stored as base64. The result: full PDF contents persist in `logs.db`. Anyone who shares that database or exposes it through Datasette could inadvertently leak document contents.

Codex found this by tracing the full call path from `_attachment()` through `log_to_db()` into `redact_data()`. Gemini independently confirmed it and upgraded severity to CRITICAL. Filed as [issue #1396](https://github.com/simonw/llm/issues/1396).

### Embedding deduplication comparing the wrong keys

`Collection.embed_multi_with_metadata()` queries existing rows by `content_hash`, stores the returned row IDs in `existing_ids`, then filters incoming items by checking if the *user-provided* ID is in that set. These are semantically different values. A document resubmitted with the same content but a different ID bypasses dedup entirely, and duplicates accumulate silently because `content_hash` is indexed but not unique.

This is exactly the kind of logic bug that reads correctly on first pass -- you see "query by hash, filter by existing" and your brain fills in the gap. Both reviewers caught it. Filed as [issue #1397](https://github.com/simonw/llm/issues/1397).

### Stale loop variable in tool logging

In `_BaseResponse.log_to_db()`, the `tool_instances` INSERT runs inside a `for tool_result in self.prompt.tool_results` loop but references `tool.plugin` and `tool.name` from an *earlier*, already-completed `for tool in self.prompt.tools` loop. In Python, the loop variable retains its last value after the loop ends. So in multi-tool runs, every tool result gets attributed to whichever tool happened to be last in the list.

This is a classic Python footgun. Both reviewers flagged it independently. Filed as [issue #1398](https://github.com/simonw/llm/issues/1398).

### And eight more

The remaining findings include a database migration race condition (no locking around check-then-apply; [commented on #789](https://github.com/simonw/llm/issues/789#issuecomment-4188034320)), async tool execution racing shared state, a negative `--chain-limit` that fails immediately instead of being rejected, `asyncio.run()` called in contexts where an event loop is already running, uncaught hook exceptions crashing parallel tool batches, memory exhaustion with large attachments, and a divide-by-zero in `cosine_similarity()` on zero vectors.

Three HIGH, seven MEDIUM, one LOW. None are exploits. All are real.

## Why cross-validation matters

Single-model review has two problems: false positives and missed findings. Cross-validation addresses both.

When Codex found the PDF redaction leak, we did not simply trust it. We sent the finding to Gemini, which independently verified the call path and confirmed the gap in `redact_data()`. When Gemini found the migration race condition, Codex verified it against the upstream source and specific commit hashes.

Of the 11 findings, 5 were found by both reviewers independently. 3 were Codex-only, sent to Gemini for validation. 3 were Gemini-only, sent to Codex for validation. All confirmed. Zero false positives in the final set.

This is the core value proposition of multi-LLM review: not that any one model is better, but that independent confirmation dramatically increases confidence in the results.

## Try it yourself

The gateway is a Node.js MCP server. The plugin bridges it into `llm`:

```bash
# Install the gateway
npm install -g llm-cli-gateway

# Or use it as an llm plugin
llm install llm-cli-gateway

# Review with multiple models
llm -m gateway-codex "Review this file for bugs: $(cat src/main.py)"
llm -m gateway-gemini "Review this file for bugs: $(cat src/main.py)"
```

For MCP-native usage (e.g., from Claude Code), the gateway exposes `claude_request`, `codex_request`, and `gemini_request` tools with retry logic, circuit breakers, and session management built in.

- Gateway: [github.com/verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway) (npm)
- Plugin: [pypi.org/project/llm-cli-gateway](https://pypi.org/project/llm-cli-gateway/) (PyPI)

## What we learned

**Different models find different things.** Codex excelled at tracing call paths across files and verifying against commit history. Gemini was strong at pattern recognition and structural analysis. Neither alone would have found all 11.

**AST-based analysis changes the game.** Giving reviewers a structural map of the codebase (via sqry) meant they could navigate by function signatures and call graphs rather than grepping through raw text. The total review time was 19 minutes across both models.

**Good code still has bugs.** Simon's `llm` is well-engineered software with clean architecture, zero SQL injection surface, and comprehensive functionality. The bugs we found are subtle -- stale loop variables, key mismatches in dedup logic, missing cases in sanitization functions. These are the kinds of issues that survive human review precisely because the code reads well.

**Multi-LLM review is not about replacing human review.** It is about catching a category of bugs that individual review -- human or AI -- tends to miss. The dual-confirmation step is what makes the output trustworthy.

We filed issues for the confirmed findings. The goal was never to find fault with `llm` -- it was to demonstrate that pointing multiple models at the same code, independently, produces meaningfully better results than any single review pass.
