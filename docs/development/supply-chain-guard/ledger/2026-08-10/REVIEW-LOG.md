# review log, 2026-08-10 ledger change

Seven rounds against Codex, Grok and Mistral through the `gtwy` stdio surface.
Kept because the rounds are more instructive than the outcome: **the versions
being adopted were never contested by any reviewer in any round.** Every finding
was about the accuracy of the contracts or the correctness of a helper script,
and one of them turned into the most valuable result of the exercise.

## What each round found

**Round 1.** Grok and Mistral approved. Codex returned CHANGES_REQUIRED on two
false claims in the hono contract: that the gateway imports no hono helper at
all (it loads `hono/ws` via `@hono/node-server`), and that the
`Object.create(null)` parsing change is on a path this gateway exercises (no
`Hono` app or `HonoRequest` is ever constructed). Both verified, both real.

**Round 2.** Codex found five more: `memo()` attributed to the wrong file, a
fabricated claim about omitted README changes, an incomplete changelog on all
three packages, a staleness check in `refresh-baseline.mjs` that ignored two of
five fields, and a non-atomic write. Grok found that my *correction* to round 1
was itself wrong: it attributed `hono/utils/mime` to `dist/index.mjs`, when that
file's only hono import is `hono/ws` and `utils/mime` lives in the separate
`serve-static.mjs`. Grok also caught that the script would write a `license`
field the baseline has never carried, rewriting all 94 instances.

Mistral approved this round, and its approval endorsed the `hono/utils/mime`
error rather than catching it. It acknowledged that in round 3. That is the
cleanest illustration in this log of why agreement is the weakest signal.

**Round 3.** Grok and Mistral approved. Codex found four more, including that
the ip-address changelog still omitted material changes and that my
consumer-impact claim was wrong: `express-rate-limit` gates `new Address6(ip)`
behind `net.isIPv6(ip)`, so the new leading-zero throw is unreachable, not
merely unlikely.

**Round 4.** Codex insisted the authoritative evidence must be the published npm
tarball rather than a tag-to-tag compare. That instinct is what produced the
finding below.

**Round 5.** I published a refutation of Codex's round-3 list, claiming most of
it was not in the release. **The refutation was wrong.** It rested on
`grep -E '^[+-].*(isTeredo|is6to4|isDocumentation)'`, which cannot work: each
migration is a change inside a method body, so the method name only ever appears
on an unchanged context line. Asserting a negative from a search without first
checking the search could return a positive, which is the same error as the
round-1 hono claim.

**Round 6.** Grok and Mistral approved. Codex found the divergence account
incomplete, and it was: three of five files, not one, and the third carries
security weight.

**Round 7.** Grok and Mistral approved. Codex found one remaining gap, the
v4-in-v6 subnet propagation delta, which was verified and added.

## The finding

Chasing round 4 established that **the published `ip-address@10.2.0` artifact
does not match its own git tag.** Comparing each shipped `dist/*.js.map`
`sourcesContent` against the file at the tag, three of five source files
disagree: `src/ipv4.ts`, `src/ipv6.ts` and `src/v6/constants.ts`. For 10.3.1
they all match.

The one with teeth is `src/v6/constants.ts`. The URL regexes were hardened at
tag v10.2.0 and the hardening never reached the artifact:

    tag v10.2.0      RE_URL = /^(?:\[([0-9a-f:.]+)\]|([0-9a-f:.]+))(?:[/?#].*)?$/i
    shipped 10.2.0   RE_URL = /^\[{0,1}([0-9a-f:]+)\]{0,1}/

Grok demonstrated the consequence live: on shipped 10.2.0,
`http://evil.example/[::1]:80` yields address `::1` port 80, and
`http://[::ffff:127.0.0.1]/admin` mis-captures as `::ffff:127`; 10.3.1 fails
closed on both. Grok also noted the registry's own `gitHead` for 10.2.0
(`80fccaae`) carries the tagged, hardened source, so even the commit pointer
recorded alongside the artifact disagrees with it.

None of this is a named advisory and none of it is reachable from this gateway,
which never calls `fromURL`. It matters because it is invisible to any review
that reads only the tag diff, and because it changes what adopting 10.3.1 means:
not just three advisories cleared, but the first ip-address artifact in this
closure whose contents match the source it claims to be built from. The move to
OIDC trusted publishing with SLSA provenance is the mechanism that closed it.

## Process notes worth keeping

- **Mistral returned empty responses on every tool-using prompt** until
  `permissionMode: "auto-approve"` was used. `accept-edits` and the default both
  completed with exit 0 and zero bytes: not an error, not a refusal, nothing.
  Diagnosed by bisecting the prompt, since a pure-text prompt answered fine.
  Because `auto-approve` is more permissive than a review needs, the working
  tree was hashed before and after every Mistral run and compared; no run
  modified anything.
- **The gateway's own review-integrity guard flagged one prompt** for tool
  suppression (score 4), because it told Codex not to invoke the repository's
  nested multi-LLM tools. That was scope control against recursive review
  spawning rather than an attempt to weaken the review, and later prompts scoped
  positively instead. Recorded rather than ignored, since the guard was doing
  its job.
- **Codex dissented in all seven rounds it ran and was substantively right in
  every one**, including twice where a contract asserted the opposite. It is
  also slow and expensive here, with runs of nine to seventeen minutes and up to
  7M input tokens. Both facts are worth planning around.
