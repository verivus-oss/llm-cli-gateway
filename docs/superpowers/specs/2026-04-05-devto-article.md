---
title: "We Pointed 2 AIs at the Same Codebase and Found 11 Issues"
published: false
description: "How we used Codex and Gemini to independently review the same codebase, cross-validated every finding, and caught issues that single-model review missed."
tags: ai, codereview, python, opensource
---

Every AI model has blind spots. The interesting question is whether different models have *different* blind spots -- and if you can exploit that asymmetry to catch more issues.

We built a tool that orchestrates multiple LLM CLIs through a single interface. To test whether multi-LLM review actually works, we pointed Codex and Gemini at a well-maintained open source project, had them review it independently, then cross-validate each other's findings.

They identified 11 issues, all dual-confirmed by both reviewers. None have been confirmed by the maintainer yet -- we filed three as issues and are waiting on feedback.

## What is multi-LLM orchestration

The idea is straightforward: instead of asking one model to review your code, you ask two or three, each working independently, then have them verify each other's results.

This works because different models are trained on different data, have different architectural biases, and tend to notice different things. Codex might trace a call path through six files and spot a type mismatch. Gemini might pattern-match on a code structure and recognize a known class of bug. Neither catches everything, but together they cover more ground.

The tool that makes this practical is [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway), a TypeScript MCP server we built. It wraps the Claude Code, Codex, and Gemini CLIs with retry logic, circuit breakers, and session management. Claude orchestrated the review process; Codex and Gemini did the actual code analysis. We also wrote an [llm plugin](https://pypi.org/project/llm-cli-gateway/) that bridges into Simon Willison's excellent `llm` ecosystem.

## The experiment

We chose Simon Willison's [llm](https://github.com/simonw/llm) (commit `cad03fb`) as the review target. It is actively maintained, well-structured Python -- both reviewers independently noted consistent use of parameterized SQL throughout. Reviewing good code is a better test of the methodology than reviewing sloppy code, because the findings need to hold up to scrutiny.

The process:

1. **Structural analysis.** [sqry](https://github.com/verivus-oss/sqry), an AST-based code analysis tool, indexed the Python source: 40 files, 5,499 symbols, 7,277 edges. This gave the reviewers a semantic map -- function signatures, call graphs, dependency relationships -- rather than raw text to grep through.

2. **Codex review.** 11 minutes, 307K tokens. Codex used sqry for structural navigation and fetched source directly from GitHub for commit-level verification. Found 8 issues. Both reviewers received the same prompt and had access to the same sqry tools.

3. **Gemini review.** 8 minutes, working independently (sequential, not parallel). Used sqry's hierarchical search and pattern search. Confirmed 5 of Codex's findings and identified 3 new ones.

4. **Cross-validation.** Each reviewer's unique findings were sent to the other for independent verification. All 11 findings were dual-confirmed. The 19-minute figure is combined primary-review time only; cross-validation added roughly 10 minutes.

## What they found

Three findings stood out.

### PDF attachment data persisted in logs

The `redact_data()` function sanitizes prompt JSON before writing it to the SQLite log database. It strips `image_url.url` when it starts with `data:` and `input_audio.data`. But it does not strip `file.file_data`, which is where PDF attachments are stored as base64. The result: full PDF contents persist in `logs.db`. Users who share that database or expose it through Datasette could inadvertently expose document contents.

Codex found this by tracing the full call path from `_attachment()` through `log_to_db()` into `redact_data()`. Gemini independently confirmed the gap. Filed as [issue #1396](https://github.com/simonw/llm/issues/1396).

### Embedding deduplication comparing the wrong keys

`Collection.embed_multi_with_metadata()` queries existing rows by `content_hash`, stores the returned row IDs in `existing_ids`, then filters incoming items by checking if the *user-provided* ID is in that set. These are semantically different values. A document resubmitted with the same content but a different ID bypasses dedup entirely, and duplicates accumulate silently because `content_hash` is indexed but not unique.

This is exactly the kind of logic bug that reads correctly on first pass -- you see "query by hash, filter by existing" and your brain fills in the gap. Both reviewers caught it. Filed as [issue #1397](https://github.com/simonw/llm/issues/1397).

### Stale loop variable in tool logging

In `_BaseResponse.log_to_db()`, the `tool_instances` INSERT runs inside a `for tool_result in self.prompt.tool_results` loop but references `tool.plugin` and `tool.name` from an *earlier*, already-completed `for tool in self.prompt.tools` loop. In Python, the loop variable retains its last value after the loop ends. So in multi-toolbox runs, every tool result gets attributed to whichever toolbox happened to be last in the list.

Both reviewers flagged it independently. Filed as [issue #1398](https://github.com/simonw/llm/issues/1398).

### All 11 findings

Severity ratings are our internal assessment, not upstream-confirmed.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | PDF attachment data not stripped by `redact_data()` | High | [#1396](https://github.com/simonw/llm/issues/1396) |
| 2 | Embedding dedup compares item IDs against row IDs | High | [#1397](https://github.com/simonw/llm/issues/1397) |
| 3 | Migration race condition -- no cross-process locking | High | [#789 comment](https://github.com/simonw/llm/issues/789#issuecomment-4188034320) |
| 4 | Async tool execution races shared Toolbox state | Medium | Documented |
| 5 | `--async --usage` with tools may crash or misreport | Medium | Documented |
| 6 | Stale loop variable in `log_to_db()` tool attribution | Medium | [#1398](https://github.com/simonw/llm/issues/1398) |
| 7 | Negative `--chain-limit` fails on first response | Medium | Documented |
| 8 | `asyncio.run()` in `log_to_db()` fails inside event loops | Medium | Documented |
| 9 | Uncaught hook exceptions crash async tool batch | Medium | Documented |
| 10 | Memory exhaustion with large base64 attachments | Medium | Documented |
| 11 | `cosine_similarity()` divides by zero on zero vectors | Low | Documented |

## Why cross-validation matters

Single-model review has two problems: false positives and missed findings. Cross-validation addresses both.

When Codex found the PDF redaction gap, we did not simply trust it. We sent the finding to Gemini, which independently verified the call path and confirmed the missing case in `redact_data()`. When Gemini found the migration race condition, Codex verified it against the upstream source and specific commit hashes.

Of the 11 findings in this run, 5 were found by both reviewers independently. 3 were Codex-only, sent to Gemini for validation. 3 were Gemini-only, sent to Codex for validation. All confirmed. Zero false positives in the final set.

The value of multi-LLM review is not that any one model is better, but that independent confirmation dramatically increases confidence in the results.

## Try it yourself

The gateway is a Node.js MCP server. The plugin bridges it into `llm`:

```bash
# Install the llm plugin
llm install llm-cli-gateway

# Review with multiple models
llm -m gateway-codex "Review this file for bugs: $(cat src/main.py)"
llm -m gateway-gemini "Review this file for bugs: $(cat src/main.py)"
```

For MCP-native usage (e.g., from Claude Code), install the gateway separately (`npm install -g llm-cli-gateway`) to get `claude_request`, `codex_request`, and `gemini_request` tools with retry logic, circuit breakers, and session management.

- Gateway (MCP server): [github.com/verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- Plugin (llm ecosystem): [pypi.org/project/llm-cli-gateway](https://pypi.org/project/llm-cli-gateway/)

## What we learned

**Different models find different things.** Codex excelled at tracing call paths across files and verifying against commit history. Gemini was strong at pattern recognition and structural analysis. In this run, neither alone would have found all 11.

**AST-based analysis helps.** Giving reviewers a structural map of the codebase (via sqry) meant they could navigate by function signatures and call graphs rather than grepping through raw text.

**Good code still has subtle issues.** Simon's `llm` is well-engineered software with clean architecture and comprehensive functionality. The issues we found are subtle -- stale loop variables, key mismatches in dedup logic, missing cases in sanitization functions. These are the kinds of things that survive human review precisely because the code reads well.

**Multi-LLM review is not about replacing human review.** It is about catching a category of issues that individual review -- human or AI -- tends to miss. The dual-confirmation step is what makes the output worth acting on.

We filed issues for the findings we were most confident about. The goal was never to find fault with `llm` -- it was to test whether pointing multiple models at the same code, independently, produces meaningfully better results than any single review pass. In this case, it did.
