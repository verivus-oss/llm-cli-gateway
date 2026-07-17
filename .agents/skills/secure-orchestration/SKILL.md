---
name: secure-orchestration
description: Orchestrate security-sensitive LLM work with the gateway's Claude-managed approval boundary, provider-native legacy controls, evidence-aware auditing, and complete no-limit review handling.
metadata:
  author: verivus-oss
  version: "1.7"
---

# Secure Orchestration

Use this skill for sensitive code, privileged operations, autonomous changes,
and security review. A security review request goes through the installed local
stdio gateway MCP surface, never a direct provider binary, SDK, connector/shadow
gateway, or shell fallback. If that stdio surface is unavailable, repair it or
report the review incomplete.

## The approval boundary

`approvalStrategy:"mcp_managed"` is an enforcement boundary only for Claude.
The gateway creates a request-scoped strict MCP configuration from provisioned
gateway-owned local definitions. Codex, Gemini, Grok, Mistral, Devin, and Cursor
must use `approvalStrategy:"legacy"`; they reject managed approval before
launch because their ambient MCP configuration cannot be isolated.

For Claude managed requests:

- `approvalPolicy` may be `strict`, `balanced`, or `permissive`.
- The default policy is `balanced`; thresholds are strict `2`, balanced `5`, and
  permissive `7`.
- Full permission bypasses and unverified execution posture are denied by
  default. They require the caller's explicit request, an approval decision,
  and `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`.
- Native continuation/fork, `workingDir`, tool selectors, settings/plugins,
  additional directories, prompt-file controls, and other posture changes can
  require that same decision and operator setting. Do not add them casually.
- Under managed approval, only gateway-owned local definitions explicitly
  provisioned for the request are eligible. Dynamic package execution, ambient
  PATH, and provider-configuration overrides cannot bypass that boundary.

Do not imply that gateway-managed approval protects a non-Claude legacy request.
Its sandbox, tool, permission, MCP, session, and ACP controls belong to the
provider. Query `provider_tool_capabilities({cli:"..."})` before relying on any
of them.

## Safe request patterns

Routine Claude managed inspection:

```text
claude_request({
  prompt:"Audit the supplied evidence packet for security defects. Inspect available source directly and cite evidence.",
  approvalStrategy:"mcp_managed",
  approvalPolicy:"strict"
})
```

If the security audit must target a particular local checkout, treat
`workingDir` as a managed posture change. Obtain the approval decision and
operator setting first, or use a deliberate legacy provider-native path and
state that it is outside the managed boundary.

Codex inspection starts read-only:

```text
codex_request({
  prompt:"Inspect <repo> for security defects and report evidence.",
  workingDir:"<repo>",
  sandboxMode:"read-only",
  approvalStrategy:"legacy"
})
```

Use `sandboxMode:"workspace-write"` only when testing must write artifacts.
`fullAuto:true` is deprecated compatibility shorthand, not a modern security
control. On a Codex resume the sandbox setting is dropped.

Gemini/Antigravity rejects non-empty `allowedTools`, `skipTrust:true`, JSON and
stream-JSON output in the current headless path, plus unsupported policy and
attachment inputs. Mistral defaults programmatic legacy requests to
`accept-edits`; its session logging defaults on and `doctor --json` flags only
an explicit `[session_logging] enabled = false`. Devin and Cursor use legacy
controls reported by their capability records.

Native ACP is separately config-gated and rejects `mcp_managed` and
`approvalPolicy`. It is not a managed-CLI permission bypass.

## Complete security reviews

For a mandatory review, use the evidence packet and seven-provider roster in
`multi-llm-review`:

- For a normal read-only Git audit, prefer `review_changes` when durable
  SQLite/PostgreSQL validation storage is available. It captures the complete
  committed/staged/unstaged/untracked artifact, fences repository content as
  untrusted data, and starts repository-bound read-only reviewers. Collect its
  validation `job_status`/`job_result` references and keep the returned hashes.
  If a judge was planned, wait for terminal results and call
  `synthesize_validation` with the `validationId` and same repository selector.
  Review synthesis ignores caller question/results, reloads exact owned durable
  linked terminal jobs, reconstructs unavailable requested seats as skipped,
  and claims the authoritative stored judge once. The stored repository, owner,
  judge, and consent cannot be replaced by follow-up arguments.
  HTTP/API seats require explicit local upload consent; remote workspace audits
  cannot upload the artifact to an API reviewer.

- Discover Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor capability
  and target-routing status before dispatching.
- Require direct source/test/doc inspection, file:line or command evidence, and
  strict `APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL`
  output.
- Do not set a review round, turn, token, price, budget, or wallclock cap. Do
  not use least-cost routing or cheapest-reviewer selection.
- Repaired findings require fresh evidence and re-review. A conditional,
  malformed, timed-out, or unavailable required reviewer means
  `INCOMPLETE`/`BLOCKED`, never approval.
- An `idleTimeoutMs` is a no-output safeguard, not an acceptance deadline. If
  it terminates a review, repair/retry the dispatch or report the reviewer
  blocked; never accept the partial result as a pass.

