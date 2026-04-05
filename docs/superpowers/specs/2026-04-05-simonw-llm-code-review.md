# Code Review: simonw/llm — Multi-LLM Analysis

**Date:** 2026-04-05
**Repo:** https://github.com/simonw/llm (v0.30, cloned at `/srv/repos/external/simonw/llm`)
**Reviewers:** Codex (gpt-5.4), Gemini (gemini-2.5-flash)
**Coordinator:** Claude Opus 4.6 (1M context)
**Methodology:** AST-based structural analysis via sqry, followed by independent reviews from Codex and Gemini, with cross-validation of all findings

## Review Process

1. **Structural analysis** -- sqry indexed 40 files (38 Python), 5,499 symbols, 7,277 edges. Ran: `get_insights`, `find_cycles`, `find_unused`, `find_duplicates`, `complexity_metrics`
2. **Codex deep review** -- 11 minutes, 307K tokens consumed. Used sqry tools + GitHub source fetching for source-level verification. Found 8 issues.
3. **Gemini independent review** -- 8 minutes. Used sqry hierarchical search + pattern search. Confirmed 5 Codex findings, found 3 new issues.
4. **Cross-validation** -- Each reviewer's unique findings sent to the other for validation. All 11 findings dual-confirmed.

## Codebase Health Summary

| Metric | Value |
|--------|-------|
| Files | 40 (38 Python, 1 HTML, 1 shell) |
| Total symbols | 5,499 |
| Import cycles | 0 (clean) |
| Call cycles | 1 (get_model <-> get_async_model, guarded) |
| Highest complexity | logs_list() at 43 (622 lines) |
| Largest file | cli.py at 4,050 lines |
| SQL injection risk | None found (parameterized queries throughout) |

---

## Findings

All findings below have been independently confirmed by both Codex and Gemini.

---

### Finding 1: Prompt redaction leaks PDF and image content into SQLite logs

**Severity:** HIGH
**Files:** `llm/default_plugins/openai_models.py:544` (`_attachment`), `openai_models.py:1074` (`redact_data`)
**Found by:** Codex | **Confirmed by:** Gemini (upgraded to CRITICAL)

**Description:**
The `_attachment()` function encodes PDF attachments as `file.file_data` base64 data URIs. The `redact_data()` function, which sanitizes prompt JSON before logging to SQLite, only strips:
- `image_url.url` when it starts with `data:`
- `input_audio.data`

It does NOT strip:
- `file.file_data` (PDF base64 payloads)
- `image_url.url` when it is an external URL (signed URLs with credentials)

**Impact:** Full base64 PDF contents and signed image URLs persist in the `prompt_json` column of the SQLite log database. This is a data leakage concern -- users who share their `logs.db` or inspect it via Datasette may inadvertently expose sensitive document contents.

**Evidence:**
- `_attachment()` at line 544 creates `{"type": "file", "file": {"file_data": "data:application/pdf;base64,..."}}`
- `redact_data()` at line 1074 recursively walks the prompt JSON but has no case for `file_data` or non-data-URI `image_url.url`
- Codex traced the full call path: `_attachment()` -> prompt JSON -> `log_to_db()` -> `redact_data()` -> SQLite

**Suggested fix:** Add `file_data` to `redact_data()` and strip external image URLs (not just `data:` URIs).

---

### Finding 2: Embedding deduplication is broken

**Severity:** HIGH
**Files:** `llm/embeddings.py:173` (`embed_multi_with_metadata`), `llm/embeddings_migrations.py:41`
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
`Collection.embed_multi_with_metadata()` implements a deduplication check that queries existing rows by `content_hash`, stores the returned row `id`s in `existing_ids`, then filters the incoming batch by checking if each incoming item's ID is in `existing_ids`. This compares the wrong key -- it should compare `content_hash` values, not IDs.

**Impact:** Duplicate content submitted under a new ID bypasses dedup entirely. The embeddings table accumulates redundant entries, increasing storage costs and degrading similarity search performance. The `content_hash` column is indexed but not unique in the schema, so duplicates persist silently.

