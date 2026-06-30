# 2.12.0 release: cross-LLM review gate PASS

Date: 2026-06-30
Branch: `release/2.12.0` (base `origin/master` 8bbae0d)
Scope reviewed: the full release diff (`origin/master..release/2.12.0`) plus the
multi-agent usability/quality pass it carries.

## What was reviewed

- **Skills packaging**: ship six caller-facing skills; exclude operator/maintainer
  skills; sanitize private MCP names; extend the tarball guard with a host-internal
  skill scan.
- **Devin visibility**: server-instruction lines + discovery-tool enum widening
  (`list_models`, `cli_versions`, `cli_upgrade`, `provider_tool_capabilities`).
- **Description sharpening**: description/metadata-only edits across request tools.
- **Reliability/error guidance (additive behavioral)**: Claude `is_error` warning +
  `resultIsError`, `empty_output` warning, `codexSessionId` surfacing, Claude json
  telemetry, `createErrorResponse` auth/timeout/idle/overflow/codex/empty remediation,
  whitespace-prompt rejection. 14 new tests in `quality-pass-behavioral.test.ts`.
- **Release prep**: CHANGELOG 2.12.0, docs sweep, version bump + site sync.

## Verdict: UNCONDITIONAL APPROVAL (3 of 3)

Reviewers ran through the multi-LLM gateway against the real files (not the summary):

- **Codex** (read-only): initial pass raised two README Devin-documentation gaps
  (the `promptParts`-for-all-tools overclaim and missing Devin in the
  provider-capability inventory / `provider_tool_capabilities` filter /
  `provider-tools://devin` resource). Both fixed in `366e026`; re-review returned
  unconditional approval.
- **Grok**: unconditional approval with file:line verification of all ten review
  dimensions (additive-only, no double-warn, safe telemetry fallback, conservative
  auth detection, pure enum widening, skills guard, non-vacuous tests, doc accuracy,
  convention compliance).
- **Mistral**: unconditional approval, all ten dimensions verified.

No code-correctness blockers were raised. The breaking-change audit independently
confirmed the release is additive (no removed/renamed/required-promoted params,
no response-shape change), so 2.12.0 is a correct minor bump.

## Known non-blocking follow-ups

- `approval_list` keeps its narrower five-provider `cli` enum (no `devin`); the README
  documents this accurately. Widening it is a minor fast-follow.
- The remaining `#5` warning-surfacing items (mistral `disallowedTools` dropped,
  `model_substituted`, `acp_params_dropped`) were deferred to avoid expanding the
  release surface; the correctness-class behavioral fixes shipped.