Do not weaken a security review by excluding a provider, tool, target, or
verification step unless the user explicitly accepts the narrowed scope and its
limitation.

An unscoped local CLI child runs in a fresh private neutral cwd, not the gateway
repository. Use explicit `workingDir`, registered `workspace`, or gateway
`worktree` target routing. Cwd-scoped latest-session continuation fails closed
without a stable target. Argv-bound providers reject an oversized UTF-8 prompt
as non-retryable `input_too_large`; Codex sends new and resume prompts through
stdin, while `codex_fork_session` remains argv-bound and applies that rejection.
Every caller-controlled argv value is admitted in its final encoded form,
including serialized JSON and joined lists, before spawn. No path truncates
instructions or other values to make them fit. The resolved command line also
has a conservative platform-specific aggregate byte budget and a 2,048-element
cap. The byte budget excludes environment bytes while reserving headroom;
Windows preflight assumes the smaller npm `.cmd`/`.bat` wrapper limit until
resolution proves a native executable. Handler-added native session flags are
admitted before workspace, session, provider-artifact handoff, or durable-job
effects on non-Kit requests. Claude Kit projects its eventual argv before
compiled-context artifact materialization or durable Kit-session allocation.
Native `E2BIG` remains a redacted fallback.
An embedded NUL byte in command or argv is rejected before spawn as
non-retryable `invalid_input`. Public results, long-lived job memory, durable
args, and async flight rows use a fixed invalid-argv marker, while the optional
duplicate durable payload is suppressed. None retains the rejected vector or
Node's value-echoing native error. Stdin-backed
requests accept a clean provider exit only after the complete payload write
callback succeeds; a closed or pending delivery becomes a fixed non-sensitive
failure.

## Explicit user-authorized full-access security review

An explicit user grant of full provider permissions and native MCP access is a
deliberate legacy-provider review posture, not a Claude-managed approval
boundary. Keep the safe patterns above for ordinary security work. For the
full-access case, use the complete `multi-llm-review` protocol and its exact
per-provider mapping, rather than adding an ad hoc allowlist or assuming that
`mcp_managed` can grant other providers native MCP access.

Build the exact target checkout and start `node dist/index.js --transport=stdio`
there for every review iteration. Do not use a globally installed or stale
gateway. Reapply each provider's full-access controls to each new job, preserve
ambient native MCP configuration, and record the live capability result. Give
the reviewer a corrective-program verification report, the exact base and diff
or changed-file list, untracked product files, and durable review evidence. It
must independently inspect source, docs, tests, commands, and relevant MCP
facts, then return only `APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED`, or a
concrete `BLOCKED_EXTERNAL` result.

Do not set caller review caps. On a user-required 90-second progress cadence,
use a non-blocking wait and do not poll early. Full execution capability does
not authorize review mutation: ask reviewers not to edit, stage, commit, reset,
or otherwise alter the target unless separately instructed.

## Approval records and privacy

Read managed-Claude decisions with:

```text
approval_list({limit:50,cli:"claude"})
```

An approval record includes its ID, timestamp, status, policy, CLI, operation,
score/reasons, requested MCP names, bypass/full-auto flags, a prompt hash, and
optional metadata. `promptPreview` is `[redacted]` by default. It contains up
to 280 normalized characters only when `APPROVAL_LOG_PROMPTS=1` is explicitly
enabled. `promptSha256` identifies prompt content; it is not a correlation ID.

Approval records are stored in the approval manager's JSONL log and have their
own lifecycle. Do not claim they share the async job store's retention policy.
They contain no job ID or correlation ID, so they cannot be joined to job output
by correlation. Preserve a caller-owned correlation ID, job ID, request result,
and exact evidence packet separately when an audit needs that linkage.

`approval_list` is evidence of a managed approval decision, not a complete
reconstruction of the request or provider output. Cache resources contain only
token/hash aggregates and cannot restore prompt/response text.

## Personal Agent Config Kit

Kit is local-only, supports only Claude/Codex, requires healthy durable
SQLite/PostgreSQL admission, and disables validation and least-cost routing. Its
effective profile may intentionally cap ordinary work. Before calling a Kit
security review complete, inspect `explain_effective_config`; a turn/budget cap
makes an exhaustive no-limit review constrained until an approved uncapped
profile or explicit user direction is available.

The normal Claude `workingDir` posture guidance does not apply to Kit execution.
Claude Kit requests reject caller-supplied `workingDir` before context
compilation. `explain_effective_config({workingDir:"<repo>"})` remains valid for
read-only inspection; execute Claude Kit work with an already configured
registered `workspace` alias or the configured default workspace. It never
inherits the gateway process cwd.

## Security checklist

- Confirm the actual provider, target checkout, session/native handle, and
  capability surface before dispatch.
- Use Claude managed approval only where its narrow boundary is sufficient.
- Keep secrets and credentials out of prompts, evidence packets, approval logs,
  and retained artifacts.
- Treat legacy provider permissions and native ACP as independent security
  surfaces.
- Preserve explicit audit linkage outside `approval_list`.
- Never turn an incomplete review into an approval because it was expensive,
  slow, or difficult to route.