**Evidence:**
- The query selects `id` from rows matching `content_hash IN (?)`
- The filter checks `if item_id in existing_ids` -- but `item_id` is the user-provided ID, while `existing_ids` contains database row IDs from the hash lookup
- These are semantically different: a new document with the same content but a different ID will never match

**Suggested fix:** Compare `content_hash` values instead of IDs, or add a UNIQUE constraint on `(collection_id, content_hash)`.

---

### Finding 3: Database migration race condition

**Severity:** HIGH
**Files:** `llm/migrations.py:8` (`migrate`)
**Found by:** Gemini | **Confirmed by:** Codex

**Description:**
The `migrate()` function performs a check-then-act sequence without cross-process locking:
1. Ensures `_llm_migrations` table exists
2. Reads applied migration names
3. Runs each missing migration
4. Inserts the migration record

Two concurrent `llm` processes (common in CI, scripts, or parallel shell commands) can both observe the same migration as unapplied and both attempt to run it.

**Impact:** "Table already exists" errors, duplicate-column errors, or `database is locked` failures during startup. Codex notes that SQLite generally turns this into lock errors or conflicting DDL rather than silent corruption, but the user-visible result is a crash on startup.

**Evidence:**
- Codex verified against the upstream source at `github.com/simonw/llm/blob/main/llm/migrations.py`
- `ensure_migrations_table()` itself has an `exists()` then `create()` race
- No file lock, no `BEGIN EXCLUSIVE`, no advisory locking mechanism

**Suggested fix:** Use `BEGIN EXCLUSIVE` around the migration check-and-apply sequence, or implement file-level locking.

---

### Finding 4: Async tool execution races shared Toolbox state

**Severity:** MEDIUM
**Files:** `llm/models.py:1052` (`Response.execute_tool_calls`), `llm/models.py:1256` (`AsyncResponse.execute_tool_calls`)
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
The sync path runs tool calls sequentially. The async path batches coroutine tools into `asyncio.create_task()` + `asyncio.gather()` after a single `prepare_async()` call. If a model emits multiple calls against the same `Toolbox` instance, and that toolbox maintains state, the parallel run can cause interference.

**Impact:** Order-dependent or stateful tools (e.g., a tool that maintains a counter or writes to a shared resource) can produce incorrect results or corrupt shared state when run concurrently.

**Evidence:**
- Codex traced the async tool parallelization commit: `432763d0a64488013ae2809ce1365d72c0b074a2`
- `Toolbox` instances are cached/shared via `_get_instance`
- The sync path guarantees sequential execution; the async path does not

**Suggested fix:** Document that async tool execution is parallel, or add opt-in sequential mode for stateful tools.

---

### Finding 5: --async --usage with tools crashes

**Severity:** MEDIUM
**Files:** `llm/cli.py:479` (`prompt`), `llm/models.py:823`, `llm/models.py:1677`
**Found by:** Codex | **Confirmed by:** Gemini (as inconsistent usage reporting)

**Description:**
In the async tool path, `prompt()` returns an `AsyncChainResponse`. The usage-reporting block only special-cases `ChainResponse`; everything else is treated like a single response object and `.token_usage()` is called on it. `AsyncChainResponse` does not provide that method in the expected form.

**Impact:** Running `llm prompt --async --usage` with tool-calling models may crash after a successful run, or report incomplete/missing usage data.

**Evidence:**
- Codex found the type mismatch in the CLI handler
- Gemini independently identified inconsistent usage reporting in `AsyncChainResponse` at line 1677

**Suggested fix:** Add `AsyncChainResponse` handling to the usage-reporting block in `prompt()`, or unify the usage API across response types.

---

### Finding 6: Tool instance logging attributes metadata to wrong tool

**Severity:** MEDIUM
**Files:** `llm/models.py:828` (`_BaseResponse.log_to_db`)
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
In `_BaseResponse.log_to_db()`, the `tool_instances` INSERT inside the `for tool_result in self.prompt.tool_results` loop references `tool.plugin` and `tool.name` from an earlier `for tool in self.prompt.tools` loop. In Python, the loop variable `tool` retains its last value after the loop ends.

