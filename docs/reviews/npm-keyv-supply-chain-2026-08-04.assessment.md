# keyv/cacheable npm compromise: incident closure and hardening plan

Date: 2026-08-05. Restructured 2026-08-08.
Status: **incident CLOSED. Mitigation plan CUT and rescoped.**

## Status

**The incident is closed: no identified compromise of this host, on good direct
evidence.** The gateway repository's lockfile contained none of the seed
versions, `npm ci` retained the older tree, and none of the known artefacts were
present. That is not proof of a negative, and the cache-state and temporary-file
limits on the evidence are recorded in section 1. It is enough to conclude that
no emergency rebuild and no blanket credential rotation are warranted.

**The mitigation plan that grew out of it has been cut to roughly a fifth of its
former size.** Eight rounds of adversarial review made every local fact in it
sharper while leaving its shape unexamined. The shape was wrong. "Enumerate every
launcher on the host, pin each one" cannot converge, and this document supplied
the proof against itself:

| Property an enumerate-and-pin programme needs | What eight rounds showed |
|---|---|
| A closed set of launch surfaces | Project `.mcp.json` went 2 → 9 → 13 → 26 across four searches. A capability sweep found 136 manifests and 106 command fields. |
| Stable ownership of those surfaces | Claude's marketplace auto-update **reverts** a one-time pin. Review itself mutated the host by starting a client. |
| One control plane | An npm `.bin` root cannot hold Docker digests, git-sourced `uvx` commits, Bun lockfiles or a `pip install --upgrade` startup hook. |
| A stop condition | None exists. Latent definitions activate on ordinary user action, with no config edit. |

That is not an incomplete enumeration awaiting a ninth round. It is an open,
multi-owner, self-rewriting execution surface being treated as a finite
checklist.

Worse, it was a priority inversion. The sharpest observation in the *original*
assessment was a composition, not a version: unpinned registry code running in a
process that already holds live credentials. The plan then expanded sideways into
launcher taxonomy while that composition stayed live, and while a daily timer
kept installing the orchestration binary itself from npm `latest`.

**What replaces it** is in section 3: close the credential-bearing always-on
paths, set install defaults, separate publishing authority from repository
execution, detect drift, and explicitly accept the rest. It is a small plan and
it buys most of the available risk reduction.

The superseded plan is retained in Appendix A because its enumeration is good
evidence even though it was a bad strategy.

## Scope of this document

Three things:

1. My **review of the incident assessment** written for this host. The original
   is reproduced in full in section 1 so it can be graded directly rather than
   through my summary. I did not write it.
2. A **threat model** for this host (section 2). Neither the original assessment
   nor eight revisions of my plan ever contained one, which is most of why the
   plan drifted into inventory work.
3. The **rescoped hardening plan** (section 3), its accepted residuals
   (section 4), and what was cut (section 5).

## 1. The original assessment, as written

> **The incident.** August 4, 2026. Attacker compromised the GitHub account of
> jaredwray, maintainer of the keyv/cacheable family, pushed payload files
> directly to main, and cut releases. The legitimate GitHub Actions trusted-
> publisher workflow then built, signed, and published them, so the poisoned
> tarballs carry valid npm provenance and SLSA attestation. Signing verified
> nothing, because the source was compromised upstream of the build.
>
> 11 seed packages, then worm self-propagation via stolen npm tokens. Counts
> differ by vendor while it spreads: Endor 373 packages, Snyk 11 seeds, Wiz 400+,
> Aikido 868 across 1,381 versions, JFrog 428+. Combined reach >2B monthly
> installs. Payload is a Shai-Hulud variant (JFrog/Wiz; BleepingComputer calls it
> "ChainDrop"), delivered by a preinstall hook that downloads Bun and runs a
> 728 KB harvester (Math_Symbol.js, or math_init.js for second-generation
> infections).
>
> Malicious seed versions: keyv@6.0.0, flat-cache@6.1.24, file-entry-cache@11.1.6,
> cacheable-request@13.0.20, cacheable@2.5.1, cache-manager@7.2.10,
> @cacheable/{memory@2.2.1,utils@2.5.1,node-cache@3.1.2,net@2.1.1}, ecto@5.0.1.
>
> **Our position: clean, on direct evidence.**
>
> | Check | Result |
> |---|---|
> | Lockfile vs all 11 seed versions | 3 family packages present (keyv@4.5.4, flat-cache@4.0.1, file-entry-cache@8.0.0). Zero matches |
> | npm cache index, ever | cacheable-request@13.0.19 (the clean rollback), never 13.0.20. No malicious tarball ever fetched |
> | Math_Symbol.js / math_init.js / setup.mjs | None anywhere |
> | /tmp/bun-dl-*, bun binary, ~/.bun | Absent |
> | preinstall hooks in installed tree | None |
> | "Shai-Hulud" string on disk | None |
> | Planted .claude / .vscode hook files | None; no git activity on those paths |
>
> Three things kept us out of it, and only one was luck:
> 1. `npm ci`, not `npm install`. CI installs lockfile-exact, so even a run inside
>    the malicious window would have pulled our pinned clean versions.
> 2. node_modules untouched since 2026-07-08, four weeks before the attack.
> 3. Observed npm activity resumed 2026-08-04T23:19Z, ~11 hours after npm rolled
>    latest back at ~12:10 UTC.
>
> **The one thing I'd actually change.** Every MCP server on this host launches
> via `npx --yes`, which resolves latest at every start:
> `npm exec --yes -- exa-mcp-server tools=...` and
> `npm exec --yes -- mcp-remote https://api.ref.tools/mcp?apiKey=ref-23fc...`
> That is an unpinned install executing on every session start, with provider
> credentials in the environment, precisely the target profile. It was fine today
> because neither package depends on the keyv family (the only npx trees carrying
> it are verdaccio, hugo-bin, wrangler, all resolved in July). But the pattern
> gives no lockfile and no integrity floor.
>
> Two caveats on my own evidence: npm keeps only 10 debug logs, so "no activity in
> the window" is inference, not proof; the cache-index result is the durable
> evidence, and it is clean. And that ref.tools API key is sitting in plaintext in
> npm debug logs under ~/.npm/_logs/.
>
> Suggested: pin the MCP servers to exact versions instead of --yes latest.

## 1b. My review of the original assessment

### What I verified and agree with

The central claim is correct and is the most important thing in the document.
StepSecurity states it independently: "Provenance proves which commit was built.
It cannot prove the commit was authorized."

**Scoped in rev 3.** Every malicious publish **in the 11-package seed wave** came
from npm's OIDC trusted-publisher identity (`npm-oidc-no-reply@github.com`) with
no long-lived token involved, and the SLSA attestation for `keyv@6.0.0`
faithfully records the attacker's commit `f97eabc`. Rev 1 and rev 2 said "every
malicious publish in this wave", full stop, which contradicted this document's own
later section on the worm phase. The **self-propagation generations used stolen
npm tokens**, and some of those versions carried no provenance at all. Both
statements are needed; only the seed one supports the "signing verified nothing"
conclusion.

For the seeds, this inverts the axios compromise of March 2026, where *missing*
`trustedPublisher` metadata was the detection signal. That signal does not exist
for the seeds. It does exist, partially, for the token-published generations.

Sources consulted: Wiz (2026-08-04), Snyk (2026-08-04), StepSecurity ChainDrop
analysis, JFrog Security Research, and the CSA research note on the May
"Mini Shai-Hulud" precedent.

The evidence table is the right shape. Ranking the npm cache index above the
debug-log inference is correct, and the author flagged that limitation without
being asked.

### Four things I would add or correct

**A. `ignore-scripts` is missing, and for this attack class it is stronger than
pinning.** The payload is delivered by a `preinstall` hook. `ignore-scripts=true`
neutralises it even if the malicious tarball is installed, which is the case
pinning cannot help with (your pin being the compromised version). It breaks
native-build packages (esbuild, sharp, node-gyp consumers, Playwright, Cypress),
so it needs an allowlist plus an explicit `npm rebuild` step.

**B. Pinning `npx` versions is necessary but not sufficient.** `npx pkg@1.2.3`
pins only the top-level package. Its dependency tree is resolved from that
package's own ranges at first materialisation, and lifecycle scripts in that tree
execute then. A compromised transitive dependency lands regardless of the pin. The
complete fix is a local install directory with `--save-exact`, a committed
lockfile, `npm ci`, and MCP config pointing at the resulting binary.

*Corrected in rev 3:* rev 1 and rev 2 both said `npx` gives "no lockfile and no
integrity floor", repeating the original assessment. **That is false.** npm hashes
the requested package set into a persistent `~/.npm/_npx/<hash>/` directory and
writes a real `package-lock.json` there with SHA-512 integrity entries; an exact
version already present is reused without re-resolution. Verified directly on this
host: the `_npx` directories contain lockfiles, one of which carries 131
`"integrity"` entries.

The actual deficiency is narrower and should be stated precisely: **under default
lockfile configuration** there is no pre-existing, consumer-controlled, reviewable
lockfile before first materialisation. The integrity floor exists, but it is
created from whatever the registry served at first use, rather than from something
a human approved. Cache eviction triggers a fresh materialisation under whatever
is current then.

*Qualified in rev 5:* the lockfile is not guaranteed. `libnpmexec` passes npm's
flat options into Arborist before `reify`, so `package-lock=false` suppresses the
write and a successful materialisation can leave no lockfile at all. Measured on
this host: 44 `_npx` hash directories, 43 with a `package-lock.json`, one empty
and lockless (consistent with a failed or cancelled materialisation).

*Tightened in rev 2:* rev 1 said the tree "resolves fresh at every start" and
that scripts "still execute" on every start. That overstates it. npm reuses the
`~/.npm/_npx/` cache for a given package set, so resolution and script execution
happen on cache miss or first materialisation, not on every invocation. The
security consequence is unchanged, because one materialisation inside the
malicious window is sufficient, but the frequency claim should not be repeated as
written.

**C. `trustPolicy: no-downgrade` would not have caught the seed wave**, and it is
the control people reach for first. It detects provenance *regression*, the
signature of a stolen-token publish from an attacker's own machine. The 11 seed
versions carried valid trusted-publisher provenance, so there was no regression
to detect.

*Nuanced in rev 2:* this does not mean the setting is useless here. The seeds were
OIDC-built, but the **worm self-propagation phase used stolen npm tokens**. For a
package that previously published with provenance, a token-published successor is
exactly the regression `no-downgrade` exists to catch. So the correct statement is
narrower than rev 1's: it would not have stopped the seeds, and may well have
stopped later generations. Do not discard it; do not treat it as covering the
seed class.

**D. The "npm activity resumed 2026-08-04T23:19Z" observation may be
self-inflicted.** That timestamp is within seconds of a cross-LLM review dispatch
in the same session, and the exa MCP server was being invoked repeatedly
throughout. Before treating it as anomalous, reconcile it against that session's
tool-call times. If it is attributable, it strengthens rather than weakens the
`npx --yes` finding: it is direct evidence of unpinned execution firing on
session activity with credentials in the environment.

### One item to promote

The ref.tools API key is passed as a URL query parameter. That places it in the
process argv (readable via `ps` by any local user), in `~/.npm/_logs/`, and
plausibly in shell history. This should be an action item (rotate, move to an env
var or header), not a closing caveat, independent of this incident.

### Errors in the original that I failed to catch (added rev 2, from review)

**E. ">2B monthly installs" overstates unique exposure.** keyv, flat-cache, and
file-entry-cache each sit around 570-620M last-month downloads, but they overlap
heavily: flat-cache depends on keyv, and file-entry-cache depends on flat-cache.
Summing them counts the same install repeatedly. The reach is large; the specific
figure is not additive.

