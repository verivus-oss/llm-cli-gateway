# supply-chain-guard ledger (audit trail)

Per-dependency audit trail for every ledger change the `/supply-chain-guard`
process approves. One contract per package per run, filed under a dated
directory:

```
docs/development/supply-chain-guard/ledger/<YYYY-MM-DD>/<pkg>.md
```

Each file is the filled `contracts/<pkg>.md` stub the scanner emitted (copied out
of the gitignored `.supply-chain/scan-<ts>/contracts/`), capturing:

- the drift class and the version move (baseline -> resolved);
- the exa advisory finding (latest npm version, GHSA/OSV, changelog review);
- the `safe-to-upgrade: YES/NO` decision and rationale;
- the test result (`npm run build && npm test && npm run security:audit`);
- the independent cross-LLM verdicts (codex / grok / mistral) with job ids.

This directory is the WHY behind every entry in
`supply-chain/prod-closure.ledger.json`: the ledger records the accepted exact
versions, and this trail records the review that justified each one. It is
internal-only (absent from the `package.json` `files` allowlist) and is committed
alongside the ledger + baseline change in the same PR.

Do not hand-edit the ledger or baseline without a corresponding entry here; the
runbook (`../RUNBOOK.md`) is the source of truth for the process.
