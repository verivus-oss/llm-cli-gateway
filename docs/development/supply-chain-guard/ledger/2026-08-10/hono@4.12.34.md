# contract: hono@4.12.34

- class: tag-along-unaccepted-version (ledgered name `hono` moving 4.12.31 -> 4.12.34; roll-forward-in-intent to clear four live advisories)
- path: node_modules/hono

## advisory research (registry + OSV + upstream diff + provenance)

- latest npm version: 4.13.1. **Deliberately not taken.** 4.12.34 is the exact
  fix line for all four advisories below, so taking the 4.13.x head would convert
  a patch roll-forward into a minor one for no security gain, and every resolved
  version has to be individually ledgered here anyway. Resolved `dist.integrity`
  `sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==`.
- GHSA/OSV advisory: FIXES four advisories. Affected ranges read from
  `api.osv.dev/v1/vulns/<id>`; all four are patched at **4.12.34**, and the
  ledgered 4.12.31 is inside all four ranges:
  - **GHSA-54fx-42gc-7vw4** `[4.12.0, 4.12.34)`: algorithmic-complexity DoS in
    the Language middleware.
  - **GHSA-79qm-7rj5-m7r9** `[4.7.0, 4.12.34)`: the Proxy helper does not remove
    response headers listed in the `Connection` header.
  - **GHSA-8j4g-w8fx-2239** `[0, 4.12.34)`: ReDoS in the CORS middleware via
    `Access-Control-Request-Headers`.
  - **GHSA-f23p-vx2j-j53r** `[3.8.0, 4.12.34)`: `memo()` retains SSR output
    across requests, leading to cross-user data disclosure.
  - Applicability to THIS gateway: **none of the four affected surfaces is
    loaded.** `src/` imports exactly four SDK entry points (`server/mcp.js`,
    `server/streamableHttp.js`, `server/stdio.js`, `types.js`) and no hono
    module directly. The only hono consumption is transitive: the SDK's
    `server/streamableHttp.js:9` imports `getRequestListener` from
    `@hono/node-server`, for Node-HTTP-to-Web-standard conversion.
  - **Correction, raised by Codex in review, then corrected again by Grok.** An
    earlier draft said the gateway "imports no hono middleware, helper, or JSX
    entry point at all". That is false: `@hono/node-server/dist/index.mjs`
    statically imports `hono/ws` at line 5 (`defineWebSocketHelper`, used at
    line 1066 to build `upgradeWebSocket`), so hono helper code IS loaded.
    The first correction then overshot by also attributing `hono/utils/mime` to
    that file. It is not there: `index.mjs` line 2 is `node:http`, and
    `hono/utils/mime` appears only in `dist/serve-static.mjs`, a separate entry
    point that neither the SDK nor this repository imports. So the accurate
    statement is that exactly one hono submodule is loaded, `hono/ws`.
    What the decision rests on is narrower still and unaffected by either
    slip: `hono/ws` is not among the four advisory-affected surfaces, which are
    the Language middleware, the Proxy helper, the CORS middleware and the JSX
    `memo()` path; `hono/ws` is unchanged across 4.12.31 to 4.12.34; and
    `upgradeWebSocket` is never invoked here, since only `getRequestListener` is
    consumed.
  - **Second correction, same review.** An earlier draft also claimed the
    `Object.create(null)` parsing change was "the only change on the path this
    gateway actually exercises". That was asserted, not verified, and it is
    wrong. That change lives in hono's `src/request.ts` (`HonoRequest`) and the
    `src/utils/*` parsers it calls, which belong to the Hono application layer.
    `@hono/node-server` never constructs a `Hono` app or a `HonoRequest`: a grep
    of `dist/index.mjs` for `HonoRequest`, `new Hono` and `from "hono"` returns
    nothing, and `getRequestListener(fetchCallback)` (line 850) builds a Web
    `Request` and hands it to the SDK's own callback. So the gateway exercises
    none of hono's request-parsing layer, and the correct statement is that no
    change in this range is on a path this gateway executes.
  - Not exploitable in our deployment; the bump clears the audit finding
    regardless. No advisory outstanding against 4.12.34.
