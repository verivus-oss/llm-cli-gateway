# Tracking Five Upstreams, Fuzzing the Parsers, and a Front Door: What Changed in llm-cli-gateway

*Published 2026-05-30 by VerivusAI Labs*

The last two posts were about features you can call: [cache-aware spawning](https://dev.to/wernerk_au/cache-aware-spawning-what-changed-in-llm-cli-gateway-a-week-on-1dle) across five providers, and the round before that. This one is mostly about the parts that do not show up as a tool. When you wrap five vendor CLIs that each ship on their own cadence, the interesting failure mode is not a bug in your code, it is one of those five CLIs quietly changing a flag underneath you. So the work that landed this week is about keeping pace with upstreams that move, hardening the bits that parse untrusted output, and — finally — giving the project a front door. v1.16.0 through v1.16.2 are tagged and out; the upstream-tracking and Socket-hardening work (changelogged as v1.17.0 and v1.17.1), plus a `fast-check` fuzzing pass and a dependency-floor bump, have landed on `main` and go out in the next cut; and the website is now live at [`llm-cli-gateway.dev`](https://llm-cli-gateway.dev/), the project's new front door.

**Short version:** the gateway now tracks each provider CLI's upstream contract as a checked-in artefact. The contract table is pinned by tests that run in CI, an offline `npm run upstream:contracts` gate re-validates it on demand, and an advisory `npm run upstream:scan -- --live` reaches out to the upstream changelogs to flag where reality may have moved — so drift surfaces in a check I run rather than as a failed request on a user's machine. A `fast-check` fuzzing pass now hammers the three parsers that touch untrusted bytes — provider JSON/JSONL, Linux `/proc`, and the CLI argument sanitizer. Release tags can be Sigstore-signed through a dedicated workflow, the optional Redis layer is gone, and on `main` the dependency floor has moved to Zod 4 / TypeScript 6 / ESLint 10. And there is now a real website at `llm-cli-gateway.dev`, built agent-first: an MCP client can read one URL and configure itself.

**Long version** is below, same shape as last time — problem, what changed, what it now does, caveats named up front rather than buried.

## Five upstreams that move (the contract-tracking slice)

The motivating incident is worth naming because it is the whole argument. Mistral's Vibe CLI dropped `--output-format` in favour of `--output text|json|streaming`. Nothing in the gateway's own code was wrong; the flag it had been emitting for weeks simply stopped existing on the other side of the `spawn`. v1.16.1 fixed the call (and kept the legacy MCP aliases mapping `plain` → `text` and `stream-json` → `streaming` so nobody's saved config broke), but a one-line flag rename that only surfaces as a runtime failure on a user's machine is exactly the class of problem I would rather catch in CI.

So the upstream-tracking work (changelogged as v1.17.0, landed on `main`) makes the contract a first-class, checked-in thing:

- Each supported CLI — `claude`, `codex`, `gemini`, `grok`, `mistral` — gets a **maintenance skill** describing where its truth lives (Claude Code's markdown changelog, Codex's GitHub releases feed plus product changelog, the Gemini CLI changelog, the xAI markdown release notes, and so on).
- The single source of truth for each provider's argv/env behaviour — flags, output modes, session/resume rules, forbidden flags — is the contract table in `src/upstream-contracts.ts`, exercised by the argument and env validators. Alongside it, `docs/upstream/provider-sources.dag.toml` is the scanner's **source map**: which changelog/release pages to watch, and how. The two are deliberately separate, and a test (`upstream-sources.test.ts`) pins that separation — the source map stays byte-for-byte in sync with the contract table's metadata, *and* the TOML is asserted **not** to re-encode the mechanical contract surface. Drift in the source map is a red build; the TOML is never the thing a flag rename has to round-trip through.
- `scripts/upstream-scan.mjs` backs two npm scripts. `npm run upstream:contracts` is an **offline** gate — it re-runs the bundled fixtures and the report/TOML-sync check, no network. `npm run upstream:scan` is network-free by default too; pass `--live` (`npm run upstream:scan -- --live`) and it fetches the tracked upstream changelogs and flags, advisorily, where reality may have moved ahead of us. (Neither is wired into the CI gate today — they're tools I run; the TS-contract-vs-source-map sync, however, *is* a CI test.)

The honest caveat: the live scan is advisory, not authoritative. It tells me where to look; it does not auto-patch a renamed flag, and it never will, because a CLI changing its surface is a thing a human should read and reason about, not a thing a script should silently paper over. What changed is that the looking is now systematic instead of "wait for a user to file an issue."

## Fuzzing the three parsers that touch untrusted bytes

A gateway that spawns five CLIs and reads back their output has a clear trust boundary: everything coming back over stdout/stderr is, from the gateway's point of view, untrusted. Most of it is well-formed. The interesting question is what happens when it is not. So `fast-check` is now wired into the suite (`src/__tests__/fuzz.test.ts`), and it targets the three places where malformed input would actually hurt:

- **Provider JSON / JSONL parsers** — fuzzed with mixed valid-and-garbage JSONL streams, asserting the parser never throws and never leaks an invalid result shape. A provider emitting a half-written line during a crash should degrade, not propagate a malformed object upward.
- **Linux `/proc` parsers** — the process-health monitor reads `/proc/<pid>/stat` (state and CPU ticks) and `/proc/<pid>/status` (`VmRSS`) to track a spawned child's health. The property here is that no garbage `/proc` content ever produces a `NaN` process metric.
- **CLI argument sanitizer** — the property is blunt and important: a dash-prefixed value is *always* rejected. That is the argument-injection guard. The gateway never invokes a CLI with `shell: true`, but a caller-supplied value that starts with `-` and slips into the argv array could still be read by the child as a flag rather than a value. The fuzzer's job is to make sure there is no input string that gets past that check.

These are properties, not examples — `fast-check` generates the adversarial inputs rather than me guessing them, which is the point. I am not claiming the parsers are now proven correct; I am claiming the obvious classes of malformed input are exercised on every run instead of on the day a provider ships a bad build.

## Signed tags, a smaller surface, a newer floor

A few things in the supply-chain and dependency layer, none of which is a feature, all of which is worth naming.

**Sigstore tag signing.** The npm publishes already carry sigstore provenance via the OIDC publish path. Since the 1.16.0 cycle the release *tags* themselves can get the same treatment through a dedicated, manually-triggered `sigstore-tag.yml` workflow (a `workflow_dispatch`, run deliberately against a named tag rather than firing automatically on every release) that recreates the tag with a gitsign signature, pinned to the exact commit SHA it must continue to point at, and run in offline Rekor mode. The git history of a release can be made as verifiable as the published artefact.

**Socket `shellAccess`, documented rather than waved away.** The gateway's entire reason to exist is launching child processes, so Socket flags it on every release. Rather than ignore the alert, v1.17.1 suppresses it *in `socket.yml` with a written rationale* and keeps the bounded shell-access explanation in the README, so a reviewer still sees the reasoning without seeing the same noisy alert on every version bump. The distinction matters: a suppressed alert with a checked-in justification is auditable; a suppressed alert with no paper trail is just hidden.

**One fewer optional dependency.** v1.16.0 removed the optional Redis/ioredis layer from the PostgreSQL-backed session manager. It was a lever almost nobody pulled, and every optional dependency is a maintenance and supply-chain cost you pay whether or not you use it. The Postgres path is simpler and the dependency surface is smaller.

**A newer floor.** On `main`, ahead of the next release, the toolchain moved up in lock-step — Zod 4, TypeScript 6, ESLint 10 (with the lint-config migration that 10 forces), `@types/node` 25 — plus a dead-code sweep that the new compiler and lint settings surfaced. (These are not in the v1.17.x packages yet; they go out in the next cut.) Unglamorous, and exactly the kind of thing that rots if you let it slide for two majors.

## A front door (the website)

Until this week the project's front door was a GitHub README and an npm page. Now there is [`llm-cli-gateway.dev`](https://llm-cli-gateway.dev/), live as of this post, and the interesting design decision is that it is built **agent-first**.

The premise: increasingly the thing evaluating whether to install an MCP server is not a human reading marketing copy, it is an agent reading a URL. So the site treats that as the primary path, not an afterthought:

- `/install.md` is agent-readable install instructions in plain markdown — the homepage's headline call to action is literally *"Read https://llm-cli-gateway.dev/install.md and configure yourself to use llm-cli-gateway as an MCP server."*
- `/llms.txt` is the compact retrieval entry point, and `/.well-known/agent.json` is structured metadata (registry name `io.github.verivus-oss/llm-cli-gateway`, transport, launch command) that a tool can parse without scraping HTML.
- A `/sitemap.md` ties the three together for anything doing retrieval.

The human-facing side is deliberately boring in the ways that matter: it is a static Cloudflare Pages site (`wrangler.toml`, output dir `site/`), ships a strict Content-Security-Policy with `script-src 'self'`, `frame-ancestors 'none'` and friends in `_headers`, and the JavaScript makes **no external or network calls** — no analytics, no third-party fonts loaded at runtime, nothing phoning home. For a project whose whole pitch is "the CLIs keep their native credentials and run locally," a marketing site that quietly loaded a tracker would have undercut the argument. So it does not.

Caveat, because there is always one: the site is new, and the agent-install path is only as good as the install spec behind it. `npx -y llm-cli-gateway` over stdio is the whole launch surface, and the install doc is versioned in the repo alongside the code, so it moves when the code moves.

## What's next

More providers will drift — that is a certainty, not a risk — so the next iteration of the upstream scan is making the advisory live check something a scheduled job runs and reports, rather than something I remember to run. And the fuzzing pass is deliberately narrow right now (three parsers); the session-store and config-loader paths are the obvious next targets once the current properties have a few weeks of green runs behind them.

Thanks for reading this far. As always, MIT licensed.

---

*llm-cli-gateway is MIT licensed. Website: [llm-cli-gateway.dev](https://llm-cli-gateway.dev/) | npm: `llm-cli-gateway` | GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)*