**Impact:** Multi-tool runs record the wrong toolbox name/plugin for all tool results except those that happen to match the last tool in `self.prompt.tools`. Database logs become misleading for debugging and auditing.

**Evidence:**
- Classic Python "stale loop variable" pattern
- Gemini confirmed: "all tool_results would be incorrectly attributed to whichever tool happened to be last in the self.prompt.tools list"

**Suggested fix:** Look up the correct tool for each `tool_result` by matching on tool name or ID, rather than relying on the loop variable.

---

### Finding 7: Negative --chain-limit fails immediately

**Severity:** MEDIUM
**Files:** `llm/cli.py:479`, `llm/models.py:1626`, `llm/models.py:1682`
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
The CLI accepts any `int` for `--chain-limit`. The check in `ChainResponse.responses()` and `AsyncChainResponse.responses()` is:

    if self.chain_limit and count >= self.chain_limit:

Since `-1` is truthy in Python, and `0 >= -1` is `True`, the chain fails on the first response with "Chain limit of -1 exceeded."

**Impact:** Negative values produce a confusing error instead of being rejected at input validation or treated as "unlimited."

**Evidence:**
- Gemini confirmed both the truthiness issue and the comparison logic
- `0` is documented as "unlimited" but negative values are not handled

**Suggested fix:** Validate `--chain-limit` at the CLI level (reject values < 0), or normalize negatives to unlimited.

---

### Finding 8: Async-to-sync logging is half-implemented

**Severity:** MEDIUM
**Files:** `llm/models.py:1512` (`AsyncResponse.to_sync_response`), `llm/models.py:1610` (`_BaseChainResponse.log_to_db`)
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
`AsyncResponse.to_sync_response()` contains a comment stating the model conversion "might need adjustment." Yet `_BaseChainResponse.log_to_db()` relies on `asyncio.run(response.to_sync_response())` to convert async responses before logging.

**Impact:** `asyncio.run()` cannot be called from within an already-running event loop. Library users embedding `llm` in async applications (Jupyter notebooks, FastAPI, async scripts) will get a `RuntimeError: This event loop is already running`.

**Evidence:**
- Gemini confirmed: "asyncio.run() is intended to be the main entry point for an asyncio program; it cannot be called if an event loop is already running"
- The TODO comment in the source acknowledges this is unresolved

**Suggested fix:** Use `asyncio.get_event_loop().run_until_complete()` with proper loop detection, or refactor `log_to_db()` to handle async responses natively.

---

### Finding 9: Uncaught hook exceptions crash async tool execution batch

**Severity:** MEDIUM
**Files:** `llm/models.py:1256` (`AsyncResponse.execute_tool_calls`)
**Found by:** Gemini | **Confirmed by:** Codex

**Description:**
In the async tool execution path, `before_call` and `after_call` hook callbacks run outside the `try/except` that catches tool implementation failures. `asyncio.gather()` is used without `return_exceptions=True`, so a single hook exception propagates and fails the entire batch.

**Impact:** A buggy plugin hook crashes all parallel tool calls. Results from sibling tasks that completed successfully are lost.

**Evidence:**
- Codex verified against the upstream async tool parallelization commit (`432763d0a64488013ae2809ce1365d72c0b074a2`)
- Codex nuance: "Sibling tasks may still continue in the background, but their results are lost to the returned batch"

**Suggested fix:** Wrap `before_call`/`after_call` in try/except within the async task, or use `return_exceptions=True` on the gather call.

---

### Finding 10: Memory exhaustion with large attachments

**Severity:** MEDIUM
**Files:** `llm/default_plugins/openai_models.py:544` (`_attachment`)
**Found by:** Gemini | **Confirmed by:** Codex

**Description:**
`_attachment()` eagerly calls `attachment.base64_content()`, which reads the full file into memory, base64-encodes it (expanding size by ~33%), and embeds it as a data URI in the JSON payload. For large PDFs, multiple high-resolution images, or audio files, this creates massive memory spikes: raw bytes + base64 string + JSON object overhead are all resident simultaneously.