- changelog baseline -> resolved (v4.12.31 -> v4.12.34, honojs/hono): the four
  fixes are each visible in the compare as a distinct source change:
  `src/middleware/language/language.ts` (+15/-6), `src/helper/proxy/index.ts`
  (+12/-0), `src/middleware/cors/index.ts` (+1/-1), and `src/jsx/base.ts`
  (+1/-9), where `memo()` is reduced to a pass-through
  (`(props) => component(props)`), dropping the module-level `computed` and
  `prevProps` cache that leaked SSR output between requests. An earlier draft
  attributed the `memo()` fix to `src/jsx/hooks/index.ts`; that is wrong, and
  Codex caught it. `hooks/index.ts` carries a different change entirely, listed
  below. The
  remaining non-security source changes, listed after Codex's review found the
  first pass had summarised two of them away. This covers the runtime diff, not
  a full file inventory: `.github/workflows/ci.yml`, `bun.lock`,
  dev-dependency bumps in `package.json`, and test files are deliberately
  omitted. (An earlier draft also claimed README changes were omitted; the
  compare contains no README change, so that was a fabricated omission. Codex
  caught it.)
  - `src/adapter/aws-lambda/types.ts` (+9/-0): types only, adds the `jwt` and
    `lambda` authorizer variants.
  - `src/helper/streaming/sse.ts`: emit an empty `id` field to reset
    `Last-Event-ID`.
  - `src/middleware/secure-headers/secure-headers.ts` (+11/-7): scope CSP
    callbacks to their own header.
  - `src/request.ts` and `src/utils/{accept,url}.ts`: use `Object.create(null)`
    when parsing query, headers and params, a prototype-pollution hardening.
    These are separate consumers, not one call graph: `HonoRequest` uses the
    URL parser, while the changed accept parser is reached from the Language,
    accepts and compress paths rather than from `HonoRequest`. Codex flagged an
    earlier draft for implying they were all called by `HonoRequest`.
  - `src/utils/cookie.ts` (+8/-1): **a deliberate loosening**, not a hardening,
    and worth naming rather than folding into the line above. Parsing the
    `Cookie` header now uses a new `relaxedCookieNameRegEx`
    (`/^[!#-:<>-[\]-~]+$/`) instead of the strict RFC 6265 token rule, so names
    other producers emit in the wild, such as `paraglide:lang`, are accepted
    (honojs/hono#3189). The strict rule is retained for `serialize()`, that is,
    for producing cookies. A cookie name that this gateway would previously have
    dropped can now be parsed, which is a real behaviour change; it is not
    reachable here because the cookie helper is part of the Hono application
    layer, which is never constructed (see the corrections above).
  - `src/jsx/hooks/index.ts` (+19/-11): `useSyncExternalStore` reworked to swap
    subscriptions at effect flush rather than during render, closing a window
    with no subscription when `subscribe` changes, and to return a snapshot
    computed per render instead of `useState`-held state. This is the whole of
    this file's change and is unrelated to the `memo()` advisory fix, which is
    in `jsx/base.ts`. Unreachable here (no JSX), but it is a behaviour change
    and the first draft did not mention it at all.

  **No new network, filesystem, or process capability surface.**
- provenance: published by GitHub Actions under npm trusted publishing
  (`oidcConfigId oidc:4f58518f-c773-4172-885e-5ea4bad8c637`, approver
  `yusukebe`), carrying a SLSA v1 provenance attestation. Verified from the
  attestation bundle that the subject is `pkg:npm/hono@4.12.34`, the builder is
  `https://github.com/actions/runner/github-hosted`, and the source is
  `git+https://github.com/honojs/hono@refs/tags/v4.12.34` at commit
  `734755ace341607628219ea1dd8ca17f01bf1a5c` via `.github/workflows/release.yml`.
  Maintainer unchanged (sole maintainer `yusukebe`), repository unchanged,
  license unchanged (MIT).
- pulled in by: `@modelcontextprotocol/sdk@1.29.0` (declares `hono ^4.11.4`)
  directly and via `@hono/node-server@2.0.11`'s peer (`hono ^4`). Prod. `4.12.34`
  satisfies both, so this does **not** cross a parent range and
  `EXPECTED_TREE_PROBLEMS` in `scripts/check-consumer-tree.mjs` is deliberately
  unchanged.

## upgrade decision

- safe-to-upgrade: YES
- rationale: In-minor patch roll-forward (4.12.31 -> 4.12.34) clearing four live
  advisories, none of which touches this gateway's usage surface (the
  `getRequestListener` path only). Same sole maintainer, same repository, and
  now with verified SLSA provenance tying the tarball to the tagged commit.
  Applied by converting the existing override from the `^4.12.27` caret to an
  **exact `4.12.34`**: at the new fix line a caret resolves to the 4.13.x head,
  which is a minor bump this advisory does not require. The
  `release-security-audit.sh` hono floor is raised in lock-step
  `[4,12,27] -> [4,12,34]`; that tripwire reads the lockfile rather than the
  override string, so it keeps working across the caret-to-exact change.

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
