# ACP permission decision: what the bridge can and cannot gate

Exploration, 2026-08-18, at HEAD `801950d`. Prompted by the finding that
`ApprovalManager.decide` cannot deny for any ACP input: 21 of 21 approved at
score 0 across every policy and category, while content-bearing controls score
3, 5 and 7. Evidence and reproduction in
`docs/evidence/durable-state-2026-08-18.md`.

The question was framed as "fix the scorer, or drop the claim". Both framings
were wrong, and the reason is architectural rather than a scoring bug.

## 1. ApprovalManager is the wrong instrument, and un-starving it would not help

Its risk model answers **"is this Claude CLI launch configured dangerously?"**.
The inputs it scores are `bypassRequested`, `fullAuto`, `requestedMcpServers`,
`allowedTools`, `disallowedTools`, and `reviewIntegrity` violations
(`src/approval-manager.ts:104-186`). An ACP permission request has none of those
concepts. The bridge passes them as `false`, `false` and `[]` because there is
nothing else honest to pass.

It has exactly **one** content-sensitive branch:

```ts
if (/\b(delete|destroy|wipe|exfiltrate|credential|token|password|secret)\b/i
      .test(request.prompt)) { score += 3; }
```

So even if the bridge passed the real tool call, the only reachable signal would
be that regex. It would fire on a legitimate `delete` tool call and stay silent
on everything genuinely dangerous. That is false positives and false negatives,
not a control.

Note also `src/approval-manager.ts:62`: *"`decide()` is only ever reached on the
`approvalStrategy:"mcp_managed"` path."* The ACP bridge falsified that comment
without updating it, which is how a second caller acquired a risk model built for
a different question.

## 2. The bridge's redaction is at the wrong layer, and that is a separate bug

`createAcpPermissionDecider` states at `src/acp/permission-bridge.ts:165-166`
that "No tool-call payload, option, or path enters the prompt/metadata". That
invariant is what starves the scorer.

It is also redundant. `ApprovalManager` already redacts on write:

```ts
function promptPreview(prompt) {           // src/approval-manager.ts:68
  if (process.env.APPROVAL_LOG_PROMPTS === "1") return prompt...slice(0, 280);
  return "[redacted]";
}
function promptHash(prompt) { ... sha256 ... }   // :75
```

The manager is designed to receive real content and persist a hash plus
`[redacted]`. So the bridge is defending against a leak the callee already
prevents. Worth fixing the comment either way, but fixing it unlocks only the
regex above, so it does not change the verdict.

## 3. The reframing: the bridge gates callbacks, not operations

This is the load-bearing point.

The only fact in a permission request the gateway could verify rather than
believe is **path containment**: is the target inside the session's
gateway-owned workspace? `kind`, `title`, `locations` and `rawInput` are all
agent-supplied and unverifiable.

Two things block that, and the second is fatal to the idea:

1. `HostCallbackContext` carries only `{ provider, method }`
   (`src/acp/client.ts:139-144`). No session id, no cwd, no workspace. The bridge
   ignores the parameter entirely (`_context`). Fixable by widening it.

2. **The gateway never sees the syscall.** ACP host services flat-deny file
   reads today (`src/acp/host-services.ts:87`, "the request path is never
   inspected"), so an agent that wants to read or write a file does it *in its
   own process*, with its own file handles. A permission bridge cannot contain an
   operation the host does not perform. Checking a path the agent volunteered
   constrains a **claim**, not an action, and an agent willing to lie about
   `kind` will lie about `locations`.

So the bridge's real scope is: gate the host-service callbacks the agent asks the
**gateway** to perform. And those are already gated, well:

- `read`/`search`/`think` proceed (host fs reads are flat-denied anyway)
- `write` denied unless `allow_write_host_services`
- `execute` denied unless `allow_terminal_host_services`
- `fetch` categorizes as `other` and is **denied**
- any unknown `kind` is **denied** (`permission-bridge.ts:156-163`)
- only single-use allow options are ever selected; an agent offering only
  `allow_always` gets a denial (`:101-110`)

That is a deny-by-default category gate with no fail-open path. It is the whole
boundary, and it is sound. There is nothing meaningful a risk score could add on
top of an agent-supplied label it would have to trust anyway.

## 4. Options

| | Option | Verdict |
|---|---|---|
| A | Remove the decision call, keep an audit append, document the category gate as the boundary, fix `README.md:308` | **Recommended now.** Small, honest, ships with 3.1.0 |
| B | Widen `HostCallbackContext`, add workspace containment on `toolCall.locations` | **Rejected as a security control.** Constrains a claim, not an action. Worth doing only as defence in depth once host services actually perform file operations |
| C | Give `ApprovalManager` an ACP-shaped request kind that scores on the derived category | **Rejected.** Two risk models in one class, and the category is agent-supplied, so it scores a self-report |

Option A is not a retreat. The security property users were promised
("plus a one-time ApprovalManager decision") never existed; what exists is a
stricter gate than the sentence describes.

## 5. What this means for the real work

The security question worth spending effort on is not *how do we score an ACP
permission request*, it is **what should host services expose at all**. Today
they expose almost nothing, which is why the bridge has so little to decide. The
moment `allow_write_host_services` or `allow_terminal_host_services` is turned
on, the category gate is the entire boundary, and the operator should be told
that plainly rather than reassured about a second gate.

Recommended changes, all small:

1. Delete the `ApprovalManager.decide` call from the bridge, or keep it purely as
   an audit append with the return value unused and a comment saying so. Do not
   leave code that looks like a gate and is not.
2. Rewrite `README.md:308` to describe the category gate, deny-by-default for
   unknown kinds, and single-use-allow-only selection. That is a stronger and
   truer claim than the one it replaces.
3. Fix the false comment at `src/approval-manager.ts:62`.
4. Replace the stub-only deny tests (`fakeApproval("deny")`,
   `src/__tests__/acp-permission-bridge.test.ts:34-40`) with tests that drive the
   **real** decision path in both states. A control that was never run in both
   states is not a control.
5. When host services grow a real file or terminal capability, revisit B as
   defence in depth, enforced where the operation happens.
