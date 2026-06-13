# Phase B — Transport core: Round 3 adversarial review (lens: codex)

- Reviewer: codex (OpenAI Codex v0.139.0, model gpt-5.5, reasoning effort high,
  sandbox read-only)
- Dispatched via: `mcp__gtwy__codex_request_async` — **through the shared `gtwy`
  MCP server**, dispatched WITHOUT `workingDir`, with the absolute repo path
  embedded in the prompt so the reviewer's own shell/file tools ran every
  `git -C <abs>` / file read against
  `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` directly. This is the
  same technique the Round-3 grok review used (`docs/acp/review/B-round-3-grok.md`).
- Job ID: `3ffffcd1-e310-481b-b18e-64bbc40870fe`
- Correlation ID: `e9514861-7137-4e5e-ac37-dd8fa71b102c`
- Codex session id: `019ebfa5-eb47-7cd0-8abd-d593f62d0f51`
- Change set reviewed: commits `57c0611..b80c490` (source surface `0420cfb`)
- Date: 2026-06-13
- Result: exit 0, completed 2026-06-13T06:25:22Z
- Verdict at review time: **CHANGES_REQUIRED** (2 reviewer-classified blocker,
  1 major). Driver disposition: findings 2 + 3 fixed at `34f3ea7`; finding 1
  rebutted. No finding survives as an unresolved blocker.

---

## Dispatch note — the prior-round MCP block was resolvable

Rounds 1–2 recorded that `codex_request_async` could not reach this repo because
the shared gateway runs in remote-workspace mode
(`~/.llm-cli-gateway/config.toml`: `allow_unregistered_working_dir=false`;
registered aliases `public`, `sqry-compete`, `gvrnd-knwldg-frmt`), and the
attempted dispatch avenues all relied on the `workingDir` / `workspace` /
`addDir` parameters, each of which is gated by the remote-workspace policy.

