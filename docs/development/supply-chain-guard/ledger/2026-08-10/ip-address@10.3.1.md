# contract: ip-address@10.3.1

- class: tag-along-unaccepted-version (ledgered name `ip-address` moving 10.2.0 -> 10.3.1; roll-forward-in-intent to clear three live advisories)
- path: node_modules/ip-address

This is the first individual review of `ip-address`. Its only ledger entry is
the 2026-07-10 bootstrap, whose rationale reads "bootstrap from 2.16.0 shipped
closure, not individually reviewed", so it is treated here as a first-time trust
review rather than a routine roll-forward.

## advisory research (registry + OSV + upstream diff + provenance)

- latest npm version: 10.4.0. **Deliberately not taken.** 10.3.1 is the highest
  of the three fix lines below, so it clears all three; 10.4.0 adds change
  surface this advisory set does not require. Resolved `dist.integrity`
  `sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`.
- GHSA/OSV advisory: FIXES three advisories. Affected ranges read from
  `api.osv.dev/v1/vulns/<id>`; the ledgered 10.2.0 is inside all three:
  - **GHSA-22jq-vg5j-6vgg** `[10.1.1, 10.2.1)`: misclassification of
    IPv4-mapped / NAT64 IPv6 addresses can bypass SSRF and trust-boundary checks.
  - **GHSA-4xrf-jv44-h6hh** `[10.1.1, 10.2.2)`: a CIDR suffix on the parsed
    address suppresses special-use classification.
  - **GHSA-mwp4-54f8-5fhr** `[0, 10.3.1)`: `Address4` decodes leading-zero octets
    as decimal while resolvers decode them as octal.
  - Applicability to THIS gateway: **not reachable at runtime.** All three
    advisories concern *special-use classification* (`isLoopback`, `isPrivate`,
    `isLinkLocal`, `isMulticast`, `isUnspecified`) being wrong, which matters to
    code using this library as an SSRF or trust-boundary guard. `ip-address` is
    in this closure only via
    `@modelcontextprotocol/sdk@1.29.0 -> express-rate-limit@8.5.2`, and
    express-rate-limit's entire use of it is
    `import { Address6 } from "ip-address"` for `ipKeyGenerator`: `new
    Address6(ip)` and `new Address6(`${ip}/${ipv6Subnet}`).networkForm()`, that
    is, IPv6 subnet grouping for rate-limit keys. It calls none of the
    misclassifying predicates. Beyond that, this repository never imports the
    SDK module that pulls express-rate-limit in at all: express-rate-limit
    appears only in the SDK's `server/auth/handlers/{authorize,register,token,
    revoke}.js`, and `src/` contains no import of `sdk/server/auth`,
    `mcpAuthRouter`, `authorizationHandler`, or `clientRegistrationHandler`
    (`src/oauth.ts` implements the gateway's OAuth surface itself). So the
    package is present in the installed prod closure but is never loaded on any
    path this gateway executes. The bump clears the audit finding regardless.
    No advisory outstanding against 10.3.1.
- changelog baseline -> resolved (v10.2.0 -> v10.3.1, beaugunderson/ip-address).
  Touched sources are `src/common.ts` (+26/-4), `src/ipv4.ts` (+21/-7),
  `src/ipv6.ts` (+145/-30) and the two `constants.ts` files, against +463/-11 of
  tests, plus `.github/workflows/release.yml` (+26/-0). `README.md` (+102/-96),
  `package.json` and `package-lock.json` also change.

  **Read this section as a summary, not an enumeration.** Three drafts tried to
  enumerate this range in prose and three review rounds found each one
  incomplete: Codex's third pass was still naming migrations the text had missed
  (`isTeredo`, `is6to4`, `isULA`, `isDocumentation`) and further runtime changes
  in the `fromURL` and URL-regex rework, v4-in-v6 subnet propagation, `to4()`
  prefix preservation, `to6to4()` and `Address4.groupForV6()` canonicalisation,
  and `addressMinusSuffix` initialisation. Hand-transcribing a 200-line diff into
  prose is the wrong instrument, and pretending otherwise is how a contract ends
  up asserting things nobody checked.

  The authoritative record is therefore the patch itself, captured verbatim at
  `evidence/patch-ip-address-10.2.0-10.3.1.diff`, alongside the equivalents for
  the other two packages. What follows groups that patch by the kind of change
  it contains and states what each means for this closure. A reviewer wanting
  the complete list should read the captured patch.

  **The classifier rework, which is the substance of the advisory fixes.**
  `common.ts` gains an exported `isHostInSubnet(address)`, the primitive
  `this.mask(address.subnetMask) === address.mask()`, and `isInSubnet` is
  refactored to delegate to it after its width check. The distinction is the
  point: `isInSubnet` asks whether this address's *network* is contained in
  another, so a CIDR suffix on the parsed address changes the answer, while
  `isHostInSubnet` asks whether the address itself falls inside a range and
  ignores the caller's suffix. Every special-use classifier on both classes is
  migrated from the former to the latter: `isMulticast`, `isPrivate`,
  `isLoopback`, `isLinkLocal`, `isUnspecified`, `isBroadcast`, `isCGNAT`,
  plus `Address6.getType()`, `isMapped4()` and the NAT64 prefix gate. That
  migration is GHSA-4xrf-jv44-h6hh. (An earlier draft put that NAT64 gate in
  `to4()`. Grok checked the installed source and corrected it: `to4()` only
  extracts the trailing 32 bits, while the `isHostInSubnet(prefix6)` gate sits
  in the NAT64 extraction path, `embeddedIPv4()` and `toAddress4Nat64`, which
  then call `to4()`.)
  `Address6` additionally gains `embeddedIPv4()`, returning the embedded
  `Address4` for IPv4-mapped (`::ffff:0:0/96`) and NAT64 well-known
  (`64:ff9b::/96`) addresses. **Seven** methods now consult it first and
  delegate to the embedded address: `isLoopback`, `isLinkLocal`, `isMulticast`,
  `isUnspecified`, `isPrivate`, `isCGNAT` and `isBroadcast`, so
  `::ffff:127.0.0.1` classifies as loopback. (An earlier draft named only four
  of the seven; Grok caught that too.) `::ffff:0:0/96 -> 'IPv4-mapped'` is added
  to the `TYPES` table. That is GHSA-22jq-vg5j-6vgg.

  **The behaviour change most worth knowing about.** `Address4.parse()` now
  throws `AddressError("IPv4 addresses can't have leading zeroes.")` for any
  octet matching `/^0\d/`, checked *before* the general regex so the message
  names the real problem. Input that previously parsed now throws. This is
  GHSA-mwp4-54f8-5fhr, and it is a hard rejection rather than a reinterpretation.
  `Address6`'s v4-in-v6 path is restructured to match the same notation
  permissively first, so a dotted-quad tail with a leading zero still gets that
  specific error with the offending octet highlighted rather than falling
  through as an unrecognised group.

  An earlier draft called this "the one change that could in principle bite the
  only consumer", reasoning that `express-rate-limit` calls `new Address6(ip)`
  on a request IP. **Codex refuted that, and it was right.** `ipKeyGenerator`
  gates the call: `import { isIPv6 } from "node:net"` and `if (isIPv6(ip)) {
  const address = new Address6(ip) }`. `net.isIPv6` rejects a dotted-tail form
  whose IPv4 part carries a leading-zero octet, which is precisely the input the
  new throw fires on, so the throw is unreachable through this consumer even in
  principle rather than merely unlikely. State the scope exactly, because a
  previous version of this sentence did not: `net.isIPv6` **accepts** valid
  mapped dotted-tail addresses such as `::ffff:127.0.0.1`; it is only the
  leading-zero variants it rejects. Codex caught that overstatement as well.
  The claim is recorded and withdrawn rather than deleted,
  because the reasoning that produced it (asserting reachability without reading
  the call site) is the same mistake this contract made twice on hono.

  **The rest of the classifier migration, and a wrong refutation I published.**
  Codex's round-3 report named further changes this contract had omitted. A
  draft first copied that list in unchecked, which was wrong; a later draft then
  claimed to have refuted most of it, which was also wrong, and worse, because
  it was asserted with evidence that could not support it. The refutation ran
  `grep -E '^[+-].*(isTeredo|is6to4|isDocumentation)'` over the diffs, found
  nothing, and concluded the migrations were not real. But each migration is a
  change *inside* the method body, so the method name only ever appears on an
  unchanged context line and that grep cannot see it. The correct result, from
  the diffs directly:
  - `isTeredo`, `is6to4`, `isULA` and `isDocumentation` **are** migrated, each
    `this.isInSubnet(X_SUBNET)` becoming `this.isHostInSubnet(X_SUBNET)`, in both
    the tagged source and the shipped artifact.
  - `Address4.groupForV6()` and `to4in6()` **do** gain canonicalisation:
    `this.address` becomes `this.correctForm()`, and
    `correct + infix + address4.address` becomes
    `correct + infix + address4.correctForm()`. (Codex's round-3 list called the
    second one `to6to4()`; that was its one naming error, and `to6to4()` is
    unchanged.)
  - `addressMinusSuffix` tightens from `addressMinusSuffix?: string` to
    `addressMinusSuffix: string` and is initialised to `''` in the constructor.

  So the classifier rework is broader than "the special-use predicates": it is
  every `isInSubnet` call that asks a question about an address rather than
  about a network.

  **This is where the tagged source and the shipped artifact stop agreeing, and
  it is the most consequential finding in this review.** Several changes appear
  in the tarball diff but *not* in the v10.2.0...v10.3.1 source compare, and the
  source capture is provably complete (every file's added and removed line
  counts match the compare's own totals). The reason is that **the published
  10.2.0 artifact did not match its own tag**:

      v10.2.0 tagged src/ipv4.ts       return this.correctForm().replace(
      v10.2.0 published dist/ipv4.js   return this.address.replace(
      v10.3.1 tagged src/ipv4.ts       return this.correctForm().replace(

  Both tags carry `correctForm()`, so the source compare shows no change, while
  10.2.0's shipped `dist` was compiled from something older than its own tagged
  source. The change is real for anyone installing from npm, which is everyone,
  and invisible to anyone reading only the tag diff.

  **Extent.** Method: compare each shipped `dist/*.js.map` `sourcesContent`
  against the file at the tag. For 10.2.0, three of the five source files
  disagree with their own tag:

      src/ipv4.ts          shipped map matches tag:  NO
      src/ipv6.ts          shipped map matches tag:  NO
      src/v6/constants.ts  shipped map matches tag:  NO
      src/common.ts        shipped map matches tag:  yes
      src/v4/constants.ts  shipped map matches tag:  yes

  For 10.3.1 the maps match the tag. Grok verified this independently and added
  a further point: the registry `gitHead` recorded for 10.2.0, `80fccaae`, also
  matches the tagged `correctForm()` source, so even the registry's own commit
  pointer disagrees with the artifact it accompanies.

  **The artifact-only deltas**, invisible in a tag-to-tag compare and delivered
  to every 10.2.0 consumer. Codex named these across rounds 3 and 6, and an
  earlier draft of this contract wrongly refuted several of them:
  - `Address4.groupForV6()` and `to4in6()`: `this.address` and
    `address4.address` become `this.correctForm()` and
    `address4.correctForm()`.
  - `addressMinusSuffix`: optional to required, initialised to `''`.
  - `src/v6/constants.ts`, and this is the one with security weight: the URL
    regexes were hardened at the tag and the hardening never reached the 10.2.0
    artifact.

        tag v10.2.0      RE_URL = /^(?:\[([0-9a-f:.]+)\]|([0-9a-f:.]+))(?:[/?#].*)?$/i
        shipped 10.2.0   RE_URL = /^\[{0,1}([0-9a-f:]+)\]{0,1}/

    The shipped form is unanchored and accepts no dotted-quad; the tagged form
    anchors and permits only a `[/?#]` tail. Anyone on 10.2.0 who parsed a URL
    through `Address6.fromURL` was using the loose regex. This is what Codex
    called "the broader fromURL and URL-regex rework" in round 3, and it is why
    that claim looked absent from the source compare while being entirely real.
  - **v4-in-v6 subnet propagation**, and this one is distinct from `to4()`
    prefix preservation, which an earlier draft conflated it with. At the tag
    the embedded `Address4` inherits the outer mask:

        tag v10.2.0      const v4Suffix = this.subnetMask >= 96 ? `/${this.subnetMask - 96}` : '';
                         this.address4 = new Address4(`${this.parsedAddress4}${v4Suffix}`);
        shipped 10.2.0   this.address4 = new Address4(this.parsedAddress4);

    On the shipped 10.2.0 artifact the suffix is dropped entirely, so the
    embedded `Address4` carries a default mask no matter what the IPv6 mask
    was. Codex found this one and it took a seventh round to land.
  - `to4()` prefix preservation and the wider `fromURL` handling, both in
    `src/ipv6.ts`, the third file whose shipped map disagrees with its tag.

  Moving to 10.3.1 therefore does more than clear three advisories: it is the
  first ip-address artifact in this closure whose contents match the source it
  claims to be built from.

  That is a point in 10.3.1's favour rather than against it. 10.2.0 was
  published from a user token and a local build, with no attestation; 10.3.1 is
  built by a GitHub-hosted runner under OIDC trusted publishing with SLSA
  provenance tying it to tag v10.3.1 at commit `be7e626c`, and its artifact does
  match its tag. The provenance change described below is not just better
  paperwork, it is the mechanism that closed this gap.

  Two lessons, both mine. Copying a reviewer's list unchecked was the first.
  Publishing a refutation on the strength of a grep that structurally could not
  find what it was looking for was the second, and is the same class of error as
  the hono import claim earlier in this file: asserting a negative from a search
  without first checking the search could return a positive.

  **The remaining changes, none advisory-related.**
  - A stacked subnet suffix (`::/0/1`) is now rejected with
    `Invalid subnet mask.`; `RE_SUBNET_STRING` anchors on the end and strips
    only the trailing suffix, so a second one used to fall through into group
    parsing.
  - `Address6.fromURL` fixes an off-by-one in its port squelch, `port > 65536`
    to `port > 65535`. Note the mechanism, which an earlier draft got wrong by
    saying the port is "rejected": an out-of-range port is set to `null` and the
    address still parses. Grok caught that imprecision.
  - `Address6.toByteArray` left-pads to `constants6.BITS / 4` hex characters, so
    it returns a full 16 bytes for addresses with leading zero bytes instead of
    a short array.
  - `.github/workflows/release.yml`: the new tag-triggered publish workflow, and
    then its switch to OIDC trusted publishing (see provenance below).

  **No new network, filesystem, or process capability surface**: everything
  added is address classification, parsing, or serialisation.
- provenance, and the one thing here worth not waving through: the **publisher
  changed** between the two versions. 10.2.0 was published by the user token
  `beaugunderson` with no attestation; 10.3.1 was published by GitHub Actions
  under npm trusted publishing (`oidcConfigId
  oidc:8401742d-4bfe-4c90-9272-6faf86d88939`) with a SLSA v1 provenance
  attestation. That is a strengthening rather than a compromise signal, and it is
  corroborated three ways: the sole maintainer is unchanged
  (`beaugunderson <beau@beaugunderson.com>`); the upstream commit range contains
  the two commits that make exactly this change ("Publish + tag automation on v*
  tag push (closes #205)" then "Switch release workflow to npm trusted publishing
  (OIDC) ... drops NPM_TOKEN"); and the attestation bundle itself verifies, with
  subject `pkg:npm/ip-address@10.3.1`, builder
  `https://github.com/actions/runner/github-hosted`, and source
  `git+https://github.com/beaugunderson/ip-address@refs/tags/v10.3.1` at commit
  `be7e626c0d49fccb518899f520a3fb64ee189741`. License unchanged (MIT). The
  repository URL changed from `git://` to `git+https://`, which is metadata
  normalisation, not a relocation.
- pulled in by: `@modelcontextprotocol/sdk@1.29.0 -> express-rate-limit@8.5.2`
  (declares `ip-address ^10.2.0`). Prod. `10.3.1` satisfies that range, so this
  does **not** cross a parent range and `EXPECTED_TREE_PROBLEMS` in
  `scripts/check-consumer-tree.mjs` is deliberately unchanged. Applied by adding
  a **new** exact override `ip-address 10.3.1`, since nothing in the tree
  demanded a version above 10.2.0 on its own.

## upgrade decision

- safe-to-upgrade: YES
- rationale: Clears three live advisories, none of which is reachable here: the
  only consumer uses `Address6` for subnet key generation and never calls the
  misclassifying predicates, and this repository never imports the SDK module
  that loads that consumer. The diff is confined to address classification plus
  release automation, adds no capability surface, and keeps the same sole
  maintainer. The publisher change is a deliberate, upstream-documented move to
  OIDC trusted publishing and makes 10.3.1 strictly better attested than the
  10.2.0 it replaces.

## commands (resolved tree, recorded separately from reviewer verdicts)

- npm run build: PASS (tsc clean, exit 0)
- npm test (full suite): PASS (261 files, 4000 tests, 0 failures, 148s)
- npm audit --omit=dev --audit-level=moderate: PASS (found 0 vulnerabilities, exit 0)
- npm audit (all dependencies including dev, the scope osv-scanner reads): PASS (found 0 vulnerabilities, exit 0)
- npm run supply-chain:scan:check (--frozen gate): exit 3 before the ledger change, naming exactly these three rows as tag-along-unaccepted-version against 91 clean instances, 0 added, 0 dropped, 0 source anomalies, 0 integrity mismatches. Re-run after the ledger append and baseline refresh: **PASS, exit 0.** The ledger gained exactly three `acceptedVersions` entries and the baseline moved exactly three instances (9 insertions, 9 deletions); nothing was loosened.

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)

Seven rounds. Every reviewer verdict and job id below; the rounds themselves are
summarised in `REVIEW-LOG.md` beside this file.

- **grok: APPROVED_UNCONDITIONALLY** (round 7, correlationId
  `sc-2026-08-10-grok-r7`, job `4c736194-5aee-48b4-aef8-dc5fb871d1bb`). The
  strongest evidence in the programme: re-fetched both tags and both tarballs
  live, checked digests against captured and live registry documents, recomputed
  the committed tarball diff byte-identically, compared every `dist/*.js.map`
  `sourcesContent` against its tag, and confirmed three-of-five divergence with
  no fourth divergent file and all 10.3.1 maps matching. Demonstrated concrete
  `fromURL` differentials on the shipped 10.2.0 regex
  (`http://evil.example/[::1]:80` yields `::1` port 80; 10.3.1 fails closed).
  Earlier: APPROVED round 3, CHANGES_REQUIRED round 2 (correctly, on the
  `hono/utils/mime` misattribution), APPROVED round 1.
- **mistral: APPROVED_UNCONDITIONALLY** (round 7, correlationId
  `sc-2026-08-10-mistral-r7`, job `38481cd1-d310-4f57-9114-8ee0e8f86d0d`),
  having specifically checked for self-contradiction after two rounds left stale
  text behind. Note its round-2 APPROVED endorsed an error rather than catching
  it, which it acknowledged in round 3; treat its agreement as the weakest
  signal of the three.
- **codex: CHANGES_REQUIRED at round 7** (correlationId
  `sc-2026-08-10-codex-r7`, job `4065c5c4-3358-4550-acb7-4a8d9b100427`), on a
  single item: the v4-in-v6 subnet propagation delta was missing from the
  artifact-only list. That item was verified, is now recorded above, and a
  round-8 confirmation was dispatched (`sc-2026-08-10-codex-r8`). **The ledger
  and baseline were written before that confirmation returned, on the repository
  owner's explicit instruction.** That is a deliberate, disclosed deviation from
  the runbook's unanimity rule and is recorded here rather than papered over.

Codex dissented in every round it ran and was substantively right in every one,
including twice when this contract asserted the opposite. It is the reason the
tag-versus-artifact finding exists at all.
