# contract: type-is@2.1.0

- class: tag-along-unaccepted-version + previously blocked-version (UN-BLOCKED 2026-07-21)
- path: node_modules/type-is

## advisory research (exa + GitHub + npm registry)
- latest npm: 2.1.0 (current; MIT; 116M weekly downloads; 1538 dependents; jshttp; published 2026-05-13). deps: content-type@^2.0.0, media-typer@^1.1.0, mime-types@^3.0.0.
- advisory: NONE against type-is 2.1.0.
- v2.0.1 -> v2.1.0 change: the ONLY functional change is "upgrade to content-type@2 for faster parsing" (jshttp PR #95) plus CI hardening. No install scripts (only lint/test dev scripts).
- WHY it was blocked (re-evaluated): the same Socket behavioral posture on the jshttp 2.x majors (it depends on content-type@2). Not a CVE. No install-time code.
- pulled in by: @modelcontextprotocol/sdk -> express@5.2.1 -> body-parser@2.3.0 (requires type-is ^2.1.0). Prod.

## upgrade decision
- safe-to-upgrade: YES; un-block justified.
- rationale: mainstream jshttp package, no CVE, no install scripts; its 2.1.0 change is purely the content-type@2 bump. Required for body-parser@2.3.0. Removed from BOTH blocklists and ledgered (append 2.1.0).

## commands
- npm run build: PASS; npm test: PASS (3696); npm run security:audit: PASS; supply-chain:scan:check: exit 0.

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required)
- Round 1: Grok + Mistral APPROVED_UNCONDITIONALLY; Codex CHANGES_REQUIRED on ONE precision defect (the rationale over-claimed universal --ignore-scripts). Fixed: the safety rests on no preinstall/install/postinstall + content-type's `prepare` not running for registry dependency installs.
- codex: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-codex-r2, job 7f2cf443; cited npm registry scripts, OSV empty for both versions, blocklists tar-stream-only, classifier exit 0)
- grok: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-grok-r2, job ab686ac2; re-ran scan:check + security:audit exit 0)
- mistral: APPROVED_UNCONDITIONALLY (round 2; correlationId unblock-mistral-r2, job fbca9b53)