**Impact:** Local resource exhaustion (OOM) when processing large or numerous attachments. This is a performance/resource issue rather than a correctness bug.

**Evidence:**
- Codex confirmed: "raw bytes, expanded base64, and Python object/string overhead are all resident around the same time"
- Multiple attachments multiply the peak memory usage

**Suggested fix:** Stream attachments where possible, or add size limits/warnings for large files. This may be constrained by API requirements (OpenAI expects base64 inline).

---

### Finding 11: cosine_similarity() divides by zero on zero vectors

**Severity:** LOW
**Files:** `llm/__init__.py:461` (`cosine_similarity`), `llm/embeddings.py:238` (`similar_by_vector`)
**Found by:** Codex | **Confirmed by:** Gemini

**Description:**
`cosine_similarity()` computes `dot_product / (magnitude_a * magnitude_b)`. If either vector is all zeros, the magnitude is 0 and a `ZeroDivisionError` is raised. This function is registered as a SQLite UDF via `similar_by_vector()`.

**Impact:** A malformed embedding model that returns an all-zero vector will crash similarity search queries. While rare in practice (well-trained models don't produce zero vectors), plugin-provided or degraded models could trigger this.

**Evidence:**
- Both reviewers confirmed the division-by-zero path
- No guard clause or fallback value for zero-magnitude vectors

**Suggested fix:** Return 0.0 (or -1.0) when either magnitude is zero, rather than raising.

---

## Architecture and Quality Notes (Non-Bugs)

These are structural observations, not bugs. They increase maintenance cost but do not cause runtime failures.

### cli.py is a 4,050-line monolith

Three functions dominate:
- `logs_list()` -- 622 lines, complexity 43
- `prompt()` -- 450 lines, complexity 35, takes 30 parameters
- `chat()` -- 220 lines, complexity 20

### Sync/async duplication in models.py (2,165 lines)

`Response` and `AsyncResponse` contain near-duplicate implementations of `execute_tool_calls()` and `log_to_db()`. Bug fixes must be applied in two places.

### get_model() / get_async_model() mutual recursion

These functions call each other with a `_skip_async` guard to produce better error messages. The guard works but is fragile to refactoring.

### openai_models.py:register_models() -- 293 lines

The OpenAI model registration function defines multiple model classes inline and registers dozens of models. Maintenance risk as OpenAI's model lineup changes.

### Security model is trust-based

`--functions` runs arbitrary Python via the `exec` builtin. Tools are auto-invoked by the model unless `--tools-approve` is enabled. This is deliberate but the safety boundary is entirely user discipline.

### No SQL injection found

Both reviewers confirmed that SQLite queries use parameterized values throughout. Dynamic SQL in similarity search only interpolates fixed clause fragments and typed integers.

---

## Methodology Details

### sqry Analysis

    Index: 40 files, 5,499 symbols, 7,277 edges
    Tools used: get_insights, find_cycles (imports + calls), find_unused (public),
                find_duplicates (body, threshold 80%), complexity_metrics (min 5),
                pattern_search, explain_code, direct_callers, get_workspace_symbols

### Codex Review

- Model: gpt-5.4 via Codex CLI
- Duration: 11 minutes
- Tokens: 307,844
- Approach: sqry structural analysis -> GitHub source fetching -> commit history tracing
- Verified findings against upstream commits (e.g., 432763d0, 66ffde34)

### Gemini Review

- Model: gemini-2.5-flash via Gemini CLI
- Duration: 8 minutes
- Approach: sqry hierarchical search + pattern search -> independent analysis
- Some sqry tool errors due to schema validation issues (worked around with alternative queries)

### Cross-Validation

- 3 Codex-only findings (#5, #6, #7) sent to Gemini for validation -> all 3 confirmed
- 3 Gemini-only findings (#9, #10, #11) sent to Codex for validation -> all 3 confirmed
- Codex provided source-level evidence from GitHub for all Gemini findings, including specific commit references