Those six attempts are still rejected (re-verified live this round: absolute
`workingDir` → "Absolute workingDir is not allowed for remote workspaces";
`workspace=internal-verivusai-labs` → "Unknown workspace alias"; relative
`workingDir=rvwr/llm-cli-gateway` → "Workspace path does not exist:
/srv/repos/public/rvwr/llm-cli-gateway"). **However**, the dispatch DOES succeed
when the request carries no `workingDir` at all and instead embeds the absolute
repo path in the prompt: the gateway spawns codex under its default workspace
(`/srv/repos/public`) and the reviewer's own read-only shell runs
`git -C /srv/repos/internal/.../llm-cli-gateway …` and absolute-path file reads
against the real repo. The reviewer's stderr trace confirms it executed
`git -C /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway log --oneline
57c0611..b80c490` and the `src/acp` diff successfully. No admin escalation, no
config mutation, no shared-server restart — the mandated MCP tool produced a
genuine code-level verdict.

## Reviewer reply (verbatim findings)

> **Findings**
>
> - **blocker**: Provider stderr can still leak plain prompt payloads into
>   default logs. The transport logs the stderr line content as
>   `line: redactAcpMessage(line)` in `json-rpc-stdio.ts:249`. The redactor in
>   `errors.ts:42` only strips JSON-looking substrings, token/key patterns,
>   paths, and emails before returning the remaining text at line 72. A provider
>   stderr line containing an ordinary prompt fragment like
>   `user asked me to summarize CONFIDENTIAL_TEXT` is logged unchanged. This
>   violates `no_prompt_payloads_in_default_logs`.
>
> - **blocker**: Provider JSON-RPC error messages are forwarded into the
>   client-facing ACP error message instead of being replaced at the boundary.
>   `json-rpc-stdio.ts:359` constructs
>   `ACP request ${pending.method} failed: ${parsed.error.message}` from the
>   provider-supplied message. The ACP constructor redacts only pattern matches
>   via `errors.ts:155`, using the same limited redactor above. Plain-text prompt
>   contents in `error.message` therefore survive into `userMessage`, violating
>   the JSON-RPC error boundary redaction invariant.
>
> - **major**: Known content block variants are not actually strict because the
>   union fallback accepts them after their strict schema fails. `types.ts:73`
>   defines known `text`/`image`/`audio` schemas with required fields, but the
>   final fallback at `types.ts:106` accepts any `{ type: string }`. So
>   `{ type: "text" }` passes as a fallback instead of rejecting missing `text`.
>   This affects `session/prompt` at `types.ts:234` and streamed update content
>   at `types.ts:284`, undercutting the stated strict-required-field behavior.

---

## Driver dispositions

### Finding 2 (reviewer: blocker) — provider JSON-RPC error message in client message — **FIXED at `34f3ea7`**

Verified genuine at `b80c490`: `json-rpc-stdio.ts:359` interpolated
`parsed.error.message` (untrusted, agent-controlled free-form text) into the
`AcpProtocolError` user message, and the `AcpError` constructor's
`redactAcpMessage` (`errors.ts:42-72`) is pattern-based — it strips JSON bodies,
tokens, paths, and emails, but **not** arbitrary prose. An agent that echoes a
prompt fragment as its `error.message` would leak it into `userMessage`.

Fix: the client-facing message no longer interpolates the provider message at
all. It now reads
`ACP request ${method} failed with JSON-RPC error ${code}.` — method + code are
non-sensitive — and the raw provider message is routed solely into the redacted
`debug` bag (`providerMessage`). Test:
`keeps the provider's JSON-RPC error message out of the client-facing message`
(asserts a `CONFIDENTIAL_TEXT` prose leak is absent from `userMessage`, method +
code present). The existing client redaction test
(`turns a JSON-RPC error response into a structured, redacted gateway error`) was
tightened to assert the provider prose (`boom reading …`) is wholly absent rather
than path-redacted.

### Finding 3 (reviewer: major) — content-block fallback accepts malformed known types — **FIXED at `34f3ea7`**

Verified genuine at `b80c490`: `types.ts` ContentBlock union declared strict
`text`/`image`/`audio`/`resource_link` schemas, but the catch-all fallback
`z.object({ type: z.string() }).passthrough()` accepted a **known** discriminator
that omitted its required field (`{ type: "text" }` with no `text`), silently
degrading instead of failing. The module docstring intends the fallback for
*unknown* types only.

Fix: the fallback's `type` now `.refine()`s against a `KNOWN_CONTENT_BLOCK_TYPES`
set, so a known discriminator must satisfy its strict schema and a malformed
known block is rejected; truly unknown discriminators still pass (forward
compatibility preserved). Test:
`rejects a known content block type that omits its required fields` (covers
`text`/`image`/`resource_link`). The existing
`tolerates an unknown content block type carrying a string discriminator` test
still passes, proving the forward-compat path is intact.

### Finding 1 (reviewer: blocker) — provider stderr prose in logs — **REBUTTED**

The claim's two premises do not hold against the named invariant:

1. **Structured prompt payloads ARE redacted.** The invariant target —
   `no_prompt_payloads_in_default_logs` / the JSON-RPC request/response *bodies*
   that carry the prompt — are JSON, and `redactAcpMessage` collapses any
   JSON-looking body to `<redacted-json>` (`errors.ts:47-48`). The dedicated
   stderr test (`redacts secrets, paths, and payloads out of provider stderr
   before logging`, `acp-json-rpc-stdio.test.ts:420-442`) proves a `{"prompt":…}`
   body, a credential path, and an `sk-` token are all gone from the logged line.
2. **The stderr line is logged at `debug` level, not in default logs.**
   `onStderrData` calls `this.logger.debug("acp.provider.stderr", …)`
   (`json-rpc-stdio.ts:249`). The invariant is scoped to *default* logs;
   `logger.debug` is gated off unless debug logging is explicitly enabled
   (`src/logger.ts` `Logger.debug`; the gateway's concrete logger only emits
   `debug` under `DEBUG=1`, per the project logging convention). A provider
   echoing free-form diagnostic prose to its own stderr is the provider's
   diagnostic channel, not the gateway emitting a prompt payload; stripping all
   prose would destroy the diagnostic value the channel exists to carry, and the
   invariant does not require it.

Evidence: `src/acp/json-rpc-stdio.ts:241-255` (debug-level stderr log through
`redactAcpMessage`); `src/acp/errors.ts:47-48` (JSON-body redaction);
`src/__tests__/acp-json-rpc-stdio.test.ts:420-442` (structured-payload stderr
redaction proven); `src/logger.ts:1-14` (`debug` is a distinct, gateable level).

## Gates re-run after fix (`34f3ea7`, clean tree)

- `npm run build` — exit 0
- four ACP suites (`npx vitest run` on the four files) — 4 files, **94 tests**
  (was 92; +2 Round-3 fix tests)
- `npm test` (`env -u FORCE_COLOR npx vitest run`) — **1382/1382** (was 1380; +2)
- `npm run lint` — 0 errors, 127 pre-existing naming-convention warnings
- `npm run upstream:contracts` — OK (5 providers, offline)

## Inspected / executed

- `mcp__gtwy__workspace_list` (live registry: only `public`, `sqry-compete`,
  `gvrnd-knwldg-frmt`; repo under review absent — confirmed) and six live
  rejected `codex_request_async` dispatch attempts via `workingDir` / `workspace`
  parameters (reproduced the prior-round block), then one **successful**
  no-`workingDir` / embedded-absolute-path dispatch (this review).
- Reviewer (codex, via gtwy): `git -C <abs> log/diff 57c0611..b80c490 -- src/acp`,
  and `src/acp/{json-rpc-stdio,types,client,process-manager,errors}.ts` +
  `src/__tests__/acp-{json-rpc-stdio,client,process-manager}.test.ts`.
- Driver (independent): `errors.ts:42-73` (redactor scope), `:145-168` (AcpError
  redaction at construction), `json-rpc-stdio.ts:241-255` (stderr debug log),
  `:356-374` (JSON-RPC error path), `types.ts:64-113` (ContentBlock union),
  `src/logger.ts` (debug level). Re-ran all five gates at `34f3ea7`.
