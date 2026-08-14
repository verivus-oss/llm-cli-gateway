# raw evidence, 2026-08-10 ledger change

Upstream sources captured verbatim for the `fast-uri@3.1.5`, `hono@4.12.34` and
`ip-address@10.3.1` roll-forwards. `MANIFEST.md` records the exact command
behind each file, so anything here can be re-fetched and diffed.

(The JSON files originally carried that command as a `// captured-by:` first
line, which made every one of them invalid JSON. I hit it myself trying to
`json.load` a captured registry document. The commands moved to `MANIFEST.md`
and the JSON is now plain JSON. The `.diff` files keep the inline prefix, since
a diff has no parser to break.)

**The authoritative artifact evidence** for ip-address is
`tarball-dist-ip-address-10.2.0-10.3.1.diff`: a diff of the two published npm
tarballs, both integrity-verified against the registry documents captured here
(`sha512-/+S6j4E9...` for 10.2.0, `sha512-1e9d3kb9...` for 10.3.1) before
extraction. It exists because a `compare` patch shows tagged source, while the
tarball is what actually gets installed, and a claim about the shipped package
should be checkable against the shipped package. The dist changes are confined
to the compiled forms of exactly the five source files the tag-to-tag compare
shows changing, which is the expected relationship between the two.

These exist because the cross-LLM roster does not have uniform network reach.
Grok has live web and exa access and Codex has exa plus ref MCP servers, but
Mistral has neither, and the runbook's rule is that a reviewer must verify
against npm, the advisory databases and the changelog rather than against my
summary. Handing a reviewer a summary and asking it to agree is not validation.
Capturing the sources lets an offline reviewer check the same bytes an online
one fetches, and lets an online reviewer catch it if these captures are wrong.

Contents:

- `osv-GHSA-*.json` (12) - full OSV records. The load-bearing field is
  `affected[].ranges[].events`, which gives the introduced and fixed versions
  the pins are derived from. Includes the four dev-tree advisories
  (brace-expansion, nanoid x2, postcss) that `osv-scanner` reports but that do
  not reach the prod closure and therefore do not enter the ledger.
- `registry-<pkg>@<version>.json` (6) - npm registry version documents for both
  the baseline and the resolved version of each package. Used for
  `dist.integrity`, `maintainers`, `_npmUser` (publisher), `repository` and
  `dist.attestations`. The baseline documents are included so the continuity
  claims can be checked as a diff rather than taken on trust.
- `attestation-<pkg>@<version>.json` (2) - SLSA provenance bundles for the two
  packages that publish them. The DSSE payload is base64 in
  `attestations[].bundle.dsseEnvelope.payload`; decoded, it carries the subject,
  the builder id, and the source repository, ref and commit.
- `compare-<pkg>-<from>-<to>.json` (3) - the upstream commit range between
  baseline and resolved: file list with line counts, and full commit messages.
  Trimmed to `files[]` and `commits[]`; the full GitHub payload additionally
  embeds every file's patch, which is large and adds nothing the file list plus
  the upstream repository does not already give.

## Correction, found in review

The change was first described as "exactly six version changes in
package-lock.json and nothing else". That is one line short. The lockfile also
carries a dependency-range string change inside the postcss entry:
`nanoid ^3.3.12 -> ^3.3.16`, because postcss 8.5.23 declares a newer nanoid
range than 8.5.18 did. It is a consequence of the postcss bump rather than a
separate decision, and postcss is dev-only so it does not touch the prod
closure, but a reader diffing the lockfile will see seven changes and should not
have to wonder about the seventh.

Grok caught it during cross-LLM validation. It was missed here because the diff
script used to describe the change compared only `(version, integrity)` per
lockfile path, which is blind to dependency-range strings.

## The publisher change

The one finding here that is not a routine version move: `ip-address` changed
publisher between 10.2.0 and 10.3.1, from the user token `beaugunderson` to
GitHub Actions under npm trusted publishing. `registry-ip-address@10.2.0.json`
and `registry-ip-address@10.3.1.json` show the change, and
`compare-ip-address-10.2.0-10.3.1.json` contains the two upstream commits that
introduce exactly that release-workflow change. See the contract for why this
reads as a strengthening rather than a compromise.