**F. The rollback was partial, not complete.** At 11:16 UTC only 3 of the 11 seeds
had been yanked and 8 were still `latest`. The ~12:10 figure describes a partial
rollback, with some versions remaining live afterwards. Rev 1 flagged the time as
unverified but accepted the framing of a single clean rollback event.

**G. Seed provenance and worm provenance are different stories.** The original
implies one trusted-publisher narrative for the whole wave. The seeds were
OIDC-built with valid attestations; the propagation phase used stolen npm tokens.
Conflating them is what makes `trustPolicy` look useless rather than partial (see
point C).

**H. "No malicious tarball ever fetched" is weaker evidence than presented.**
The npm cache index is the original's strongest artefact, and it is good evidence,
but it cannot prove a negative. Cache cleaning, entry eviction, or use of an
alternate cache location would each remove the trace. State it as "no evidence of
a malicious fetch in the current cache index", not as proof one never happened.

**I. Absence of `/tmp/bun-dl-*` is weak negative evidence.** The loader cleans up
its temporary artefacts, so absence is expected even after a successful run. It
belongs in the table, but it should not carry weight.

**J. The original's claim that `npx` provides no lockfile or integrity data is
false**, for the reason given in point B. I repeated it in rev 1 and rev 2 instead
of catching it.

### What I could not verify in rev 1, now resolved

The ~12:10 UTC rollback time. Independent writeups place `keyv@6.0.0` publication
at **09:35 UTC** and a partial `latest` rollback at **~12:10 UTC**, giving a
publish-to-partial-rollback interval of roughly **2.5 hours**.

Codex puts the interval more precisely: 2h35m from the first seed publish, or
1h42m from the last. Rev 1's phrasing that three days "would not have been close"
should be read as margin, not as a claim that one day was marginal.

**Scoped in rev 3:** a 1-day floor is well-supported **for the 11 seed packages**.
No source consulted establishes a full-remediation timestamp for every propagated
package, and some malicious versions remained available after 12:10. The claim
should not be extended to the whole worm without that evidence.


## 2. Threat model

This is for **this host**, a single-user multi-agent developer workstation that
also publishes an npm package. It is not a model of the npm ecosystem.

### Assets

Cloud and SaaS API keys held by MCP wrappers (Exa, ref.tools) and by agent
environments; the Azure identity those wrappers use to read Key Vault; npm and
GitHub tokens available to agents and to CI; SSH keys and cloud credentials
readable by the user; provider session state; and the integrity of
`llm-cli-gateway` itself, which this host both runs globally and publishes.

### Adversaries, in likelihood order

1. **Opportunistic registry worm.** Compromise a popular package, ship a
   harvester in a lifecycle script, exploit a short window before detection.
   This incident.
2. **Maintainer or CI takeover of a package we actually run**: an MCP server, a
   provider CLI, a gateway dependency. Longer dwell time is possible, so age
   gates do not help.
3. **Compromised marketplace or plugin** that rewrites launchers or ships an
   unpinned `npx`.
4. **Compromise of this repository's own source or publishing identity**, which
   propagates to every consumer and to this host's own auto-upgrade.

A human or agent with a local shell is **not** the primary adversary. Its ability
to override npm settings matters only because code that has already executed gets
approximately the same capability.

### Objective

Placing a bad package on disk is not the loss. The loss is the chain that
follows: execute under the workstation or CI identity, collect credentials and
publish authority, exfiltrate, persist, propagate.

### The realistic path on this host

```
[A] Session starts an agent or MCP client
 -> [B] A launcher runs unpinned registry code
        wrapper: npx -y exa-mcp-server, with EXA_API_KEY already exported
        wrapper: npx -y mcp-remote "https://.../?apiKey=<secret>"  (argv)
        plugin:  npx @playwright/mcp@latest
 -> [C] Cache miss materialises a version inside the malicious window
 -> [D] Lifecycle script runs, or the package's own entrypoint runs later
 -> [E] Harvester reads env, argv, files, tokens; may fetch stage two
 -> [F] Exfiltration, worm propagation, or persistence
```

Two further paths, both live:

```
[A2] Dependency bump enters the lockfile via human or bot -> [D]..[F]
     on a developer machine or in CI holding release credentials

[A3] gateway-autoupgrade.timer -> npm install -g llm-cli-gateway@latest
     -> a compromised publish of *this* package
     -> loaded by every subsequent stdio session
```

Path A3 deserves emphasis. The timer is enabled and active, and
`scripts/host-upgrade.sh:42` defaults `GATEWAY_AUTOUPGRADE_MODE` to `apply`. It
resolves a version from npm, installs it with scripts enabled, and validates only
the version the package reports about itself, which a malicious package can
report correctly after it has already run. This is the same pattern the original
assessment flagged for `npx`, on a schedule, for a binary more privileged than
any MCP server. It was filed as a residual risk under population 3 while idle
GitNexus clones were being enumerated.

### What each control actually interrupts

| Control | Interrupts | Does not interrupt |
|---|---|---|
| Committed lockfile plus `npm ci` | Unexpected version selection in that tree. **The decisive control in this incident.** | Anything outside a locked tree |
| `min-release-age` | Step C for npm installs that honour the config | Overrides, lockfile-driven installs, non-npm paths, long-dwell compromise, already-cached trees |
| `ignore-scripts` / strict allow-scripts | Step D for lifecycle payloads | Malicious code in the package's own entrypoint, which is what an MCP server *is* |
| Exact pinned local root | Steps B and C for launchers that are repointed **and stay repointed** | Marketplace-reverted manifests, non-npm classes, an agent typing `npx` |
| Disabling marketplace auto-update | Reversion of pins | The authority the resulting process holds |
| Provenance, integrity hashes, `trustPolicy` | Origin and bit identity; token-published worm generations | A valid-provenance build of compromised source, which is exactly the seed wave |
| Credential and filesystem scoping | Steps E and F, the attacker's actual objective | Initial execution |
| Detection | Nothing | Nothing, but it is how you learn prevention failed |
| Enumeration and residual-risk registers | **Nothing.** They are evidence and governance, not controls | |

The last row is the one the old plan kept mistaking for security work.

### The security objective, stated properly

Not "no unpinned launcher exists anywhere on disk". Instead:

> No always-on path runs registry-resolved code while holding high-value
> secrets; install defaults reject young and script-bearing packages for
> accidental installs; publishing authority is separated from repository
> execution; and drift is detected and recoverable.

## 3. The plan

### P0: live exposure, do these or admit nothing was mitigated

**P0.1 Reduce the durable leak of the ref.tools key, then rotate.**
`~/.local/bin/ref-tools-mcp-from-azure` passes the key as a URL query parameter
to `mcp-remote`, which puts it in argv, in the process table, and in any npm
debug log that records the command line.

**The obvious fix does not work.** `mcp-remote`'s `--header` flag takes a literal
value from argv and supports no environment-variable indirection: it parses
`args[i + 1]` against `/^([A-Za-z0-9_-]+):\s*(.*)$/` and uses the captured text
directly (`dist/chunk-65X3S4HB.js`, `parseCommandLineArgs`). Moving the key from
the URL to a header therefore moves it from one argv position to another and
changes nothing. This was checked rather than assumed.

**Header injection is not available either.** ref.tools authenticates *only* by
query parameter. Tested against the live endpoint on 2026-08-08:

| Auth presented | HTTP |
|---|---|
| `?apiKey=<key>` | **200** |
| `Authorization: Bearer <key>` | 401 |
| `x-api-key: <key>` | 401 |
| `X-Ref-Api-Key: <key>` | 400 |
| none (control) | 401 |

So the key must reach the URL. The fix is therefore not "inject a header", which
is what an earlier revision of this section said twice: it is to build the URL
**in process** from an environment variable, so it never becomes a command-line
argument at all.

**DONE** (2026-08-08). `~/.mcp-servers/bin/ref-tools-stdio.mjs` takes the key
from `REF_TOOLS_API_KEY`, deletes it from the environment so no child inherits
it, sets `process.argv` (a JS array, not the OS command line) before importing
`mcp-remote/dist/proxy.js`, which parses `process.argv.slice(2)` at import time,
and wraps `process.stderr.write` to redact the key. `stdout` is untouched because
it carries the MCP protocol.

Verified: handshake succeeds and both `ref_*` tools list; the previously leaking
stderr line now reads `Connecting to remote server: https://api.ref.tools/mcp?apiKey=<REDACTED>`;
and a scan of `/proc/<pid>/cmdline` for every process in the shim tree, plus
every `node` process on the host, finds the key in none of them.

Reducing npm log retention (`npm config set logs-max 0`, applied) narrows one
capture path but was never a fix, because argv is captured by more than npm.
"Accept and monitor" is not available under the standing rule.

The Exa wrapper needed no shim: it passes `EXA_API_KEY` through the environment,
which the server reads natively, so it was already compliant. It was repointed at
the pinned root under P0.2.

Rotate the key, and check the issuer's logs for use of the old one.

**Verify a rotation actually rotated.** On 2026-08-08 a rotation was reported,
applied and tested green (HTTP 200 MCP handshake against Ref 3.0.0, with a
garbage key returning 401 as a negative control), and was still not a rotation:
the new Key Vault version was byte-identical to the previous one. Compare the two
versions by hash, never by printing them:

```bash
NEW="$(az keyvault secret show --vault-name "$V" --name "$N" --query value -o tsv)"
OLD="$(az keyvault secret show --id "https://$V.vault.azure.net/secrets/$N/<prev-version>" --query value -o tsv)"
[ "$NEW" = "$OLD" ] && echo "NOT ROTATED" || echo "rotated"
```

A new version identifier and a fresh `updated` timestamp prove only that a write
happened. They say nothing about the value.

### Standing rule: secrets never touch disk

A secret lives in the vault it came from (Azure Key Vault, or 1Password) and
exists nowhere else except in the memory of the process using it, for as long as
that process needs it. No file, no `/tmp`, no `/dev/shm`, no env file, no cache,
encrypted or not, not even as a temporary step.

This is a constraint on the plan, not an aspiration, and it rules out controls
that would otherwise look reasonable. Two capture paths found on this host make
the reason concrete, and neither involved anyone deliberately storing a key:

- **Agent session transcripts.** `~/.codex/sessions/**/*.jsonl` and
  `~/.claude/projects/**/*.jsonl` had captured a live API key going back to
  2026-05-08, some of them mode `0644`. Anything an agent prints, and any argv an
  agent records, becomes a durable plaintext file that outlives every process
  involved.
- **npm debug logs**, mode `0644`, which capture full command lines including URL
  query parameters. `~/.npm/_logs/` currently holds no matching entry, but only
  because it had rotated.

Practical consequences: fetch at point of use into a variable or process
environment rather than a file; where a tool demands a file path, give it
`/dev/stdin` or a process substitution; never place a secret in argv, since
`/proc` is world-readable and argv is what transcripts and debug logs capture;
and verify secrets by length, hash prefix or an authenticated request with a
negative control, never by echoing them.

**P0.2 Replace the credential-bearing wrappers with an owned pin root.** **DONE**
(2026-08-08). `~/.mcp-servers/` (mode `0700`) holds exact pins with
`--save-exact`, a lockfile carrying 177 integrity hashes, installed with
`--ignore-scripts`: `exa-mcp-server@3.4.0`, `mcp-remote@0.1.38`,
`@playwright/mcp@0.0.78`. Both wrappers now exec from that root and neither
mentions `npx`. Handshakes verified end to end through the real launch path
before and after switching.

Note that binary names are not always the obvious basename: `@playwright/mcp`
installs `playwright-mcp`.

