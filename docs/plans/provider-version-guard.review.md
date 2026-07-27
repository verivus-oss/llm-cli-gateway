# Cross-LLM review record: provider version guard

Branch `feature/provider-version-guard`, base `master` @ `ab53a2b`,
final head `434b2ff`. Five rounds, ending in unconditional approval from
codex, grok and mistral.

## Findings that were real

Every one was reproduced locally before being accepted. None was waved away.

| round | reviewer | finding | outcome |
|---|---|---|---|
| 1 | codex | `void runStartupVersionCheck` does not yield: `getCliVersions` reaches `spawnSync` before its first await | Confirmed, and worse than reported. Measured **5277 ms** of event-loop blocking on every gateway start. Fixed: async collection plus a `setImmediate` yield. Re-measured 0 ms, loop responsive throughout. |
| 1 | codex | `rewriteTargetVersion` used a replacement string containing untrusted input | Found independently before the verdict arrived; reproductions matched. Fixed. |
| 1 | grok | timer logged "rebaselined" for any exit 2, but additive-only writes nothing | Confirmed. Log now reports what was written, not what the exit code implies. |
| 1 | grok | post-apply rebuild sat in the exit-3 branch only, so a pure version apply never rebuilt | Confirmed. This was the behaviour the previous commit message had claimed to fix. |
| 1 | grok | `grok update --check --json` returns structured data | Adopted in preference to scraping a prose banner. |
| 1 | mistral | `indexOf("};")` could match inside a string value | Addressed with a round-trip guard rather than a longer denylist. |
| 2 | codex | git-state inference unsound: staged writes invisible, non-git returns 129 | Confirmed by probe. Git dependency removed from the decision entirely. |
| 2 | codex | a failing diffstat pipeline aborts the script under `set -e`, skipping the rebuild | Confirmed. My first test of this was wrong (`f \|\| echo` suppresses errexit); re-tested bare, the abort is real. |
| 3 | codex | JSON shape not validated, only that it parses | Confirmed. |
| 4 | codex | an array containing `null` still slipped past the shape checks | Confirmed. Stopped enumerating shapes; the whole render body is now in one try. |

**Codex dissented in every round and was right every time.** That matches the
standing note in `feedback-cross-llm-review-settle-disputes-by-experiment`.

## Things the reviewers did not catch, found by self-probing

- Three corruption bugs in `rewriteTargetVersion`, found by feeding it hostile
  input rather than reading it: a `"` wrote invalid TypeScript, `$1`/`$&` were
  expanded as replacement patterns, and the key went into a `RegExp`
  unescaped so `gr.k` matched `grok`.
- **Two regression tests that could not fail.** `runStartupVersionCheck`
  swallows every error by design, so an `expect` inside the injected collector
  was caught and discarded; both passed with the fix reverted.
- A 928-line schema reformat that buried a 29-key addition, reduced to 41 pure
  additions.
- Two bugs introduced while fixing a reviewer finding: a second rebaseliner
  invocation that ran after the apply and always reported zero, and `STATUS=$?`
  capturing the wrong command so every run reported "no drift" while applying
  one.

## Reviewer conduct, for calibration next time

- **codex**: six correct findings, zero false positives. Runs away on broad
  read-heavy prompts (310 KB, 380 KB) and stalls; a tightly scoped prompt
  returns in ~60 s. Worth the cost.
- **grok**: strong when asked to run things. Verified all seven `--version`
  first lines live, exercised the four exit paths in a throwaway worktree, and
  ran the tests. Stalls on large inline prompts; pre-generating the diff to a
  file and shrinking the prompt recovers it.
- **mistral**: cannot execute anything in this environment. In round 1 of the
  earlier PR it asserted untested negatives; after being told, it stated its
  limits plainly every round and did genuinely useful static analysis with line
  cites. Treat its verdicts as scoped to reading, and say so.

## Final verification at `434b2ff`

`npm run check`: 3960 tests / 257 files pass, 0 lint errors, 0 vulnerabilities,
prettier clean, provider surfaces clean, site discovery validation passed.
Stops only at the shrinkwrap step, which behaves identically on `master`
because the shrinkwrap is generated at release time and never committed.
