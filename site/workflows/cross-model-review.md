# Cross-model review workflow

This deterministic transcript shows the intended shape of a review workflow. It
uses redacted output so the page remains stable while the runtime tool names are
checked against the generated tool fixture.

## 1. Start the gateway

```bash
npx -y llm-cli-gateway
```

The MCP client connects over stdio.

## 2. Capture the exact change and start reviewers

```text
> review_changes({
    workingDir: "/absolute/path/to/repo",
    scope: "auto",
    models: ["claude", "codex", "gemini"],
    stance: "adversarial"
  })
```

Deterministic transcript:

```text
evidence.complete: true
evidence.schemaVersion: review-evidence.v2
evidence.sha256: 49f0...redacted
evidence.files: committed + staged + unstaged + regular untracked
validationId: 5d7c...redacted
result: one read-only rawJobReference per reviewer
```

`review_changes` never truncates repository evidence. It fences the complete
artifact as untrusted data and returns exact artifact/prompt byte counts and
SHA-256 identities. Use a registered `workspace` instead of `workingDir` for a
remote HTTP/OAuth caller.

For a local HTTP/API reviewer or `judgeModel`, kickoff requires
`allowApiUpload: true`. An API judge is accepted only when the gateway can bind
that consent, the judge, repository, and caller to the durable `validationId`.
After every reviewer is terminal, call `synthesize_validation` with that id and
the same repository selector. Keep collecting results for progress and human
visibility, but review synthesis ignores caller `question` and
`providerResults`. It reloads the exact owned durable linked terminal jobs and
reconstructs requested but unavailable seats as skipped. The stored judge,
repository, owner, and consent are authoritative, and the judge is claimed
atomically once. Follow-up arguments cannot replace the stored policy or start a
second judge. General validation synthesis still requires caller-supplied
question and terminal results. Remote HTTP/OAuth workspace reviews reject API
uploads.

Inside the fenced `review-evidence.v2` artifact, `committedPatch`, `stagedPatch`,
and `unstagedPatch` are independent. Each includes its sorted `paths`, encoding,
exact byte length, SHA-256 identity, and content, so a staged change cannot be
hidden by reversing it only in the worktree.

With `scope: "auto"`, branch divergence is reviewed from the merge base with
working-tree evidence. Without divergence, a dirty tree selects uncommitted
changes, and a clean tree falls back to the last commit.

## 3. Collect every reviewer

```text
> job_status({ jobId: "<rawJobReference.jobId>" })
> job_result({ jobId: "<rawJobReference.jobId>", provider: "claude" })
```

Deterministic transcript:

```text
claude: APPROVED_UNCONDITIONALLY
codex: CHANGES_REQUIRED, asks for regression test coverage
gemini: APPROVED_UNCONDITIONALLY
```

Fix the material finding, run verification, then call `review_changes` again so
every approval is bound to the final exact artifact. A qualified approval or a
review based only on a summary is not unconditional approval.

## 4. Watch an ordinary long-running provider job

```text
> claude_request_async({
    prompt: "Inspect the authentication surface and return file:line findings."
  })
> llm_job_status({ jobId: "1f0c9a2e-redacted", afterProgressSeq: 0 })
> llm_job_watch({ jobId: "1f0c9a2e-redacted", afterProgressSeq: 2, waitMs: 30000 })
```

```text
status: running
progress.capability: structured
progress.nextAfterSeq: 4
progress.highWaterSeq: 4
progress.hasMore: false
```

Progress messages are bounded activity projections. They do not reveal raw
reasoning, provider-supplied tool names, tool arguments, paths, provider IDs, or
output text. Tool-start activity uses the fixed message `Using a provider tool`.

## 5. Recover the result

```text
> llm_job_result({ jobId: "1f0c9a2e-redacted" })
```

```text
complete: result recovered after gateway restart
summary: result recovered after gateway restart
```

## 6. Inspect the decision

Keep the artifact digest, validation ID, reviewer job references, verification
commands, and terminal results with the change record. The complete fenced
review prompt is retained in the expiry-bound durable job payload, while
persisted CLI argv contains only its hash marker and the flight recorder does
not receive the repository-review prompt.

Related references:

- Full agent guide: <https://llm-cli-gateway.dev/agents.md>
- Runtime tool index: <https://llm-cli-gateway.dev/tools.md>
- Install guide: <https://llm-cli-gateway.dev/install.md>