**The age gate proved itself during this install.** `@playwright/mcp@0.0.79` was
refused outright:

```
npm error code ETARGET
npm error notarget No matching version found for @playwright/mcp@0.0.79
                   with a date before 8/5/2026, 8:36:01 AM.
```

That is P1.1 working at install time rather than merely being configured, and the
same run confirmed `logs-max=0` ("Log files were not written due to the config
logs-max=0"). The pin went to `0.0.78`, the newest **stable** release older than
the gate; note that the newest packages clearing the gate were alpha builds, so
version selection has to filter prereleases rather than take the newest eligible.

The unit of work is an **owned launch path**, not an edited cache manifest. This
covers both Claude and Codex for those servers, because both go through the
wrappers.

**P0.3 Take Playwright off the marketplace launch path.** **DONE** (2026-08-08).
The plugin was MCP-only (0 skills, 0 agents, 0 hooks, 1 server), so it was
disabled with `claude plugin disable playwright@claude-plugins-official` and the
pinned binary registered directly at user scope. Editing the cached manifest was
never a fix, because the updater reverts it and gives no signal when it does, and
this plugin's `lastUpdated` of `2026-08-07T21:36:20Z` is precisely the refresh
that the round-8 review triggered by accident.

Two permission entries had to move from `mcp__plugin_playwright_playwright__*` to
`mcp__playwright__*`, since deregistering a plugin changes the tool namespace.

Result: every active Claude MCP launcher now resolves to a fixed path or an HTTPS
URL, and none performs package resolution at session start.

**P0.4 Put `gateway-autoupgrade` in notify-only mode.** **DONE** (drop-in at `~/.config/systemd/user/gateway-autoupgrade.service.d/10-notify-only.conf`, 2026-08-08; remove it and `daemon-reload` to revert). Set
`GATEWAY_AUTOUPGRADE_MODE=notify`, or require an explicit reviewed version.
Silent `@latest` apply for the orchestration binary is the least defensible thing
on this host.

### P1: install defaults, cheap and broad, no inventory required

**P1.1 Set `min-release-age` to 3 days as a user-global default.** **DONE**
(`~/.npmrc`, 2026-08-08). It filters the smash-and-grab class for accidental
installs, which is precisely the class this incident belonged to. Any shell can
override it, because npm's precedence puts CLI and environment above user config.
It is a default, not an authority.

**Verification note, because this looks broken and is not.** On npm 11.12.1,
`npm config get min-release-age` returns `null` and `npm config ls` does not list
the key, which reads exactly like an unsupported setting silently ignored. It is
supported. npm implements it by deriving a rolling `before` cutoff, and that is
what surfaces:

```
now      = 2026-08-07T21:50:42Z
age=1  -> before = Fri Aug 07 2026 07:50:42 GMT+1000
age=3  -> before = Wed Aug 05 2026 07:50:42 GMT+1000
age=7  -> before = Sat Aug 01 2026 07:50:42 GMT+1000
```

The cutoff tracks the setting and advances on every invocation. Do not "fix" a
`null` here by removing the line.

**P1.2** Upgrade npm from 11.12.1 to v12 for its safer script and non-registry
defaults. Not a prerequisite for P1.1, contrary to a first reading of the
evidence above.

**P1.3** Do **not** add `ignore-scripts=true` to this repository's `.npmrc`. It
is a trap: it silently neutralises the bare `npm rebuild better-sqlite3` at
`.github/workflows/npm-publish.yml:105` and `release-tag-publish.yml:128`, and it
breaks Claude Code installs that need a native build. The repository already has
a better control, described next.

### P1.5: the CI and publisher boundary

This is the most serious path the old plan omitted, and it recreates the
incident's central trust failure inside our own pipeline.

**P1.5.1 Promote the existing strict allowlist into normal CI.** `package.json:166`
already declares a version-specific lifecycle allowlist
(`better-sqlite3@12.11.1: true`, `fsevents: false`) and `ci.yml:99` already
enforces it with `npx --yes npm@12.0.1 ci --strict-allow-scripts`. But the
ordinary jobs at `ci.yml:38` and `ci.yml:61` still run a script-enabled `npm ci`
on persistent self-hosted runners, **before** the audit meant to inspect what
they installed. Promote the strict form to those jobs and build the one approved
native dependency explicitly. This is strictly better than the blunt `.npmrc`
proposal and costs no new machinery.

**P1.5.2 Run the frozen supply-chain checks before `npm ci`, not after.** The
production-closure ledger and drift scan (`scripts/supply-chain/dep-drift-scan.mjs`,
invoked from `release-security-audit.sh`) currently gate a tree that has already
executed.

**P1.5.3 Split build from publish.** `npm-publish.yml` grants `id-token: write`
at line 46, checks out the repository at line 48, and then runs repository
controlled build, test, audit and packaging code inside the identity authorised
to publish. Compromised source therefore produces a valid-provenance package,
which is exactly what happened to the packages in this incident. The safer shape:
build, test, scan and produce a digest-addressed tarball in an unprivileged job
with no publishing identity; record the source SHA and artefact digest; require
a protected tag and environment approval; then have a minimal publish job
download that exact artefact and run only
`npm publish --ignore-scripts <tarball>` without checking out the repository.

The existing shrinkwrap discipline, production-closure ledger, security audit,
SHA-pinned actions and OIDC trusted publishing are all worth keeping. None of
them establishes that a source change was authorised.

**P1.5.4 Move dependency-changing PR jobs off persistent shared runners**, or run
them in disposable credential-free environments. `SECURITY.md:52` already
acknowledges that provider authentication tokens flow through spawned child
environments and are not covered by automated CI.

**APPLIED 2026-08-10, in the idempotent form; the ephemeral form is implemented
but dormant.** This is a runner-topology change, not a workflow edit: the
internal repo pins jobs to the self-hosted `workhorse3` pool while the public
mirror already uses `ubuntu-latest`.

The exposure named above was cross-job state, so that is what was removed.
`workhorse3` now runs the gateway runner under a wrapper that deletes `_work`
and `_diag` on every service start, relocates `HOME` and every package-manager
cache (npm, yarn, pnpm, pip, Go module and build, cargo) inside `_work` so a
single delete reaches all of them, and repeats the workspace wipe through
`ACTIONS_RUNNER_HOOK_JOB_STARTED` and `ACTIONS_RUNNER_HOOK_JOB_COMPLETED`. A
malicious dependency update no longer executes against anything a previous job
left behind. The unit additionally masks `/home`, which is where the Azure CLI
token, the `gh` PAT and every agent transcript on that machine live, and gives
each job a private `/tmp`, which retires the shared-`/tmp` hazard that
`sast.yml:69` and `security.yml` both carry notes about.

One thing to be clear about, because it is easy to assume otherwise: on a
self-hosted runner `--ephemeral` does not clean the disk. It means one job per
registration and nothing more. The disk hygiene above is what actually clears
state. What ephemeral adds on top is that a job which compromises the runner
cannot hold the registration open to receive a second job.

That remaining increment is implemented and fails closed rather than being left
unwritten, but it is off. A just-in-time registration needs a credential holding
`administration:write` on the repository, `workhorse3` is bare metal with no
Azure managed identity, and so that credential could only reach a system service
by sitting on disk. That is forbidden by the standing rule above. The code path
takes its token from the stdout of `RUNNER_JIT_TOKEN_COMMAND` and refuses to
start if it is unset. Enable it when the host gains a vault-reachable identity.

Not done, and named rather than quietly skipped: the other seven runner
registrations on `workhorse3` remain on the old topology.

### P1.5 status: applied 2026-08-08

P1.5.1 to P1.5.3 are implemented and committed. What was verified, and how:

- **Strict script policy promoted** to `ci.yml` `build-and-test` and
  `pack-smoke-test`. Exactly two packages in the tree declare install scripts
  (`better-sqlite3@12.11.1`, `fsevents@2.3.3`), both covered by the allowlist,
  so the promotion cannot break the install. Confirmed by running the exact CI
  command against a copy of the manifest and lockfile: 290 packages, exit 0,
  `better_sqlite3.node` built.
- **The gate is real, not decorative.** Removing the `better-sqlite3` approval
  and re-running produced `npm error code ESTRICTALLOWSCRIPTS`, exit 1, naming
  the offending package. A newly introduced dependency that wants install-time
  code now fails the build instead of executing.
- **Supply-chain scan moved ahead of install** in both `ci.yml` jobs and the
  release build job. `--frozen` reads only the committed lockfile, imports
  nothing outside `node:` builtins and two local modules, needs no
  `node_modules`, and runs in ~0.12s, so ordering it first costs nothing.
- **Build split from publish.** `npm-publish.yml` now has a `build` job with
  `contents: read` only, and a `publish` job that is the sole holder of
  `id-token: write`. The publish job checks out nothing, runs no repository
  script, and takes one input: the tarball the build job packed, bound by a
  sha256 carried as a job output and re-checked after download. The former
  `.github/scripts/verify-npm-oidc.mjs` is removed and its check inlined, so the
  publishing identity executes no repository file at all.
- **Ratcheted in `scripts/release-site-contract.test.mjs`**, which now asserts
  the build job has no `id-token: write`, the publish job has no checkout, no
  `npm ci` and no `npm run`, and that the frozen scan precedes the install in
  both workflows. Comments are blanked before matching, because two of these
  assertions initially passed or failed on prose rather than on steps.

**Verified locally, not in CI, and here is why that distinction matters.**
Implementing P1.5.4 turned up that every one of the eight self-hosted runner
registrations on `workhorse3` had been failing `203/EXEC` at boot for as long as
the journal reaches back. The runner trees sit inside the Samba-exported
`/srv/repos` mount, so every file under them carries the SELinux type
`samba_share_t`; SELinux is enforcing on that host, and `init_t` may not execute
`samba_share_t`. `chcon` clears it until the next relabel, which is why the
gateway tree was moved to `/opt/actions-runners/gateway-1` under a persistent
`semanage fcontext` rule rather than patched in place.

The consequence for the bullets above: none of the P1.5.1 to P1.5.3 CI changes
had actually executed on the internal repository. Each was verified by running
the exact command locally, which is why those verifications hold, but "committed
and green" was never available to claim and is not claimed here.

**Not verifiable here, and the reason:** a real publish cannot be rehearsed
locally. The specific thing to watch on the next release is **provenance
attestation**, since npm now generates it while publishing a prebuilt tarball
from a job that did not build it. Validate with the `dry-run` dispatch input
before a live release; that path deliberately stayed in the build job, where it
needs no credentials.

### P2: detection and response, which is what makes an open set survivable

**P2.1 A drift check**, in `doctor` or a small user timer, that answers: which
launchers are enabled right now, what exact binary does each resolve to, does any
enabled path perform package resolution at start, did a marketplace refresh
change the answer, and did the global package set move. Alert on `@latest`,
`npx -y`, unpinned `uvx`, and `:tag` without a digest. The alerting must not
depend on the clients being monitored.

**P2.2 A one-page response playbook**: which keys to rotate and at which issuers,
how to freeze the auto-upgrade timers, how to wipe `~/.npm/_npx` and suspect
globals, how to reinstall from known-good lockfiles, and the threshold at which
local cleanup gives way to a rebuild. Deleting `_npx` is not recovery after
arbitrary same-user execution.

**P2.3 Notify on auto-upgrade application** for the gateway and sqry timers. The
timers already exist; use them as sensors.

### Definition of done

1. No always-on launcher holding secrets resolves from a registry at start.
2. Secrets are not on argv, and the ref.tools key has been rotated.
3. Install defaults reject young packages for casual installs.
4. Gateway upgrades require reviewed promotion rather than silent latest-apply.
5. Ordinary CI enforces the existing strict script allowlist before executing
   dependency code.
6. Publishing authority does not execute repository code.
7. Launcher drift raises an alert.
8. The response playbook exists and has been exercised once.
9. Everything else is named accepted risk with an owner and a review date.

## 4. Accepted residual risk

Owner: Werner. Review date: **2027-02-01**, or immediately on any trigger below.

| Accepted | Why | Trigger to revisit |
|---|---|---|
| Docker-launched MCP definitions unpinned | `docker` is not on PATH; the definitions cannot fire | Installing Docker, or enabling one of those plugins |
| Bun-launched definitions unpinned | `bun` is not on PATH | Installing Bun |
| git-sourced `uvx` definitions unpinned | `uvx` **is** on PATH, but Serena is not enabled | Enabling any `uvx`-launched server |
| The `pip install --upgrade` SessionStart hook | The owning plugin is disabled | Enabling that plugin |
| 26 project `.mcp.json`, 4 of them dirty with `npx -y gitnexus@latest` | Repository content risk for whoever opens those projects, not ambient host risk | Working in one of those repositories with secrets present |
| Any agent or human shell can install whatever it likes | Agents are user-equivalent by design; no cooperative default survives a shell | Only removable by sandboxing, which is out of scope here |
| Provider CLIs self-update through their own channels | Not centrally enforceable | A provider CLI compromise |
| Long-dwell compromise older than the age gate, and validly signed malicious source | No age or provenance control addresses either | Nothing; this is structural |
| MCP servers run with ambient user authority | Sandboxing each server is real work and not scheduled | A compromise, or capacity to do it properly |
| The revoked ref.tools key remains in 5836 files across ~20 GB of `~/.cache/agentfed-*` sandboxes, and in any copy outside `$HOME` that the timed-out scan never reached | The key is revoked and returns 401, so the copies are inert. Redacting caches is effort spent on a dead credential | Any *live* secret being found in an agentfed sandbox. These are full home-directory copies, so they capture whatever an agent run touched, not just this key |

Naming these is the point. A plan that claims to cover every launcher while
shipping one package manager's control invites an operator to believe the problem
is handled.

## 5. What was cut, and why

- **Exhaustive launcher enumeration as a delivery requirement.** Replaced by a
  named allowlist of services we actually run. The 136-manifest sweep becomes
  advisory inventory in Appendix A, not a backlog.
- **Population 3, the provider CLI age gate, as security work.** Eight rounds
  established it has no authoritative execution boundary: host shells, native
  self-updaters, `uv`, Homebrew and the gateway's own timer all bypass it. It
  survives at most as a one-line policy of not chasing same-day CLI releases.
- **Repointing dormant marketplace entries** that are not enabled.
- **Proactive Docker, Bun and `uvx` pinning** while those paths cannot fire.
- **Cleaning idle project `.mcp.json` clones** while the daily wrappers still ran
  `npx -y` with vault-fetched keys. That was theatre relative to the live path.
- **The repository `.npmrc` proposal**, which would have disarmed a release gate.
- **Further adversarial review rounds in blocker format.** Eight rounds of
  precision produced a sharper map of an unbounded set. That format cannot return
  "the strategy does not converge", because it is not a file:line defect.

An honest residual: even this smaller plan does not stop a determined agent with
a shell, nor a package compromise older than the age gate. On a single-user
multi-agent workstation that residual is structural. Enumeration does not buy it
down. Blast-radius reduction and rehearsed response do.

## Appendix A: the superseded mitigation plan, retained as evidence

The plan below is **not** the plan. It is kept because its enumeration of
launcher classes, its count table, and its durability finding are good evidence,
and because section 5 above is only meaningful next to what it cut. Its three
populations, its scope declarations and its residual-risk register are all
superseded by sections 3 and 4.

#### The framing

"Pin versus stay current" is a false trade. The control that dissolves it is a
**release-age cooldown**: refuse to install any version younger than N days. You
remain fully current, N days behind the wave. Compromised releases are typically
detected and yanked within hours, so a short delay filters the smash-and-grab
class at the install layer with no scanning and no monitoring.

This incident was detected and rolled back within hours. A one-day cooldown would
have been sufficient; three days would not have been close.

Support, as of 2026-08-05:

| Tool | Setting | Unit | Default |
|---|---|---|---|
| npm | `min-release-age` | days | off, available since CLI 11.10.0 (Feb 2026) |
| pnpm | `minimumReleaseAge` | minutes | 1440, default since pnpm 11 |
| Yarn Berry | `npmMinimalAgeGate` | duration | **`1d`, default since 4.12** |
| Bun | equivalent | seconds | off |

npm is the one that ships it off, and npm is what this host uses.

**Correction, rev 2.** Rev 1 gave the Yarn row as "3d, default since 4.10". That
was wrong on both the version and the default, and came from two secondary blog
posts rather than primary documentation. The official Yarn security page states:
"Yarn 4.12 introduced `npmMinimalAgeGate` ... The setting defaults to `1d`"
(<https://yarnpkg.com/features/security>). The same page also corrects a second
inherited error: Yarn has not run postinstalls by default **since 4.14**, not
since v2. Yarn additionally offers `npmPreapprovedPackages` to exempt specific
packages and a `--no-time-gate` flag to bypass the gate for a single `yarn add`
or `yarn up`.

The npm and pnpm rows were independently confirmed against their own docs.
The Bun row remains secondary-sourced and should not be relied on without
checking.

#### Population 1: the gateway repository

Add to `.npmrc`:

```ini
min-release-age=3
ignore-scripts=true
```

Install with `npm ci --ignore-scripts`, plus a narrowly targeted rebuild for any
package that genuinely needs a native build. Note that with `ignore-scripts=true`
in `.npmrc`, a bare `npm rebuild` inherits the config and does nothing; the
override must be explicit and scoped:

```bash
npm ci --ignore-scripts
npm rebuild --ignore-scripts=false <package> [<package>...]
```

Keep that allowlist as short as possible, since each entry restores that
package's full install-time attack surface. Set Renovate or Dependabot's own
cooldown to match, otherwise they will open PRs for versions the installer will
refuse.

The repo is already protected at install time by `npm ci` and a committed
lockfile. The cooldown protects the *update* moment, which is the only moment it
was ever exposed.

#### Population 2: the MCP servers

This is the real gap and pinning alone does not close it (see review point B).

Create `~/.mcp-servers/` containing a `package.json` with exact pins
(`--save-exact`), a committed `package-lock.json`, installed via
`npm ci --ignore-scripts`, then repoint every **npm-launched** server at
`~/.mcp-servers/node_modules/.bin/<binary>`.

This yields a lockfile, SHA-512 integrity hashes, no registry resolution at
session start, and no lifecycle-script execution. Note the binary name is not
always the obvious basename: `@playwright/mcp` installs `playwright-mcp`.

**Scope, corrected in rev 10.** Revs 6 to 9 said "repoint **every** launcher",
which is incoherent with this document's own enumeration and made the plan
non-executable. An npm `.bin` root cannot hold a Docker image, a git-sourced
`uvx` tool, or a Bun package. The four registry-capable classes and what this plan
does about each:

| Class | Control |
|---|---|
| npm (`npx`, `.mcp.json`, wrappers, plugin manifests) | **In scope**, but a one-time repoint is **not durable for plugin manifests**; see below |
| Python startup hooks (`pip install --upgrade` from a SessionStart hook) | **Newly identified rev 11.** Not covered by any npm control |
| Marketplace / plugin self-update | **Newly identified rev 11.** The mechanism that defeats the npm control itself |
| Docker (`docker run … :tag`) | **Out of scope.** Control would be digest pinning (`@sha256:…`) not a tag. **Latent on this host: `docker` is not on PATH** (only `podman`), so the definition cannot fire today |
| git-sourced `uvx` (`--from git+https://…`) | **Out of scope.** No published version exists to age; control would be a commit pin. **`uvx` IS on PATH** (`~/.local/bin/uvx`), so this one is activatable for real |
| Bun (`bun run` whose script begins `bun install`) | **Out of scope.** Needs a Bun lockfile discipline this plan does not define. **Latent: `bun` is not on PATH** |

The latent/activatable distinction matters and rev 9 elided it: a manifest that
names a binary the host does not have is a definition, not a launcher. *Corrected
again in rev 11:* rev 10 then said "only the `uvx` row is live today", which was
the twelfth falsehood. `uvx` is on PATH but Serena is **not enabled**, so that row
is **activatable, not live**. Nothing in this table fires today except the npm
row. Three revisions in a row have now over-stated this table in one direction or
the other, which is itself the argument for stating binary-presence and
enabled-state as two separate facts rather than collapsing them into "live". That lowers the urgency of the Docker and Bun rows
without changing the scope boundary, since installing either binary would activate
them with no change to any manifest.

This is deliberately an out-of-scope declaration with named residual risk, not a
silent omission. A plan that claims to cover "every launcher" while shipping one
package manager's control is worse than one that states its boundary, because the
first invites an operator to believe population 2 is closed when it is not.

**Six mechanisms, not four, and the sixth defeats the first.** Rev 10 counted only
what appears in a manifest `command` field. Counting by capability instead, a
round-8 host sweep found 136 manifests and 106 command fields (`npx` 29, Bun 12,
Docker 3, `uvx` 3, and no direct `pnpm`, Yarn, pipx, Go, Cargo, curl-to-shell or
Podman launcher), plus two mechanisms no manifest scan can see:

- a **SessionStart hook running unpinned `pip install --upgrade`**
  (`.../plugins/security-guidance/hooks/ensure_agent_sdk.py`, invoked from that
  plugin's `hooks.json`). Disabled today, but so are the latent marketplace
  launchers this table already counts, so excluding it was inconsistent.
- **marketplace / plugin self-update**, below.

#### The durability defect (round-8 blocker)

**A one-time `.mcp.json` repoint is not durable for plugin manifests, because
Claude's official marketplace updates installed plugins on disk after startup and
is enabled by default.** This was demonstrated involuntarily: starting a reviewer
during round 8 exercised the very updater under review, refreshing the real
marketplace cache and advancing its metadata. The refreshed manifest still reads:

```json
{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
```

Verified directly: that file's mtime moved to the review window while the content
remained unpinned. So an operator who edits the cached manifest has bought
protection until the next marketplace refresh, and the plan gives them no signal
when it lapses. **Population 2's npm half is therefore not closed by the pinned
root alone.**

The durable control must be one of:

1. **Disable that marketplace's auto-update**, and treat plugin updates as a
   deliberate, reviewed action like every other dependency bump; or
2. **Disable the plugin** and register the server directly from the pinned
   `~/.mcp-servers` root, so no marketplace-managed manifest is on the launch path
   at all.

Option 2 is preferable where the plugin is only wanted for its MCP server, since
it removes the manifest from the picture rather than racing the updater.

**The uncomfortable part.** Rounds 4 through 7 treated the marketplace as a source
of *new* launchers appearing on enable. It is also a mechanism that *reverts*
remediation on an automatic schedule, and nobody noticed until an accidental
mutation demonstrated it. Enumerating what a mechanism can introduce is not the
same as asking what it can undo.

*Corrected in rev 6, from round 3.* Rev 1 through rev 5 said to repoint
`~/.claude.json`, as though that were the only launcher. It is not, and the
`npx --yes` is mostly not even there:

- **There is a second client.** Codex declares the same servers at
  `~/.codex/config.toml`, in its `[mcp_servers.exa]`, `[mcp_servers.ref]` and
  `[mcp_servers.sqry]` blocks. Fixing `~/.claude.json` alone leaves every Codex
  session resolving latest. *Cite corrected in rev 8:* revs 6 and 7 gave this as
  `config.toml:233`, which was already stale when written and has since moved
  again (the blocks now start at 254). Never line-cite a live user config that is
  edited outside this repo; name the section instead.
- **The `npx --yes` lives in the wrapper scripts, not in the client config.**
  Both clients invoke `/home/werner/.local/bin/exa-mcp-from-azure`, whose last
  line is `exec npx -y exa-mcp-server ...`
  (`/home/werner/.local/bin/exa-mcp-from-azure:26`). The client configs point at a
  stable local path already; the unpinned resolution is one level down.

So the wrapper scripts are the fix site for the wrapper-based launchers, and
fixing them covers those clients at once without touching any config. The general
lesson stands and is the important part: this mitigation's boundary is not "the
client config", it is "every launcher that can reach a registry", and enumerating
those is part of the work rather than an assumption.

*Corrected again in rev 7, from round 4.* Rev 6 then immediately over-claimed, by
saying the wrappers are **the** fix site. They are not the only one. Round-4
review enumerated the host and found a launcher that bypasses them entirely:

- **An enabled Claude plugin runs `npx` directly.**
  `~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json`
  declares `{"command": "npx", "args": ["@playwright/mcp@latest"]}`. It is enabled
  at `~/.claude/settings.json:37`, and it has already materialised from the
  registry: `~/.npm/_npx/9833c18b2d85bc59/package-lock.json` exists. Neither Azure
  wrapper is involved. Verified directly, and corroborated by the fact that these
  Playwright MCP tools are live in the session that wrote this paragraph.

**Plugin and extension manifests are a launcher class the enumeration missed**,
because they are not user-authored config and do not live where anyone looks.
Repointing the wrappers does not cover even all *Claude*-launched servers.

The full host enumeration, recorded so the next round does not redo it. **It is
not all clean**: rev 8 introduced this table under a sentence claiming it was, and
revs 8 and 9 then added dirty rows to it without updating that sentence. Corrected
in rev 10, and it is the same defect as the spec review's: an artefact edited while
the claim above it was left alone.

| Launcher | Reaches a registry at session start? |
|---|---|
| `~/.claude.json`, `~/.codex/config.toml` (`[mcp_servers.*]`), `~/.gemini/settings.json`, `~/.grok/config.toml`, `~/.mcp.json` | Via the two shared wrappers only |
| `~/.claude/plugins/.../playwright/.../.mcp.json` | **Yes, `npx @playwright/mcp@latest`, uncovered** |
| Cursor, Devin, Vibe | No, HTTP remote gateway |
| `sqry-mcp` | No, versioned local binaries from GitHub releases |
| `~/.local/bin` others | Only `gateway-host-upgrade`, already on the register |
| **Project-scoped `.mcp.json`** (rev 9) | **Yes, and dirty today.** **26** exist under `/srv/repos` (excluding `node_modules`); **four** run `npx -y gitnexus@latest mcp`: `public/GitNexus/.mcp.json`, `public/GitNexus/gitnexus-claude-plugin/.mcp.json`, `public/sqry-compete/competitors/GitNexus/.mcp.json`, `public/sqry-compete/competitors/GitNexus/gitnexus-claude-plugin/.mcp.json` |
| **Non-npm marketplace launchers** (rev 9) | **Yes, and outside the npm fix entirely.** Executed marketplace activation fired `docker run hashicorp/terraform-mcp-server:0.4.0`, `uvx --from git+https://github.com/oraios/serena`, and a `bun run` whose package script begins with `bun install` |
| **Latent plugin/marketplace entries** (rev 9) | Not active today. Claude's marketplace (context7, firebase) and Codex's catalog (`npx -y xcodebuildmcp@latest`) carry unpinned `npx` launchers that activate **on enable**. **Not Grok**, see below |

**Why the latent row matters.** Enabling one of those plugins reintroduces an
unpinned `npx` without anyone editing a launcher this plan has fixed. That is the
honest version of the reappearance claim: not that a patched wrapper silently
reverts, but that the *set of launchers* grows by a normal user action. A fix
applied to today's enumeration is not a fix applied to the class.

**Two rev-8 errors corrected here in rev 9, both mine, both the same shape.**

1. **The Grok clause was false.** Rev 8 said Grok's cache carries `npx` launchers
   that activate on enable. Verified false: the only such manifests under
   `~/.grok/marketplace-cache` sit in `783232b622f8182e`, whose git remote is
   `anthropics/claude-plugins-official.git`, a **Claude** marketplace clone parked
   under a Grok-owned path. Grok's own configured source is
   `xai-org/plugin-marketplace.git` (`c6b314fa671daf8c`), which contains **no**
   `npx` manifests, and its enabled plugins are `cloudflare` and `exa`, both HTTP.
   Files existing under a directory a tool owns does not mean that tool loads them.
   I took this straight from a reviewer's round-5 list without checking the Grok
   third of it.

2. **"Currently clean" was false, and the count kept getting worse the harder
   anyone looked.** This is the single most instructive sequence in the review:

   | Search | Files found | Dirty |
   |---|---|---|
   | Rev 8, `-maxdepth 2` from one directory | 2 | 0, declared "clean" |
   | Rev 9, `-maxdepth 4` across `/srv/repos` | 9 | 2 |
   | Round-8 reviewer | 13 | 3 |
   | Unbounded `find`, excluding `node_modules` | **26** | **4** |

   Every step found more, and each searcher stopped where their own assumption
   about depth ran out. The reviewer that caught my error then made a smaller
   version of it. **An enumeration is only as good as its search, and a negative
   asserted over an unbounded space needs the search stated alongside it.** Any
   future claim of this shape in this document must name the exact command.

Both are the same failure the spec review kept hitting: a claim asserted over a
scope narrower than the claim itself.

Note also that these wrappers fetch an API key from Azure Key Vault and
`export` it before `exec`. That places a live credential in the environment of an
unpinned, latest-resolved package at every session start, which is the same
composition the incident exploited. Pinning the wrapper is therefore worth more
here than the `npx` count alone suggests.

*Corrected in rev 5:* rev 1 through rev 4 said "updating becomes a deliberate,
reviewable `npm update`". **That does not work with exact pins.** `npm update`
respects the semver constraints in `package.json`, so an exactly pinned dependency
stays where it is and the command is a no-op. Bumping requires naming the version:

```bash
npm install <pkg>@<version> --save-exact
```

which is arguably better, since the new version is explicit in the diff and in
the review, but the instruction as written would have silently done nothing.

#### Population 3: the provider CLIs

The interesting case, because this repository has a standing requirement to track
these CLIs: `PROVIDER_TARGET_VERSIONS`, the drift probes, and `pre-release.sh`
probing real binaries.

A cooldown is close to free here. Nobody chases a grok or vibe release within
hours of publication, so a 72-hour floor costs nothing operationally while
removing exactly the window this attack occupied.

Better: the repository already owns `provider_version_guard`, with upgrade
availability probing and a daily timer. Teaching it to withhold an upgrade
recommendation until the candidate version is at least N days old converts
existing drift machinery into a supply-chain control. This is the highest-leverage
item and is specific to this setup. It touches shipped code, so it needs its own
spec and review gate rather than being applied directly.

*Corrected in rev 2:* rev 1 called this "a small change to code we already own".
Review of the actual implementation says otherwise, and the correction matters for
sizing:

- `src/provider-version-guard.ts` is a **pure offline** comparison of installed
  version against `PROVIDER_TARGET_VERSIONS`. It has no registry access and no
  concept of publish time. The gate does **not** belong here.
- It belongs in `src/provider-upgrade-availability.ts`, the network probe path,
  which today reads only a version string. The npm probe returns `latest` without
  a publish timestamp, so this needs packument `time` data (or equivalent per
  ecosystem) that is not currently fetched.
- Only 4 of 7 providers are probeable at all: claude and codex via the npm
  registry, mistral via PyPI JSON, grok via `update --check`. gemini, devin, and
  cursor return `unknown`. So the gate can only cover the probeable subset.
- It must surface as a **distinct state**, something like
  `upgrade-available-but-too-new`, never as `current`. Collapsing it into
  `current` would hide a genuine upgrade and turn a supply-chain control into a
  drift bug.

**Enforcement gap, found in review and fatal to the plan as written.** Withholding
a recommendation from `provider_version_guard` is **advisory only**. A caller can
invoke `cli_upgrade` directly, and its target defaults to `latest`
(`buildCliUpgradePlan(cli, target = "latest", ...)` at `src/cli-updater.ts:90`,
registered at `src/index.ts:22612`). Verified directly. A gate that only suppresses
advice is a paper control: the very agent being advised can bypass it in one tool
call.

**Round 2 went further and broke the control entirely. The provider cooldown has
no authoritative execution boundary.** Rev 3 proposed gating the `cli_upgrade`
execution path. Round-2 review found three ways that fails, all verified:

1. **Bypass from outside.** `cli_upgrade` is reachable around, not through. Any
   provider request tool that grants Bash or unrestricted execution (Claude Bash
   permissions, Codex `danger-full-access`) can run `claude update` or
   `npm install -g` directly, as can any human with a shell.
2. **Bypass from inside.** Even within `cli_upgrade`, Mistral's `uv` and Homebrew
   strategies ignore an explicit target. The gateway's own note string says so:
   *"uv tool upgrade does not honour explicit version targets; running upgrade to
   latest"* (`src/cli-updater.ts:281-292`). So age-checking the *requested* target
   would not describe the artefact actually installed. The control would report
   success while installing latest.
3. **A live automated path outside it.** `gateway-autoupgrade.timer` is **enabled
   and running on this host**, verified: it last fired 3h38m before this writing
   and next fires in 14h. `scripts/host-upgrade.sh auto` resolves npm latest and
   installs it globally without passing through `cli_upgrade` at all.

**Conclusion, and a correction to rev 1 through rev 4.** Population 3 was
described as "the highest-leverage item on this list". That was wrong. As
designed it is not a security control, because no boundary exists that every
installation path must cross. The plan must either:

- move enforcement to the **broadest authority available**, a user-global npm
  `min-release-age`. Rev 5 called this "an authority every path shares", which is
  false twice over and is corrected in rev 6. It is not shared by every path: it
  does not reach `uv`, Homebrew, `pip install -U` (the gateway's own Mistral
  strategy, `src/cli-updater.ts:266`), or native self-update. And it is not an
  authority even over the paths it does reach, because npm resolves configuration
  in the order CLI > environment > project > user > global and permits replacing
  `userconfig` outright, so `--min-release-age=0` or `npm_config_min_release_age=0`
  overrides it from any shell. It is a **default**, which is worth having and is
  not the same thing as a boundary, **or**
- explicitly downgrade it to a **cooperative workflow policy**: useful for
  reducing accidental exposure by the gateway's own tooling, not a barrier
  against an agent or operator who wants latest.

The honest version is probably both: a global npm floor as the strongest default
available where it reaches, plus `cli_upgrade` gating as defence in depth, plus a
documented acceptance that `uv`, Homebrew, `pip`, native self-update, and any
shell willing to pass a flag remain uncovered.

**Full bypass inventory (round 2).** Reviewers were asked to find every other path
to an unvetted provider upgrade. Result:

| Path | Upgrades a provider CLI? | Notes |
|---|---|---|
| `cli_upgrade` | **Yes** | The only gateway tool that installs or updates providers. `dryRun` defaults true, `target` defaults `latest` |
| `provider_admin_run` / `provider_admin_mutate` | No | Binary-update families are `not_exposed` by policy (`src/provider-admin-tools.ts:85-87`) |
| `gateway-provider-drift.timer` | No | Defaults to `GATEWAY_DRIFT_MODE=report`; `apply` only rebaselines contract versions, it does not install |
| `gateway-autoupgrade.timer` / `scripts/host-upgrade.sh` | Gateway package only | Runs `npm install -g llm-cli-gateway@…` to latest. Not a provider path, but see below |
| **Ambient agent or operator shell** | **Yes** | `claude update`, `codex update`, `npm install -g @openai/codex@…`, `pip install -U mistral-vibe`. **Trivial bypass of any MCP-tool-only gate** |

Two consequences the plan must state rather than gloss:

1. **A gateway-side gate is a tool control, not a host control.** Most providers
   self-update (`claude update`, `codex update`, `grok update`, `agy update`),
   which never consults the repo `.npmrc` and never passes through `cli_upgrade`.
   Any agent or human with shell access bypasses the floor by typing the native
   command. The honest framing is that gating `cli_upgrade` closes the path the
   gateway owns, and that host-level coverage needs a user-global npm floor for
   the npm-strategy providers plus an agent policy for the self-updaters.
2. **`gateway-autoupgrade.timer` auto-installs the gateway itself to `latest`,
   unpinned.** That is the same unpinned-execution pattern the original assessment
   flagged for `npx`, applied to this package, on a timer. It is out of scope for
   the provider cooldown but belongs on the risk register.

Review also confirmed the 72-hour floor creates **no drift-detection regression**,
and that drift coverage is in fact broader than rev 1 credited:

- every gateway start asynchronously probes installed provider binaries against
  targets (`src/startup-version-check.ts:46`, invoked at `src/index.ts:23868`)
- a persistent systemd daily timer runs the drift check
  (`setup/systemd/gateway-provider-drift.timer:16`)
- `npm run check` remains intentionally blind to installed binaries
  (`package.json:114`)

Specifically:
installed-versus-contract reporting is unaffected, and `npm run check` is no worse
than today, since it already only runs the offline `upstream:contracts` fixture
check while live binary probing lives in `upstream:drift`, `pre-release.sh`, and
`provider-drift-check.sh`. That gap is pre-existing. If anything the floor reduces
surface drift, by stopping operators chasing hours-old CLI releases.

`ignore-scripts` needs per-CLI testing here, since some install native
components.

#### Residual risk, stated plainly

- A cooldown only helps against compromises found and pulled quickly. It does
  nothing against a long-dwell account takeover that sits for weeks.
- Lockfile entries bypass the cooldown, so it protects update time, not install
  time.
- Git dependencies (`github:owner/repo#hash`) sidestep release-age gates
  entirely: there is no published version to age.
- Post-install persistence is a separate hunt with its own cadence:
  `~/.claude/settings.json` SessionStart hooks, `.vscode/tasks.json` folderOpen
  tasks, planted LaunchAgents.
- **npm v12 has already shipped** and makes install scripts opt-in by default,
  along with **git and remote-URL** dependencies. Rev 1 through rev 3 said this was
  "expected", which was wrong: v12 went generally available on 2026-07-08 and the
  registry `latest` dist-tag is **12.0.2**, verified directly. **This host is still
  on npm 11.12.1**, also verified, so it does not yet have those defaults and the
  explicit `.npmrc` settings above remain necessary. Upgrading npm itself is
  therefore a mitigation in its own right, and one not previously listed.
  *Narrowed in rev 6:* rev 5 said "non-registry sources", which overstates it.
  Only git and remote URLs became opt-in (`--allow-git` / `--allow-remote`); file
  and directory sources explicitly kept their existing defaults.

**Added in rev 6, from round 3.** Both reviewers found this section incomplete by
the document's own standard: it stated elsewhere that the autoupgrade timer
"belongs on the risk register" and then omitted it from the register. That is
fixed, along with the residuals the population-3 reframe created and never
carried here:

- **`gateway-autoupgrade.timer` auto-installs this gateway to `latest`, unpinned,
  on a schedule.** Verified enabled and active. It is the same unpinned-execution
  pattern the original incident flagged for `npx`, applied to this package. A
  user-global `min-release-age` floor does constrain it, but by making the install
  *fail* on a too-young release rather than selecting an older eligible one, so the
  residual is a noisy-failure mode rather than silent exposure.
- **npm configuration is overridable by design.** CLI flags and `npm_config_*`
  environment variables outrank the user-global floor, and `userconfig` itself can
  be replaced. Any shell-capable agent can opt out per-invocation.
- **The release build installs outside the repo's configuration.**
  `installer/build-release.sh:279` copies only `package.json` and
  `package-lock.json` into a staging directory and runs `npm ci --omit=dev` there.
  A project-level `.npmrc` carrying `ignore-scripts=true` does not travel with it,
  so that install would not inherit the repo policy. A user-global setting would
  still apply, which is a further argument for putting the floor at user level
  rather than project level.
- **Non-npm upgrade paths take no part in any of this**: `uv`, Homebrew,
  `pip install -U`, and the providers' own `claude update` / `codex update` /
  `grok update` / `agy update`.
- **Population 2 depends on config stickiness, not on an interceptor.** Anything
  that rewrites an MCP launcher, or runs `npx --yes` again, silently undoes it.
  There is no host-level mechanism that would notice. *Sharpened in rev 7:* this
  is not hypothetical and should never have been written as though it were. An
  enabled Claude plugin already runs `npx @playwright/mcp@latest` today, outside
  both wrappers, and has already materialised it from the registry. Plugin and
  extension manifests update themselves on their own cadence, so this class of
  launcher can reappear after any fix without anyone editing a config.


## Appendix B: review history (closed 2026-08-08)

Eight rounds of adversarial review. Retained as a record of how each fact was
established, and of the twelve falsehoods the rounds removed. The programme is
closed; see the Status section for why. These records are not evidence in their
own right.

### 4m. Round 8 outcome (settled in rev 11)

Grok approved on executed evidence. Codex blocked, and was right, in the same
shape as every prior split: the approval verified the things the document asserts,
the blocker found a thing the document never thought to assert.

**The blocker: the npm control is not durable.** Claude's official marketplace
updates installed plugins on disk after startup, enabled by default. An operator
who repoints a cached plugin `.mcp.json` at the pinned root keeps that protection
only until the next refresh, with no signal when it lapses. This was demonstrated
**involuntarily**: starting a reviewer during the round exercised the very updater
under review, refreshing the real marketplace cache. Verified directly, the
refreshed manifest still reads `npx @playwright/mcp@latest`, and its mtime moved
into the review window. Rev 11 adds the durable control, and prefers deregistering
the plugin over racing the updater.

**Twelfth falsehood, mine:** rev 10 said "only the `uvx` row is live today".
`uvx` is on PATH but Serena is not enabled, so it is *activatable*, not live.
Three revisions running have mis-stated that table in one direction or the other,
which is the argument for recording binary-presence and enabled-state as separate
facts instead of collapsing them into one word.

**Two mechanisms added**, taking the count from four to six: a SessionStart hook
running unpinned `pip install --upgrade`, and marketplace self-update itself. The
round-8 sweep also gave real figures for the first time: 136 manifests, 106
command fields, `npx` 29, Bun 12, Docker 3, `uvx` 3, with no `pnpm`, Yarn, pipx,
Go, Cargo, curl-to-shell or Podman launcher found.

**The retraction from round 7 survived a deliberate attempt to break it.** Both
seats re-confirmed that Claude connects successfully through pinned `.bin`
launchers and that the round-6 failure was a harness artifact.

**What this round actually teaches.** Rounds 4 through 7 asked what the marketplace
can *introduce*. Round 8 found it also *reverts* remediation, automatically, and
nobody had asked that question. Enumerating what a mechanism can add is a different
question from what it can undo, and a plan made of one-time edits is only as
durable as the systems allowed to rewrite them.

Also worth stating plainly: a reviewer caused a real host mutation and disclosed it
rather than hiding it. That disclosure is what turned an accident into the round's
most valuable finding.

### 4l. What reviewers should attack (round 8, settled)

Rounds 1 to 7 are settled; see 4k below.

Rounds 6 and 7 both blocked on scope rather than facts, and rev 10 answers that by
**declaring a boundary** instead of widening the fix. Round 8 should test whether
that boundary is honest and whether the plan is now finishable.

1. **Is the scope declaration coherent and complete?** Rev 10 names four
   registry-capable classes (npm in scope; Docker, git-`uvx`, Bun out with named
   residual risk). Attack both halves:
   - **Is four the right number?** Enumerate registry-capable launcher mechanisms
     by capability, not by the list rev 10 happens to give. Anything that fetches
     executable code at or after session start counts: other package managers,
     `pipx`, `go run`, `cargo install`, curl-to-shell in a wrapper, a plugin that
     self-updates. State your search command.
   - **Is "accepted residual risk" honest here**, or is it a way of not solving
     the problem? For each out-of-scope class, is there a control cheap enough
     that declining it needs a better reason than "this plan is about npm"?

2. **Verify the latent-versus-live distinction.** Rev 10 claims `docker` and `bun`
   are absent from this host's PATH while `uvx` is present, making only the `uvx`
   row live. Check it, including whether any launcher would resolve those binaries
   by another path (container runtime aliases, a plugin bundling its own).

3. **Re-test the round-7 retraction.** Rev 10 now says the round-6
   `Connection closed` failure was a harness artifact and that Claude connects
   fine through pinned `.bin` launchers. That retraction is load-bearing for
   population 2 and it went in the *optimistic* direction, which is the direction
   this review has the least practice at checking. Try to break it.

4. **Is the plan executable end to end now?** Rounds 6 and 7 both said no, on
   non-npm launchers. Rev 10's answer is an explicit boundary rather than a
   control. Does that make it executable, or does it just make the gap official?
   If it is executable, say so plainly, because that is the verdict this document
   has been working toward.

5. **Hunt for remaining false claims.** Seven rounds, eleven falsehoods, four
   introduced by fixes. Assume a twelfth.

Read-only probes and non-destructive temp-directory experiments are expected. Do
**not** modify the host's real npm config, MCP client configs, plugin trees, or
installed packages. Clean up any scratch files you create.

### 4k. Round 7 outcome (settled in rev 10)

Both seats blocked on the same thing, and the round's most valuable result was a
retraction in the plan's favour.

**The shared blocker: "repoint every launcher" was incoherent** with this
document's own table recording Docker, git-`uvx` and Bun as outside an npm repair,
with no control, no exclusion and no accepted-risk statement. Fixed in rev 10 by
declaring the boundary explicitly, per class, with named residual risk. A plan
claiming to cover "every launcher" while shipping one package manager's control is
worse than one that states its limit, because the first invites an operator to
believe population 2 is closed when it is not.

**The multi-client `.bin` risk is closed, and the round-6 finding was wrong.**
Round 6 reported Claude 2.1.223 returning `Connection closed` against both pinned
`.bin` servers, which was the single biggest threat to population 2's design.
Codex reproduced it and showed it was a **harness artifact**: in that environment
Claude sent zero bytes to a minimal stdio server, and equivalent explicit
`node script.js` launchers failed identically, so the result never distinguished
`.bin` wiring from any other child process. Real Claude local-scope connection logs
show the opposite, and I read them directly rather than taking the summary:

```
Successfully connected (transport: stdio) in 242ms
Connection established with capabilities: {"hasTools":true,"hasPrompts":true,...}
Sending SIGINT to MCP server process
STDIO connection closed after 0s (cleanly)
```

The "closed after 0s" line is a deliberate teardown *after* a successful
negotiation. Reading the tail of that log suggests failure; reading the whole log
shows success. **Population 2's npm design does not need rethinking.**

Worth naming: this is the first time in either review that a round's finding was
overturned in the *optimistic* direction. The same discipline that kept catching
my over-claims caught an over-claimed failure, and the correction only came from
reproducing the original result rather than trusting it.

**Also settled:** Claude Code 2.1.223 under `ignore-scripts` is definitively broken
and definitively fixable, confirmed by extracting the cached package and watching
`install.cjs` replace a 500-byte stub with the native executable. And the non-npm
launcher rows needed a latent-versus-live distinction, since `docker` and `bun` are
not on this host's PATH while `uvx` is.

**An eleventh falsehood, mine:** the sentence introducing the enumeration table
still said "the rest of the host enumeration came back clean" after revs 8 and 9
had added dirty rows to that very table. Same defect as the spec review's repeated
failure: the artefact was edited and the claim above it was not.

### 4j. What reviewers should attack (round 7, settled)

Rounds 1 to 6 are settled; see 4i below.

Round 6 changed what this document is about. The facts are now largely tested; the
**scope** is what failed. Round 7 should finish that job.

1. **Does the plan now cover the launcher classes it claims to?** Rev 9 adds
   Docker, git-`uvx` and Bun launchers to the enumeration but section 3 still
   proposes only an npm `.mcp-servers` root. Either the plan needs a story for
   non-npm launchers (pin a digest, vendor the tool, disable the plugin, accept and
   monitor) or it must say plainly that those are out of scope and why. Judge
   which, and say whether the resulting plan is coherent.

2. **Enumerate by capability once more, and state your search command.** The
   project-scoped `.mcp.json` count went 2 → 9 → 13 → 26 across four searches, each
   bounded by the searcher's own depth assumption. Assume the current figure is
   still low. This applies to plugin trees, marketplace caches, and any
   `command` field in any MCP manifest anywhere on this host, not only under
   `/srv/repos`.

3. **Close the biggest untested dependency: multi-client `.bin` wiring.** Round 6
   found Claude 2.1.223 reporting `Connection closed` against both exact `.bin`
   servers, while direct launches worked and Grok's doctor succeeded. That is
   currently the difference between a working mitigation and a broken one, and it
   is unexplained. Diagnose it. If Claude genuinely cannot use the pinned root,
   population 2's whole design needs rethinking.

4. **Attack rev 9's new text**: the four dirty launchers, the 26-file count, the
   non-npm launcher row, and the claim that Claude Code under `ignore-scripts` is
   broken without a scoped rebuild.

5. **Hunt for remaining false claims.** Six rounds, ten falsehoods, three of them
   introduced by fixes. Assume an eleventh.

6. **Is the plan executable end to end now?** If not, name the first
   underspecified step. Round 6 said no, on non-npm launchers. If rev 9 has not
   fixed that, say so again rather than softening it.

Read-only probes and non-destructive temp-directory experiments are expected. Do
**not** modify the host's real npm config, MCP client configs, plugin trees, or
installed packages. Clean up any scratch files you create.

### 4i. Round 6 outcome (settled in rev 9)

Both seats blocked, on different things, and both blockers were verified before
acceptance. This is the round where the plan's *scope* failed rather than its
facts.

**Codex's blocker: the fix covers one package manager out of four.** Population 2
prescribes repointing "every launcher" at an npm `.bin`. Codex activated
marketplace plugins against stub binaries and caught launchers that no npm lock
root can hold:

```
npx:    -y @upstash/context7-mcp | -y firebase-tools@latest mcp | -y xcodebuildmcp@latest mcp
uvx:    --from git+https://github.com/oraios/serena serena start-mcp-server
docker: run -i --rm -e TFE_TOKEN=... hashicorp/terraform-mcp-server:0.4.0
bun:    run --cwd .../external_plugins/discord --shell=bun --silent start
```

Docker images, git-sourced `uvx` tools and Bun packages are all registry-capable
and all outside the proposed repair. The `bun run` case is the nastiest: its
package script *begins with* `bun install`, so the install happens inside what
looks like a run command.

**Grok's blocker: the Grok clause was false**, since corrected. Codex then settled
it by execution rather than by reading config, installing and enabling `context7`
under Grok and watching the `npx` stub never fire. `grok inspect` showed the plugin
carrying an MCP while `grok mcp list` stayed empty and the resolved session omitted
it. Stronger evidence than either the claim or Grok's own refutation of it.

**Remaining hypotheses, now executed:**

- combined `~/.mcp-servers` root: **works**. Exact `exa-mcp-server@3.4.0`,
  `mcp-remote@0.1.38`, `@playwright/mcp@0.0.79`; 174 integrity entries; offline
  `npm ci --ignore-scripts` reproduces it. Direct `.bin` launches returned 2 Exa
  tools and 24 Playwright tools
- multi-client `.bin` wiring: **not established**. Claude 2.1.223 reported
  `Connection closed` against both exact `.bin` servers. `mcp-remote` and
  Antigravity failed on listener restrictions in the reviewer's sandbox, so those
  are inconclusive rather than negative. This remains the single biggest untested
  dependency in the plan
- provider CLIs under `ignore-scripts`: **Claude Code 2.1.223 is broken** by it,
  falling back to a 500-byte stub that exits "native binary not installed"; a
  scoped rebuild fixes it. Codex 0.146.1 is fine. The rest are native, Python or
  self-update paths that npm's setting neither protects nor breaks
- Dependabot: the proposed `cooldown.default-days: 3` is schema-valid, **and the
  existing config already receives an implicit three-day cooldown** for version
  updates. Cooldown does not apply to security updates

**The enumeration table in section 3 is the most instructive artefact in this
document**, and it is not flattering: four successive searches for project-scoped
`.mcp.json` returned 2, 9, 13 and 26 files, with 0, 2, 3 and 4 dirty launchers.
Each searcher, including the reviewer who caught my error, stopped where their own
depth assumption ran out.

**A process failure of mine, recorded because the reviewer caught it:** Codex began
against rev 8 and observed the file acquire rev 9 text at 08:28 while it was still
working, because I was folding in the other seats' findings concurrently. Its
verdict is filed against the rev it actually reviewed. Do not edit a document while
it is out for review; the review's scope becomes unknowable.

### 4h. What reviewers should attack (round 6, settled)

Rounds 1 to 5 are settled; see 4g below.

**This document's characteristic failure is that a replacement inherits the trust
its predecessor just lost.** It has happened in rounds 3, 4 and 5. Rev 8 is round
5's fix, so it is the most suspect text here.

Round-6 priorities:

1. **Attack rev 8's new text, by execution where possible.**
   - the **latent-launcher row**: it claims Claude's marketplace (context7,
     firebase), Codex's catalog (`npx -y xcodebuildmcp@latest`) and Grok's cache
     all carry unpinned `npx` launchers that activate on enable. Verify each, and
     check whether enabling one really does bypass a fixed wrapper.
   - the claim that the two project-scoped `.mcp.json` files are **currently
     clean** because they launch absolute local binaries.
   - the characterisation of `.github/workflows/npm-publish.yml:105`. Is a bare
     `npm rebuild better-sqlite3` really a no-op under `ignore-scripts=true`, and
     is the proposed explicit override the correct fix rather than a second
     silent failure?

2. **Execute the remaining hypotheses.** Rev 8 explicitly labels these untested,
   which is honest but not finished. Run them and report what breaks:
   - the combined `~/.mcp-servers` exact-pin root with a committed lockfile
   - multi-client `.bin` rewiring: do the servers actually launch and serve
     `tools/list` under *every* client that needs them, not just one
   - provider CLI behaviour under `ignore-scripts` (the document has flagged this
     as needing per-CLI testing since rev 1 and never resolved it)
   - a Dependabot or Renovate cooldown configuration

3. **Population 2 enumeration, a fourth time.** Rounds 4 and 5 each found a
   launcher class the previous round missed. Enumerate by *capability*, across all
   clients' plugin and marketplace trees, not by artefact type.

4. **Hunt for remaining false claims.** Five rounds, eight falsehoods, two of them
   introduced by fixes. Assume a ninth, including in anything rev 8 added.

5. **Is the plan now executable end to end by a competent operator?** If not, name
   the first step that is still underspecified. This document has been reframed
   twice and is overdue a verdict on whether it is actionable.

6. If you find nothing false, say so and approve. Do not manufacture a blocker. An
   approval naming what you executed is worth much more than one asserting the
   document reads consistently.

Read-only probes and non-destructive temp-directory experiments are expected. Do
**not** modify the host's real npm config, MCP client configs, plugin trees, or
installed packages.

### 4g. Round 5 outcome (settled in rev 8)

Codex blocked, Grok approved on executed evidence, and between them they turned
this from a plan of assertions into a plan with a tested core.

**Codex's blocker, accepted:** project-scoped `.mcp.json` is an unenumerated
registry-capable launcher class. Verified: two exist on this host and both happen
to launch absolute local binaries, so nothing is exposed today. The class still
belongs in the table, because the enumeration is supposed to describe what *can*
reach a registry, not what currently does.

**The finding underneath the blocker matters more than the blocker.** Codex
classified every section-3 control as executed or hypothesised, and most were
hypotheses. The sharpest result:

- **`ignore-scripts=true` would silently break the release workflow.**
  `.github/workflows/npm-publish.yml:105` runs a bare `npm rebuild better-sqlite3`,
  which becomes a no-op once `.npmrc` sets `ignore-scripts=true`. Codex
  demonstrated this by suppressing scripts (WAL suite fails, missing binding) and
  restoring with an explicit `--ignore-scripts=false` override. A mitigation that
  quietly disarms a release-gate step is worse than no mitigation, and this plan
  would have shipped it.

**Grok's approval is the more useful artefact**, because it is the first one in
either document backed by executed probes rather than reading:

- `ignore-scripts` blocks lifecycle scripts on install and `ci`; bare rebuild is a
  no-op; explicit override works (independently reaching Codex's conclusion)
- this repo's real lockfile under `ignore-scripts`: prod `npm ci --omit=dev` is
  fine, dev needs the `better-sqlite3` rebuild
- `min-release-age` via a disposable userconfig fails too-young installs for exact
  and range specs, for local, `-g --prefix` and `--prefix` forms, and lockfile
  `npm ci` bypasses it
- an `~/.mcp-servers`-shaped install of `exa-mcp-server` under `ignore-scripts`
  produces a binary that actually launches

Grok also swept the Claude, Codex and Grok plugin trees and found no additional
*active* npm launcher beyond Playwright and the two wrappers, but a list of latent
ones that activate on enable. Both of its non-blocking corrections were mine and
both are fixed: the fabricated `forge/mcp.json` row, and the stale
`~/.codex/config.toml:233` cite.

**Still hypotheses**, and labelled as such rather than quietly promoted: the
combined `~/.mcp-servers` exact-pin root, multi-client `.bin` rewiring, provider
CLI behaviour under `ignore-scripts`, and any Dependabot cooldown config.

### 4f. What reviewers should attack (round 5, settled)

Rounds 1 to 4 are settled; see 4e below.

**The headline priority comes from the sibling spec review, where round 6 just
overturned a round-3 finding.** That finding had been accepted because its
evidence was a set of true *static* facts (an export exists, a handler installs)
standing in for a *dynamic* claim (the path works). Nobody ran it for three
revisions. The same question has never been asked of this document, and it is a
security plan, where the gap matters more:

1. **Which of this plan's controls have actually been executed, and which are
   merely believed to work?** Go through every mitigation in section 3 and
   classify it. Candidates that look asserted rather than tested:
   - `ignore-scripts=true` in a project `.npmrc`: does it actually take effect for
     the installs this repo performs, and what breaks? The document itself notes
     "`ignore-scripts` needs per-CLI testing here, since some install native
     components" and then never resolves it.
   - a user-global `min-release-age`: verified by one reviewer to make a too-young
     exact-version install *fail*. Is that the real behaviour across the install
     forms this host uses, including `npm install -g --prefix`?
   - `~/.mcp-servers/` with `npm ci --ignore-scripts`: has anyone confirmed the
     servers still launch and function from `node_modules/.bin` under every client
     that needs them?
   Name each control that has never been run, and say what the smallest probe
   would be. A control that has not been executed is a hypothesis.

2. **Attack rev 7's new text**, which is one round old and unreviewed: the claim
   that plugin and extension manifests are a distinct launcher class; the
   enumeration table of host launchers; and the sharpened residual-risk bullet
   asserting this class "can reappear after any fix without anyone editing a
   config". Is that last claim true of how these plugin caches actually update?

3. **Population 2 enumeration, again.** Round 4 found a launcher two prior rounds
   missed, inside a plugin cache. Assume another category exists. Enumerate by
   *capability* (what can reach a registry at or after session start) rather than
   by artefact type.

4. **Hunt for remaining false claims.** Four rounds, seven falsehoods. Assume an
   eighth, including in anything rev 6 or rev 7 introduced.

5. If you find nothing false, say so and approve. Do not manufacture a blocker. An
   approval naming what you executed is worth much more than one asserting the
   document reads consistently.

### 4e. Round 4 outcome (settled in rev 7)

Split verdict, and the split is instructive.

**Grok: unconditional approval.** It verified every rev-6 replacement and found
them all sound: npm precedence and replaceable `userconfig` (against both the
v11 host docs and v12 docs, plus a live test where a project
`min-release-age=10` overrode a user `=1`), the `build-release.sh` staging
behaviour, the npm v12 git/remote versus file/directory split, and the rewritten
residual-risk section against the bypass inventory. It also enumerated the host's
MCP configs. Its enumeration was correct as far as it went, and it explicitly
noted "the client list is still thin; the fix-site claim is not".

**Codex: one blocker, and it falsified exactly the claim Grok had just blessed.**
The fix-site claim was the thin one. An enabled Claude plugin runs
`npx @playwright/mcp@latest` directly, outside both wrappers, already materialised
in `~/.npm/_npx/`. Verified independently before acceptance. Folded into
population 2 and into the residual-risk register, which had described renewed
`npx` use as a hypothetical.

**Why Grok missed it and Codex did not.** Grok enumerated *configuration files*,
which is where MCP launchers are declared by a human. The Playwright launcher is
declared by a *plugin manifest* inside a cache directory that no one authored and
no one edits. Both reviewers were looking at the same host; they differed on what
counted as a place to look. The generalised rule: when enumerating an attack
surface, enumerate by *capability* (what can reach a registry) rather than by
*artefact type* (what looks like a config file), or the enumeration inherits your
assumptions about where things live.

This is the second consecutive round where one seat approved and the other
falsified a specific claim inside the approved text. Approval and blocker are not
symmetric evidence: a blocker names a thing to check, an approval asserts a
negative over a search space that the approver defined.

### 4d. What reviewers should attack (round 4, settled)

Rounds 1 to 3 are settled; see 4c below and do not re-litigate them.

Round-4 priorities:

1. **Attack the rev-6 replacements, not the rev-5 defects.** Round 3 showed this
   document's characteristic failure: a retired claim gets replaced, and the
   replacement inherits the trust the original had just lost. Rev 6 introduced
   several new claims. Each is fair game and none has been reviewed:
   - that npm precedence is CLI > environment > project > user > global, and that
     `userconfig` can be replaced;
   - that the wrapper scripts, not the client configs, are the correct fix site for
     population 2, and that fixing them covers both clients;
   - that `installer/build-release.sh:279` would not inherit a project `.npmrc`,
     but would inherit a user-global one;
   - that npm v12's opt-in change covers git and remote URLs but not file and
     directory sources.
2. **Is the residual-risk section now complete?** It was rewritten wholesale. Check
   it against the document's own bypass inventory and against every mitigation
   proposed in section 3. Anything the plan recommends whose failure mode is not
   listed there is a gap.
3. **Population 2 has never been fully enumerated.** Rev 6 claims the fix site is
   "every launcher that can reach a registry" and names two clients and one wrapper
   family. Find launchers it still misses. `~/.claude.json`, `~/.codex/config.toml`,
   any Cursor, Gemini, Grok, Devin, or Vibe MCP configuration, VS Code
   `mcp.json`, and anything under `~/.local/bin` that shells out to a package
   manager are all in scope.
4. **Hunt for remaining false claims.** Three rounds, six falsehoods. Assume a
   seventh. Every version, default, unit, npm behaviour, path, and repo code claim
   is fair game, including everything introduced by the rev-6 edits.
5. **Is the plan now actionable?** It has been reframed twice. State plainly whether
   a competent operator could execute it as written, and name the first step that is
   still underspecified.
6. If you find nothing false, say so and approve. Do not manufacture a blocker.

Note for both seats: in round 3 you blocked on two different sections and both
blockers held. Converging is not required. If you disagree with the other seat's
finding once you see it, that is worth more than agreement.

### 4c. Round 3 outcome (settled in rev 6)

Both seats returned a blocker, and they converged on the same section from
different directions.

- **Grok:** the residual-risk section was incomplete by the document's own
  standard. Section 3 said the unpinned `gateway-autoupgrade.timer` "belongs on the
  risk register"; the register omitted it, along with every residual the
  population-3 reframe had created. Verified by reading both sections. Fixed.
- **Codex:** the population-3 conclusion still called a user-global npm default
  "an authority every path shares". Verified false on two independent grounds:
  npm's documented precedence (CLI > environment > project > user > global, with
  `userconfig` replaceable) makes it overridable from any shell, and the sentence
  contradicted its own parenthetical, which already listed paths it does not
  reach. Fixed by reclassifying it as the broadest available **default** rather
  than a boundary.

Grok independently confirmed that the floor *does* apply to same-user
`npm install -g` and to `scripts/host-upgrade.sh` (global mode ignores project
config but still loads user config), and that it blocks a too-young exact-version
install by failing rather than silently selecting an older version. Both facts are
kept: the mitigation works, it is just not an authority.

Also fixed in rev 6, from Codex's supporting findings, each verified before
acceptance:

- Population 2 named only `~/.claude.json`. Codex declares the same servers at
  `~/.codex/config.toml` (`[mcp_servers.*]`), and the `npx -y` is actually inside the shared
  wrapper scripts (`/home/werner/.local/bin/exa-mcp-from-azure:26`), which is a
  better fix site than either config.
- `installer/build-release.sh:279` runs `npm ci --omit=dev` in a staging directory
  that receives only `package.json` and `package-lock.json`, so a project `.npmrc`
  never reaches it.
- `pip install -U` (`src/cli-updater.ts:266`, the Mistral strategy) was missing
  from the uncovered-path list.
- "npm v12 makes non-registry sources opt-in" was overbroad: git and remote URLs
  changed, file and directory sources did not.
- Off-by-one on the `cli_upgrade` registration line, 22611 to 22612 (Grok).

**The pattern worth naming.** Round 2's Codex blocker was that population 3 had no
enforcement boundary. Rev 5 accepted that, reframed the population, and then
reintroduced the same error one paragraph later by calling the replacement an
authority. The fix and the defect were in the same edit. Round 4 on the sibling
spec failed the same way. When a review retires a claim, the replacement claim
needs the same scrutiny the retired one just failed, and it does not get it
automatically by virtue of being new.

### 4b. What reviewers should attack (round 3, settled)

Round 2 is settled. Both blockers were verified and fixed:

- **Grok:** npm v12 already shipped (GA 2026-07-08, `latest` = 12.0.2); this host
  runs 11.12.1. Fixed, and upgrading npm added as a mitigation in its own right.
- **Codex:** the provider cooldown has no authoritative execution boundary. The
  proposal is now reframed rather than deleted, and its "highest-leverage" framing
  retracted.

Also fixed in rev 5: `npm update` does not advance exact pins; the `_npx` lockfile
guarantee holds only under default `package-lock` configuration.

Round-3 priorities:

1. **Is the reframed population 3 honest and complete?** It now claims a
   user-global npm `min-release-age` is the real control "where it reaches", with
   `cli_upgrade` gating as defence in depth, and `uv`, Homebrew and native
   self-update documented as uncovered. **Check that coverage claim.** Does a
   user-global npm floor actually apply to `npm install -g` run by an arbitrary
   agent, and to `scripts/host-upgrade.sh`? Name anything still miscategorised.
2. **Is any remaining recommendation similarly unenforceable?** Population 1 and
   population 2 were not scrutinised for bypass the way population 3 was. Apply
   the same test: what boundary must every path cross, and is there one?
3. **Hunt for remaining false claims.** Two rounds, four falsehoods. Assume a
   fifth. Every version, default, unit, npm behaviour, and repo code claim is
   fair game, including ones introduced by the rev-4 and rev-5 edits.
4. **Is the residual-risk section now complete**, given the bypass inventory and
   the `gateway-autoupgrade.timer` finding?
5. If you find nothing false, say so and approve. Do not manufacture a blocker.

### 4. What reviewers should attack (round 2, settled)

Round 1 is settled. Both blockers were verified independently and fixed, and the
round-1 questions are closed:

- claim C: correct for the seeds, now nuanced for the token-published worm phase
- claim B: core point stands, frequency claim retracted, and the "no integrity
  floor" assertion falsified and rewritten
- cooldown arithmetic: 09:35 publish, ~12:10 partial rollback, 1 day sufficient
  **for the seed wave**, now scoped
- `ignore-scripts`: confirmed effective against this `preinstall` payload
- population 3: no drift regression, but an enforcement gap was found
- four errors in the original that rev 1 missed, now recorded as E through J

**Do not re-litigate those.** Round 2 priorities:

1. **Are the two round-1 fixes correct and not over-corrected?** Specifically the
   Yarn table row (4.12 / `1d`) and the seed-versus-worm provenance scoping. Check
   the Yarn row against <https://yarnpkg.com/features/security> directly.
2. **Is the rewritten `npx` integrity claim now accurate?** Rev 3 says the
   integrity floor exists but is not consumer-controlled or reviewable before
   first materialisation. Verify against `~/.npm/_npx/` on this host and against
   npm's `libnpmexec` behaviour. Is there a case where no lockfile is written?
3. **Is the enforcement-gap fix sufficient?** Rev 3 says a real control must gate
   the `cli_upgrade` execution path, not just the `provider_version_guard`
   recommendation. **Find every other bypass path.** Candidates to check, not an
   exhaustive list: `provider_admin_run`, any tool that can shell out, direct
   `npm install -g` from an agent with bash access, `cli_upgrade` with an explicit
   `target`, and the systemd timer path. If the control can be trivially bypassed
   another way, say so, because the plan then needs a different shape.
4. **Hunt for remaining false claims.** Two review rounds on a sibling document
   each found exactly one falsehood; assume a third exists here until you have
   looked. Every factual assertion about tool versions, defaults, units, npm
   behaviour, and this repo's code is fair game.
5. **Is the plan's population split still right** now that drift coverage is known
   to be broader (startup probe plus systemd daily timer, not just
   `pre-release.sh`)?
6. **Anything still wrong in the original assessment** that neither round caught.

Approve only on what you inspected. End with UNCONDITIONAL APPROVAL or ONE
CONCRETE BLOCKER, named, with a file:line or source URL. No conditional
approvals.
