---
name: retrospective-walk
description: Walk a human or agent through a diff, worktree, commit range, gateway job, or episode reference as a structured retrospective. Use after implement-review-fix or multi-LLM review cycles, when reviewing prior jobs or uncommitted work, or when durable evidence is needed for what changed, why it changed, who/when contributed, and captured human or model comments.
---

# Retrospective Walk

Guide a change review as a narrative with evidence. Prefer this when the user
needs the story of a change set, not just hunk-level inspection.

## Inputs

Accept these fields when the user supplies them, and infer conservative
defaults when they do not:

```json
{
  "scope": "diff | commit-range | worktree | job-id | episode-ref",
  "target": "diff text, HEAD~5..HEAD, path, job id, or episode reference",
  "mode": "guided | agent-driven | summary-only",
  "capture_comments": true,
  "models_for_why": [],
  "include_prior_evidence": true
}
```

Default `mode` to `guided` for a human in the loop, `agent-driven` for automated
review, and `summary-only` only when explicitly requested or when interaction is
not possible. Default `capture_comments` to true.

## Scope Resolution

Resolve the target into immutable evidence before analysis:

- `diff`: use the supplied diff text. If the target is empty, capture
  `git diff --no-ext-diff` and `git diff --cached --no-ext-diff`.
- `commit-range`: capture `git diff --stat <range>`, `git diff --name-status
<range>`, and per-commit metadata from `git log --format=fuller <range>`.
- `worktree`: capture status, dirty file list, staged diff, and unstaged diff.
  Do not stash, reset, or mutate the target worktree. If deeper model/tool
  analysis may write files, create a disposable isolated worktree or analyze a
  read-only evidence packet instead.
- `job-id`: fetch `llm_job_status` and `llm_job_result`; include `cli`,
  `correlationId`, `sessionId`, timestamps, exit status, captured output, and
  the bounded normalized progress snapshot actually returned. Page progress by
  `afterProgressSeq` when its event history matters, and record its capability
  and dropped count. Do not treat privacy-safe progress messages as raw
  reasoning, tool arguments, paths, or output evidence. Do not invent an output
  digest when the result has none. Personal Agent Config Kit deliberately
  withholds compiled context, provider output/error, and native handles from
  durable history; after a restart its job result may therefore be an explicit
  withheld marker rather than reconstructable output.
- `episode-ref`: resolve through the caller's available episode/DAG context. If
  no episode tool is available, record the unresolved reference and continue
  from any linked diff, job, receipt, or review artifacts the user supplied.

If `include_prior_evidence` is true, collect linked validation runs, receipts,
review reports, approval records, job ids, and session/cache state that are
available through gateway tools or local artifacts. Treat summaries as claims;
prefer raw diffs, job outputs, receipt ids, commands, and file:line evidence.

## Change Units

Group hunks and files into logical change units before narrating them. Favor
semantic intent over file boundaries, but keep units small enough to review.

Use these grouping signals:

- Shared feature, bug, invariant, or user-facing behavior.
- Production code plus its tests and docs.
- Config/schema/migration changes that must be deployed together.
- Review-only or evidence-only changes, such as verification reports.

Assign stable ids: `cu_001`, `cu_002`, etc. For each unit, record:

```json
{
  "change_unit_id": "cu_001",
  "title": "Short noun phrase",
  "files": ["src/example.ts"],
  "diff_refs": ["commit abc123", "hunk @@ -42,7 +42,9 @@"],
  "what": "Semantic summary of the delta",
  "why": "Intent, rationale, alternatives, and unresolved assumptions",
  "who_when": [
    {
      "actor_type": "human | model | agent | git-author | unknown",
      "identifier": "name, model key, job id, or commit author",
      "timestamp": "RFC3339 if known",
      "provenance": "commit, job, session, receipt, or user statement"
    }
  ],
  "evidence": ["file:line", "job id", "validation receipt id", "command digest"],
  "comments": []
}
```

