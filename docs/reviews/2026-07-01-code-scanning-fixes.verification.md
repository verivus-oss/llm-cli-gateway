# Code Scanning Fixes Verification Packet — 2026-07-01

This packet is the corrective-program spec for the cross-LLM review gate. It is
a claim set, not evidence. Reviewers must verify it against the actual code,
tests, docs, and commands in this checkout.

## Review Scope

- Branch: `fix/code-scanning-alerts`
- Base commit: `7dfcfeae4f88bf6037407f1553961c703eeedfea`
- Change state: uncommitted working tree
- Diff command for tracked source/docs under review:
  `git diff -- .agents/skills/multi-llm-review/SKILL.md docs/guides/BEST_PRACTICES.md src/__tests__/acp-errors.test.ts src/__tests__/api-provider.test.ts src/__tests__/api-slice6.test.ts src/__tests__/grok-api-provider.test.ts src/__tests__/http-transport.test.ts src/acp/errors.ts src/api-http.ts src/index.ts src/oauth.ts`
- Untracked files inspection commands:
  `sed -n '1,220p' src/__tests__/gateway-logger.test.ts`
  `sed -n '1,220p' docs/reviews/2026-07-01-code-scanning-fixes.verification.md`

## Files Under Review

- `.agents/skills/multi-llm-review/SKILL.md`
- `docs/guides/BEST_PRACTICES.md`
- `src/acp/errors.ts`
- `src/api-http.ts`
- `src/index.ts`
- `src/oauth.ts`
- `src/__tests__/acp-errors.test.ts`
- `src/__tests__/api-provider.test.ts`
- `src/__tests__/api-slice6.test.ts`
- `src/__tests__/gateway-logger.test.ts`
- `src/__tests__/grok-api-provider.test.ts`
- `src/__tests__/http-transport.test.ts`
- `docs/reviews/2026-07-01-code-scanning-fixes.verification.md`

Out of scope and intentionally not touched:

- `docs/plans/remote-http-oauth-ux-improvements.dag.toml`
- `docs/plans/remote-http-oauth-ux-improvements.md`

## Code Scanning Alerts Targeted

- CodeQL `js/incomplete-url-substring-sanitization` in
  `src/__tests__/api-slice6.test.ts`.
- CodeQL `js/polynomial-redos` in `src/api-http.ts`.
- CodeQL `js/polynomial-redos` in `src/acp/errors.ts`.
- CodeQL `js/clear-text-logging` in `src/index.ts`.
- CodeQL `js/clear-text-cookie` in `src/oauth.ts`.

Scorecard policy alerts such as branch protection, code review policy, and
pinned npm install commands are policy/configuration issues and are not claimed
as source-fixed in this packet.

## Claims To Verify

1. `src/api-http.ts` no longer uses slash-trimming regexes for endpoint joining.
   It uses bounded index loops and one `slice()` per side, preserving the
   existing HTTPS-or-loopback URL guard.

2. `src/acp/errors.ts` no longer uses broad JSON body regexes like
   `/\{[\s\S]*?\}/g` or `/\[[\s\S]*?\]/g`. It uses a single-pass
   `redactJsonLikeBodies()` scanner that tracks nested object/array delimiters,
   JSON string state, and escapes without nested `indexOf()` rescans.

