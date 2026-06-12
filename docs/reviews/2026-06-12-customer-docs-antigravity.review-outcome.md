# Cross-LLM review outcome — customer-facing docs for the Gemini→Antigravity release

Date: 2026-06-12. Spec: `2026-06-12-customer-docs-antigravity.verification.md`.
Diff: `2026-06-12-customer-docs-antigravity.tracked.diff`. Base `e11b5cf`.
Proposed release: 2.6.0.

Four independent reviewers reached the working tree with full read access and
were instructed to verify every claim against actual code/docs (not the
summary), and to return either unconditional approval or one concrete blocker.

## Verdict: UNCONDITIONAL APPROVAL ×4 (no remaining blockers)

| Reviewer | Access | Rounds | Final verdict |
| -------- | ------ | ------ | ------------- |
| Codex (gpt, read-only) | read-only sandbox | raised 3 blockers (R1–R3), all fixed | UNCONDITIONAL APPROVAL (R4) |
| Gemini (Antigravity/agy) | yolo | approved R3, R4 | UNCONDITIONAL APPROVAL |
| Grok | always-approve | approved R3, R4 | UNCONDITIONAL APPROVAL |
| Mistral (Vibe) | auto-approve + trust | bare verdict rejected, re-asked with evidence | UNCONDITIONAL APPROVAL (evidence-backed) |

Mistral required vibe 2.14.1 (2.14.0 had a programmatic tool-execution
regression — see memory). Its first run returned a bare verdict with no
evidence and was REJECTED per the gate rule; the re-ask produced the six quoted
code↔doc evidence items.

## Blockers found and fixed (all code-cited by Codex, verified against source)

1. **approvalMode (README:491)** — documented `default|auto_edit|yolo|plan` as
   supported; `src/index.ts:2724-2733` rejects all but `default`/`yolo`. Fixed.
2. **yolo flag (README:498)** — claimed `--yolo`/`--approval-mode yolo`;
   `src/index.ts:2768-2770` emits `--dangerously-skip-permissions`. Fixed.
3. **session resume flag** — devto-tutorial.md:182 + the MCP instructions string
   `src/index.ts:365` said Gemini `--resume`; `resolveGeminiSessionPlan`
   (`src/request-helpers.ts:1140-1146`) uses `--conversation`/`--continue`. Fixed.
4. **spawn list (devto-tutorial.md:208)** — said gateway spawns `gemini`; it
   spawns `agy` (`src/executor.ts:32`). Fixed. Stale model example
   `gemini-2.5-pro` → `gemini-3-pro-preview` (`src/index.ts:6578`).

## Evidence each reviewer independently reproduced

- `grep -rniE '@google/gemini-cli|gemini --version' README.md site/ docs/launch/devto-tutorial.md` → empty (all four confirmed).
- `providerCommandName("gemini") === "agy"` (`src/executor.ts:32`).
- README/site/install/tutorial install → `curl …antigravity.google…`; upgrade → `agy update`; binary refs → `agy`; site version 2.0.0→2.6.0.
- Gemini + Mistral ran `npm test` (1182 pass) / `npm run check`.

## Deferred (NOT changed this release; reviewers judged defensible)

- Category B inbound "Gemini CLI" connect guides / support-matrix rows — separate
  capability; no code evidence `agy` is a verified inbound MCP host.
- Category C branding labels (generic "Gemini" / `gemini_request`) and the
  `~/.gemini` config-path line (UNASSESSABLE without an `agy` source).
- Historical launch/marketing blogs (`blog-cli-vs-api.md`, `reddit-claudecode.md`)
  asserting the old `--resume` — describe the product as it was; recommend a
  separate content refresh.

Gate satisfied. Pending: version bump to 2.6.0, CHANGELOG, `npm run check`,
publish, site deploy.