## What, Why, Who

For each change unit:

1. Extract **what** directly from the diff, file reads, tests, and docs.
2. Derive **why** from commit messages, issue/DAG context, review findings,
   prior receipts, job prompts/results, and nearby code intent.
3. Attribute **who / when** using git author/committer metadata, gateway job
   metadata, session ids, model keys, review outputs, and explicit user
   statements.
4. Mark inference boundaries. Use `inferred:` when intent or authorship is
   reasoned from evidence rather than directly stated.
5. Surface missing evidence as an open question instead of filling the gap with
   confidence.

Use `multi-llm-review` or direct gateway model calls only when why-synthesis is
ambiguous, high stakes, or explicitly requested. Dispatch those review/model
calls through the current local stdio gateway MCP surface, never a direct provider
CLI, connector/shadow gateway, SDK, or shell fallback. Omit `model` unless the
user requested specific variants. Use `approvalStrategy:"mcp_managed"` only for a
Claude request, where the gateway creates a request-scoped strict config from
provisioned gateway-owned local MCP definitions, excluding dynamic `npx`,
ambient `PATH`, and Codex-config overrides. Use `approvalStrategy:"legacy"`
and omit `approvalPolicy` for every other provider, then use async handling from
`async-job-orchestration` for longer analysis. Ask models for intent/rationale
synthesis, not for unverified approval.

If the user asks the retrospective to trigger an explicit full-access final
review, switch to the full protocol in `multi-llm-review`. Start a freshly built
target-checkout stdio gateway, reapply the provider-native grants per iteration,
preserve ambient native MCP configuration, and provide the verification report
as a corrective-program specification with the exact base, diff or changed-file
list, and durable evidence. A retrospective narrative or model comment is not
approval. On a user-required 90-second cadence, do not poll the resulting jobs
earlier than 90 seconds.

## Comment Capture

When `capture_comments` is true, comments are evidence. Capture them at the
change-unit level and, when possible, at the file/hunk/line location.

In `guided` mode, walk one unit at a time:

1. Present the unit's what/why/who and evidence.
2. Ask for comments, concerns, approvals, suggestions, or intent corrections.
3. Normalize each answer into the schema below.
4. Continue only after comments are captured or the user skips the unit.

In `agent-driven` mode, create agent/model comments only when they add evidence,
concern, approval, or intent clarification beyond the narrative. In
`summary-only` mode, do not stop for comments; include an empty comments array
unless comments were supplied up front.

Comment schema:

```json
{
  "comment_id": "cmt_<ulid>",
  "retrospective_id": "retro_<ulid>",
  "change_unit_id": "cu_001",
  "author": {
    "author_type": "human | model",
    "identifier": "werner or claude-4-opus",
    "model_key": "optional; only for model comments"
  },
  "timestamp": "RFC3339",
  "type": "note | concern | approval | suggestion | intent_clarification",
  "text": "Comment body",
  "location": {
    "file": "optional path",
    "hunk_range": "optional @@ range",
    "semantic_unit": "optional semantic code-search node or future semantic id",
    "line_start": 1,
    "line_end": 2
  },
  "linked_receipts": ["validation receipt ids"],
  "linked_jobs": ["async job ids"],
  "metadata": {
    "namespace.key": "freeform extension values"
  }
}
```

Generate ids in a stable, sortable form when the runtime has a ULID helper;
otherwise use `retro_<timestamp>_<short-hash>` and
`cmt_<timestamp>_<sequence>`.

## Output Contract

Emit both a readable retrospective and a machine-readable block. Keep the
machine block fenced as `json` and make it complete enough to persist.

Markdown structure:

```markdown
# Retrospective Walk: <target>

Retrospective ID: retro_<id>
Scope: <scope>
Mode: <mode>
Evidence baseline: <commands, commits, jobs, receipts>

## Narrative

<overall story: what happened, why, and remaining uncertainty>

## Change Units

### cu_001 - <title>

What: ...
Why: ...
Who / when: ...
Evidence: ...
Comments: ...

## Open Questions

- ...

## Evidence Package

- validation_receipt: <id or unavailable: reason>
- linked_jobs: [...]
- linked_receipts: [...]
```

Machine-readable shape:

```json
{
  "retrospective_id": "retro_<id>",
  "schema_version": "retrospective-walk.v0.1.0",
  "scope": "commit-range",
  "target": "HEAD~5..HEAD",
  "mode": "guided",
  "created_at": "RFC3339",
  "provenance_context": {
    "commands": [],
    "commits": [],
    "jobs": [],
    "receipts": [],
    "episodes": []
  },
  "change_units": [],
  "comments": [],
  "narrative": "",
  "open_questions": [],
  "validation_receipt": {
    "status": "minted | linked | unavailable",
    "validation_id": "optional",
    "receipt_id": "optional",
    "reason": "optional"
  }
}
```

## Validation Receipts

Use existing gateway validation receipt machinery when the retrospective is
backed by a terminal validation run and the validation surface is registered:

- For a prior validation ID, call
  `validation_receipt({validationId:"<id>"})` or read
  `validation-receipt://<id>` and link the own-or-not-found result.
- For review or why-synthesis model jobs launched during the retrospective,
  preserve job ids and retrieve receipts if those jobs are part of a validation
  run that can mint one.
- If no receipt-capable validation run exists, set
  `validation_receipt.status` to `unavailable` and include a reason. Do not
  claim a receipt was minted when the current gateway surface only produced a
  retrospective artifact.

Personal Agent Config Kit disables validation tools and is limited to local
Claude/Codex execution. Do not expect a validation receipt in Kit mode.

## DAG Plan

Use this plan shape when embedding the retrospective in a DAG or episode:

```toml
[plan]
name = "retrospective-walk"
version = "0.1.0"
description = "Guided retrospective over changes with what/why/who and comment capture as evidence"
owner = "verivus-oss"

[[node]]
id = "resolve-scope"
type = "data"
outputs = ["change_units", "provenance_context"]

[[node]]
id = "analyze-changes"
type = "compute"
inputs = ["change_units", "provenance_context", "models_for_why"]
outputs = ["analyzed_units"]

[[node]]
id = "capture-comments"
type = "human-or-agent"
inputs = ["analyzed_units"]
outputs = ["comments"]

[[node]]
id = "synthesize-retrospective"
type = "compute"
inputs = ["analyzed_units", "comments", "provenance_context"]
outputs = ["retrospective_markdown", "retrospective_json"]

[[node]]
id = "emit-evidence"
type = "side-effect"
inputs = ["retrospective_json", "comments", "analyzed_units"]
outputs = ["validation_receipt_id"]
```

Only update a DAG or episode when the caller provided a parent context and an
available tool supports that write. Otherwise emit the retrospective and the
evidence package without side effects.

## Security And Isolation

- Prefer read-only evidence capture. Do not mutate user worktrees while walking
  changes.
- Use a disposable isolated git worktree for model/tool operations that may edit
  files, especially for `scope = worktree`.
- Keep secrets, local account names, and machine-specific paths out of
  persisted comments and receipts unless the user explicitly requires them.
- Treat model-generated comments as model evidence, not human approval.
- Preserve provenance for every comment, job, receipt, and inferred rationale.
- Approval records are separate managed-Claude decisions. Their prompt preview
  is redacted by default and they contain neither a job ID nor correlation ID;
  do not use them to reconstruct a complete dispatch.
- If the retrospective includes a mandatory review, apply the strict completion
  contract from `multi-llm-review`: only
  `APPROVED_UNCONDITIONALLY` completes a reviewer, and a failed or unavailable
  reviewer is `BLOCKED_EXTERNAL` with its exact error.