3. `src/oauth.ts` consent CSRF cookies are emitted through `oauthCsrfCookie()`
   with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/oauth`, and `Max-Age=300`.
   The max age is derived from `OAUTH_CODE_TTL_MS`.

4. `src/index.ts` central logger calls redact message strings and structured
   args before `console.error`. Error `name`, `message`, and `stack` are routed
   through `redactSecrets()`. Arrays/objects are bounded by depth and circular
   reference guards.

5. `src/index.ts` no longer includes the configured xAI API-key environment
   variable name in the missing-key error cause. The new message is generic:
   `xAI API key is not configured`.

6. `src/__tests__/api-slice6.test.ts` no longer tests OpenRouter guidance via a
   potentially incomplete URL substring check. It checks exact guidance step
   membership.

7. `src/__tests__/http-transport.test.ts` now asserts all expected OAuth CSRF
   cookie security attributes including `Max-Age=300`.

8. `.agents/skills/multi-llm-review/SKILL.md` and
   `docs/guides/BEST_PRACTICES.md` now document the standard review gate:
   stdio `gtwy`, full non-interactive verification access, 90-second polling,
   evidence packet, no cancellation for slow reviewers, evidence-based rebuttal,
   and iteration to unconditional approval or concrete blocker.

## Prior Reviewer Feedback Incorporated

Round 1 Claude/Codex review returned `CHANGES_REQUIRED`. Findings incorporated:

- `src/acp/errors.ts`: replaced the first-closer `indexOf()` scanner with a
  stack-based single-pass scanner that tracks nested delimiters, quoted strings,
  and escapes. Added regression tests for nested JSON, delimiters inside quoted
  strings, and a large unmatched delimiter run.
- `.agents/skills/multi-llm-review/SKILL.md`: changed the remaining stale
  "poll every 60s" guidance to "no more than once every 90s".
- `src/index.ts`: moved the depth cap before `seen.add(value)` so depth-limited
  non-cyclic objects are not left in the `WeakSet`.
- This packet now separates tracked `git diff` inspection from the untracked
  packet read command, so reviewers can inspect every file listed under review.

Earlier Mistral review returned `NOT APPROVED` with one concrete actionable gap:
the OAuth CSRF cookie lacked an explicit lifetime and the test asserted only
`Secure`. The current diff adds `Max-Age=300` and expands cookie attribute
assertions.

Other Mistral findings were reviewed against code:

- Stack traces already pass through `redactSecrets()` in `sanitizeLogError()`.
- Slash trimming is linear and uses index movement plus `slice()`, not repeated
  concatenation.
- `buildEndpointUrl()` is not a filesystem path resolver; traversal-style path
  claims require code evidence before being treated as blockers.

Round 2 Claude/Codex/Grok review returned `CHANGES_REQUIRED`. Findings
incorporated:

- `src/__tests__/gateway-logger.test.ts`: added regression coverage for the
  exported central logger. The test spies on `console.error` and verifies
  message strings, structured args, nested `Error` name/message/stack values,
  deep object truncation, and debug logging are redacted before stderr output.
- `src/__tests__/grok-api-provider.test.ts`: added coverage that the missing
  xAI API-key response contains the generic `xAI API key is not configured`
  message and does not leak the configured environment variable name.
- `src/acp/errors.ts`: added truncated structured-payload handling. If the
  scanner reaches EOF with an open object/array span that looks like a JSON-RPC
  or secret-bearing payload, it redacts the span to EOF instead of returning it
  raw. This covers the Grok/Codex-reported case where a quoted brace prefix
  poisoned the stack before a real prompt/secret payload.

## Local Verification Commands

Focused tests:

```text
npx vitest run src/__tests__/acp-errors.test.ts src/__tests__/gateway-logger.test.ts src/__tests__/grok-api-provider.test.ts src/__tests__/http-transport.test.ts src/__tests__/api-provider.test.ts src/__tests__/api-slice6.test.ts
Result after round-2 fixes: 6 test files passed, 123 tests passed.
```

Full gate:

```text
npm run check
Result: build passed; lint completed with existing warnings; prettier check
passed; 120 test files passed; 1897 tests passed; release security audit passed.
```

Security audit result digest:

```text
npm vulnerability audit: 0 vulnerabilities.
Production source dynamic execution scan: passed.
node:sqlite adapter isolation scan: passed.
shrinkwrap prod projection parity: passed.
dependency tree policy: passed.
hono security floor: passed.
packed consumer install policy: passed.
dist fetch-token heuristic scan: passed.
```

## Round 3 Review Results

All valid reviewers were dispatched through the stdio `mcp__gtwy` gateway
surface with no provider model nominated. Slow jobs were not canceled.

- Claude job `458a55f2-dd42-4510-9d1e-8d3d92d582e2`: `APPROVED`, no findings,
  unconditional blockers empty. Claude inspected the scoped git diff, source
  files, tests, docs, and reran the six focused tests.
- Codex job `65ec78eb-4966-4f2a-9db3-e47e73274c50`: `APPROVED`, no findings,
  unconditional blockers empty. Codex inspected the packet, scoped diff,
  source files, test files, focused tests, and `npm run check` evidence.
- Mistral job `7857c585-79bf-4e04-bd7a-c5f9934861eb`: `APPROVED`, no findings,
  unconditional blockers empty. Mistral inspected source, tests, docs, scoped
  diff, focused tests, and `npm run check` output.
- Grok job `43077261-01ab-4a41-8f61-f18969d69766`: `APPROVED`, no findings,
  unconditional blockers empty. Grok inspected source, tests, docs, scoped
  diff, ran the six focused tests, and verified `tsc -p tsconfig.build.json`.
- Antigravity job `40b645c4-0f2d-483a-a68e-de06de016853`: invalid review
  result. The job completed with empty stdout and stderr, so it was not counted
  as an approval.

## Reviewer Instructions

The packet above is not evidence. Reviewers must inspect the actual files,
neighboring code, tests, and docs. Approval must be based on verified code,
tests, docs, and command evidence, not on this packet's summary.
