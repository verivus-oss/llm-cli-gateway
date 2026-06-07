# Test-veracity mutation-probe audit — 2.1.0 release gate

Standing protocol (from slice ε): every new slice's test additions are audited
with strict-evidence mutation probes before release. Scope: the 10 tests added
since 2.0.0, in commits 5b6a250 (probe drift closure, 7+1 tests) and 8972937
(grok 0.2.32 leaderSocket, 2 tests + 1 generalised callback-forwarding test).

A probe PASSES (kills) when: with the mutation applied, the named test FAILS;
with the mutation reverted, the full focused file PASSES. A test that stays
green under its mutation is a tautology and blocks release.

## Probes

| # | Mutation (src) | Expected failing test |
|---|----------------|----------------------|
| P1 | computeFlagDrift: treat hiddenFromHelp flags like normal flags (drop the `spec.hiddenFromHelp` early-continue) | "does not report hiddenFromHelp flags as missing" |
| P2 | computeFlagDrift: delete the reappeared-hidden warning push | "warns when a hiddenFromHelp flag reappears in help (stale marker)" |
| P3 | computeFlagDrift: stop filtering acknowledged flags (always classify as extra) | "filters acknowledged upstream-only flags out of extraFlags" |
| P4 | computeFlagDrift: delete the vanished-acknowledged warning push | "warns when an acknowledged flag vanishes from the installed help (stale entry)" |
| P5 | validateUpstreamCliArgs: also accept flags from acknowledgedUpstreamFlags | "acknowledgement never affects the argv allowlist" |
| P6 | claude contract: declare "--print" in flags (it is acknowledged) | "live contracts keep flags and acknowledgements disjoint" |
| P7 | prepareGrokRequest: drop the leaderSocket argv push | "emits --leader-socket <PATH> when leaderSocket is set (Grok 0.2.32)" |
| P8 | grok_request sync callback: drop leaderSocket from the call object | "MCP tool callbacks actually forward every contract parameter (sync AND async)" |

Probes P1-P6 target src/upstream-contracts.ts; P7-P8 target src/index.ts.
Runner: scripts/run-mutation-probes.mjs equivalent executed ad hoc (see
evidence). Each probe: apply mutation → vitest focused → record → git checkout
revert → confirm clean run.

## Evidence

(appended by the runner below)
Run 1 (2026-06-07, pre-release working tree at HEAD 9d5666a):

| Probe | Result |
|-------|--------|
| P1 hiddenFromHelp skip removed | KILL |
| P2 reappeared-hidden warning removed | KILL |
| P3 acknowledged filtering removed | KILL |
| P4 vanished-acknowledged warning removed | KILL |
| P5 allowlist accepts acknowledged flags | KILL |
| P6 "--print" declared while acknowledged | KILL |
| P7 leaderSocket argv push removed | KILL |
| P8 leaderSocket dropped from sync call object | **SURVIVED** |

## Finding and corrective action (P8)

The callback-forwarding test used `String(handler).includes(param)`: removing
only the call-object line leaves the destructure line matching, so a genuinely
dropped param stayed green — a half-tautology. Fix: the test now requires
**>= 2** word-boundary occurrences of each contract parameter in the handler
source (destructure + rebuilt call object; verified minimum across all
tools/params today is exactly 2).

Re-run with strengthened test:

| Probe | Result |
|-------|--------|
| P8 (call-object line removed) | KILL |
| P8b (destructure line removed) | KILL |
| Clean tree | upstream-contracts.test.ts 24/24 pass (grok-handler.test.ts adds 17 more; combined focused run 41/41 — corrected per auditor finding, the earlier "24/24" line covered only the first file) |

## Auditor round 1 (Gemini/Grok/Mistral read-only seats) — findings and resolutions

All three seats independently found the same coverage gap: 2 of the 10 slice
tests were unprobed. Resolved with two additional probes (run 2026-06-07):

| Probe | Mutation | Target test | Result |
|-------|----------|-------------|--------|
| P9 | delete the baseline `if (!inHelp) missingFlags.push(flag)` in computeFlagDrift | "reports a declared flag absent from help as missing" | KILL |
| P10 | emit `--leader-socket` unconditionally (drop the truthiness guard) | "does not emit --leader-socket when leaderSocket is omitted" | KILL |

Post-P9/P10 clean run: 41/41 across both focused files.

Acknowledged residual risks (accepted, documented, not blocking): the >= 2
occurrence check is syntactic — comments/string literals mentioning a param
could inflate the count, and a future refactor to whole-object passing would
need the threshold revisited. The check is a drift tripwire, not a semantic
proof; the per-provider emission tests (P7-style) remain the semantic layer.

Verdict: 10/10 slice tests probed, 11/11 probes kill (P1-P10 + P8b);
release gate satisfied pending the executing auditor's (Codex) probe re-run.
