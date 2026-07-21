# contract: content-type@2.0.0

- class: tag-along-unaccepted-version + previously blocked-version (UN-BLOCKED 2026-07-21)
- path: node_modules/content-type

## advisory research (exa + GitHub + npm registry)
- latest npm: 2.0.0 (the current 2.x; MIT; 0 deps; 137M weekly downloads; 1975 dependents; author Douglas Christopher Wilson / jshttp; published 2026-05-11). Integrity in lock sha512 matches registry.
- advisory: NONE (no GHSA/OSV/CVE against content-type 2.0.0).
- v1.0.5 -> v2.0.0 changes: TypeScript rewrite, ~3x faster, lenient parsing (no longer throws during parse; caller validates type). No network/FS/proc capability added.
- WHY it was blocked (re-evaluated): Socket behavioral heuristics only - (1) new releaser blakeembrey (a reputable, long-standing npm maintainer) and (2) content-type 2.0.0 adds a `prepare` script (`ts-scripts install && npm run build`). `prepare` runs only in dev/git-install/publish contexts, NEVER for a registry dependency install. content-type declares NO `install`/`postinstall`/`preinstall`. So no install-time code executes for consumers. (Not all gateway install paths use `--ignore-scripts`; the load-bearing fact is the absence of registry-install hooks, not --ignore-scripts. The release-audit packed-consumer check does use --ignore-scripts as a further belt.)
- pulled in by: @modelcontextprotocol/sdk -> express@5.2.1 -> body-parser@2.3.0 (which requires content-type ^2.0.0). Prod.

## upgrade decision
- safe-to-upgrade: YES; un-block justified.
- rationale: mainstream jshttp package, no CVE, install-script surface neutralized (no install/postinstall/preinstall; content-type's only script `prepare` is not run for registry dependency installs). Required to allow body-parser@2.3.0 (which clears GHSA-v422-hmwv-36x6). Removed from BOTH blocklists (release-security-audit.sh + dep-drift-scan.mjs) and ledgered (append 2.0.0).

## commands
- npm run build: PASS; npm test: PASS (233 files / 3696 tests); npm run security:audit: PASS (packed-consumer-install policy now green); supply-chain:scan:check: exit 0.

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required)
- Round 1: Grok + Mistral APPROVED_UNCONDITIONALLY; Codex CHANGES_REQUIRED on ONE precision defect (the rationale over-claimed universal --ignore-scripts). Fixed: the safety rests on no preinstall/install/postinstall + content-type's `prepare` not running for registry dependency installs.
- codex: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-codex-r2, job 7f2cf443; cited npm registry scripts, OSV empty for both versions, blocklists tar-stream-only, classifier exit 0)
- grok: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-grok-r2, job ab686ac2; re-ran scan:check + security:audit exit 0)
- mistral: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-mistral-r2, job fbca9b53)
