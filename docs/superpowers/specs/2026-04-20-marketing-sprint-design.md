# Marketing sprint — Werner-brand relaunch of llm-cli-gateway + sqry

**Date:** 2026-04-20
**Author:** Werner Kasselman (with Claude Opus 4.7)
**Status:** Design approved; ready for implementation plan
**Sprint window:** 2026-04-20 → 2026-05-04 (retro)
**Parked work returned to after sprint:** `docs/superpowers/parked/2026-04-20-byo-server-brainstorm-notes.md`

## 1. Vision

A clean personal-brand (Werner Kasselman, @wernerk_au) relaunch of both `llm-cli-gateway` and `sqry`, with a minimal automation stack (Typefully + Publer) so the distribution layer is repeatable after the sprint ends.

The first launches of both projects under the `verivusossreleases` corporate handle under-performed (3 stars, ~400 npm downloads, 218 dev.to views across 5 articles, 0 inbound issues after three weeks). Diagnosis: the corporate-handle tax on dev-tool OSS is predictable — dev communities engage with people, not brands. Every successful dev-tool project (Simon Willison's Datasette/llm, Andrej Karpathy's work, Harrison Chase → LangChain, Paul Copplestone → Supabase) started person-fronted; brand layers on after a person-shaped audience exists.

This sprint reverses the polarity: Werner becomes the visible maintainer and authorial voice; Verivus stays the GitHub org and project umbrella.

## 2. Goals and success criteria

**Goal:** Execute a coordinated 2-week personal-brand relaunch of both projects with a Tue + Thu double Show-HN launch, three dev.to feature articles, two screencast demos, and a stood-up automation pipeline.

**v1 success metrics (measured at retro, Mon 2026-05-04):**

| Metric | Baseline (2026-04-20) | Sprint target | Stretch |
|---|---:|---:|---:|
| GitHub stars (llm-cli-gateway) | 3 | 100 | 500+ |
| GitHub stars (sqry) | 15 | 75 | 300+ |
| GitHub forks (sqry) | 1 | 5 | 20+ |
| npm weekly downloads (llm-cli-gateway) | ~60 | 400 | 1500+ |
| GitHub release downloads (sqry) | TBD — measure Day 1 via `gh api` | 200 | 1000+ |
| Inbound issues from strangers (both) | 0 | 3+ combined | 10+ |
| Werner X followers | TBD — measure Day 1 | +200 | +800 |
| HN front-page moments | 0 | 1 of 2 lands | Both land |

These are *process* targets. Meeting them means the sprint executed well. Failing most of them means the positioning or hook needs a rethink before doubling down — explicitly, it does not mean "launch harder."

## 3. Constraints and non-goals

**Constraints:**
- Werner is available after-hours and weekends (ServiceNow is the day-job, separate and not referenced in any marketing material)
- Budget: up to $30/mo ongoing for SaaS tooling
- On-camera video is acceptable
- Personal-brand voice (Werner, first-person); Verivus umbrella remains but corporate voice retires

**Explicit non-goals:**
- Building the BYO-server v2 (parked — see `docs/superpowers/parked/2026-04-20-byo-server-brainstorm-notes.md`)
- Building custom marketing automation beyond Typefully + Publer
- Podcast / conference CFP outreach (longer lead time; follow-up phase)
- Rewriting all five existing Verivus dev.to articles — rewrite top-two only
- Landing Simon Willison's endorsement — a low-cost bet, not a dependency

## 4. Schedule

Today is Monday 2026-04-20.

| Date | Day | Focus | Hard deliverable |
|---|---|---|---|
| Mon 04-20 | Today (evening) | Typefully + Publer signup; X bio; LinkedIn update; `werner.dev` landing stub; connect accounts | Tooling live |
| Tue 04-21 | Weekday evening | Finalize content plan; rewrite README top-fold in Werner-voice; script video 1 | Video 1 script |
| Wed 04-22 | Weekday evening | Record + edit video 1 (llm-cli-gateway; Linux-distro workflow demo) | Video 1 final |
| Thu 04-23 | Weekday evening | Record + edit video 2 (sqry; "ask any codebase") | Video 2 final |
| Fri 04-24 | Weekday evening | First-person rewrite of `blog-cli-vs-api.md`; canonical URL setup | Article 2 final |
| Sat 04-25 | Weekend | Draft Linux-distro article from transcript; write HN/Reddit/X/LinkedIn launch copy for both products | Article 1 final; all launch copy |
| Sun 04-26 | Weekend | Pre-schedule everything in Typefully + Publer; send Simon Willison DM; submit to `mcp.directory`, `glama.ai`, `smithery.ai`, Anthropic MCP Discord `#showcase` | Launch queue populated |
| Mon 04-27 | Weekday evening | Sanity checks; notify 3-5 friends/allies for genuine comment engagement (not upvotes) | Dry-run pass |
| **Tue 04-28** | **Weekday** | **9am ET Show HN llm-cli-gateway** → automated burst (Reddit r/ClaudeAI, r/LocalLLaMA, r/selfhosted; X thread; LinkedIn) → live engagement 9am-12pm ET | Launch 1 |
| Wed 04-29 | Weekday | Follow-up X thread ("day-after learnings"); reply to everything inbound | Day-2 content |
| **Thu 04-30** | **Weekday** | **9am ET Show HN sqry** → burst (r/programming, r/rust, r/MachineLearning, r/LocalLLaMA; X thread; LinkedIn) → live engagement | Launch 2 |
| Fri 05-01 | Weekday evening | Cross-pollination thread ("why I shipped both in the same week"); inbound catch-up | Synthesis content |
| Sat 05-02 | Weekend | Buffer / catch-up | — |
| Sun 05-03 | Weekend | Retro notes; Typefully drumbeat schedule for next 4 weeks | Drumbeat queued |
| **Mon 05-04** | **Weekday** | **Retro** — metrics vs targets; post-sprint decision | Decision logged |

**Why this shape:**
- 7 days prep / 7 days launch — visible launch in the back half; no arriving-tired
- Tue + Thu Show HN slots — standard best-days; 48h separation so launch 1's outcome doesn't dilute launch 2
- Wednesday isn't empty — it's the follow-up-content day; day-after threads land better than launch threads
- Simon Willison DM sent Sunday 04-26, before launches — if he engages, it amplifies; timing that ask for after launch is much weaker

## 5. Content inventory

### 5.1 Critical-path deliverables

| # | Asset | Owner | Why |
|---|---|---|---|
| 1 | Personal-brand infrastructure (X bio, LinkedIn, `werner.dev` landing stub linking both repos) | Werner | Pre-req for everything else |
| 2 | Typefully + Publer signup, account connections, token store | Werner | Distribution layer |
| 3 | **Article: "I Used 3 LLMs to Pick My Next Linux Distro (And Codex Caught Issues I Missed)"** — first-person from the research transcript; includes the BLOCKER/MAJOR review table as proof | Werner + Claude-drafts | Featured launch-day article for llm-cli-gateway. Non-dev use case broadens audience. Real stakes, real rigor. |
| 4 | Video 1: llm-cli-gateway screencast (8–12 min; Werner on camera in intro/outro) — walks through the Linux-distro multi-LLM workflow as it happened | Werner (camera), Claude (edit pass) | Embeds in HN, Dev.to, X, LinkedIn |
| 5 | Video 2: sqry screencast (6–10 min) — "ask any codebase a question" on a real OSS repo | Werner (camera), Claude (edit pass) | Embeds in HN, Dev.to, X, LinkedIn |
| 6 | First-person rewrite of `blog-cli-vs-api.md` (CLI-wrapping-vs-API-proxying philosophy) | Werner + Claude-drafts | Depth piece for launch day; canonical from Verivus version |
| 7 | Launch-day copy: Show HN hooks (both products), 3-4 Reddit variants per product, X threads, LinkedIn posts, Bluesky posts | Werner + Claude-drafts | The launch artefacts |

### 5.2 Nice-to-have (bump to Week 2 if Week 1 runs over)

| # | Asset | Why |
|---|---|---|
| 8 | First-person rewrite of `blog-codex-review-gate.md` | Second-day content; builds conversation after launch |
| 9 | Short sqry demo article (≤2000 words) — "I indexed the Anthropic SDK and asked it dumb questions" | sqry launch-day companion post |
| 10 | Directory submissions: `mcp.directory`, `glama.ai`, `smithery.ai`, Anthropic MCP Discord `#showcase` | Passive discovery |
| 11 | Simon Willison DM (see §9 appendix for draft) | High-leverage low-cost bet |

### 5.3 Content-to-channel matrix

| Core asset | Primary | Cross-posted to |
|---|---|---|
| Linux-distro article | Dev.to (Werner) | HN Show HN links to it + repo; Reddit r/linux, r/selfhosted, r/homelab, r/LocalLLaMA; X thread w/ key table; LinkedIn; Hashnode mirror |
| CLI-vs-API rewrite | Dev.to (Werner) | Reddit r/ClaudeAI, r/programming; X; LinkedIn |
| Video 1 | YouTube | Embed in HN, Dev.to, X clip (≤60s), LinkedIn clip, Reddit |
| Video 2 | YouTube | Same fanout pattern |
| Show HN llm-cli-gateway | HN | Tue 04-28 9am ET; immediately followed by Reddit + X + LinkedIn burst (Typefully-scheduled, publishes together) |
| Show HN sqry | HN | Thu 04-30 9am ET; same burst pattern |

## 6. Launch mechanics

### 6.1 Tooling setup (Mon 04-20 evening, ~2 hours)

1. **Typefully** signup → connect X, Bluesky, Threads, LinkedIn. $12/mo starter.
2. **Publer** signup → connect Reddit (target subs), Dev.to, Mastodon, Hashnode. $10/mo starter.
3. Create Dev.to account under Werner if not exists; verify cross-post from Publer works; set canonical URLs on rewritten articles so old Verivus posts don't cannibalise.
4. X bio: short one-liner, pinned tweet = short screen clip of llm-cli-gateway.
5. LinkedIn: same philosophy.
6. `werner.dev` landing page — minimal: name, 2 project cards, X/LinkedIn/GitHub links. GitHub Pages or Cloudflare Pages. Do not over-build.

### 6.2 Show-HN rules (non-negotiable)

- Post manually, 9am ET, Tuesday (llm-cli-gateway) and Thursday (sqry)
- Title prefix `Show HN:` — read [HN guidelines](https://news.ycombinator.com/showhn.html) first
- Do NOT ask friends to upvote — HN detects coordinated voting and kills posts
- DO ask 3-5 friends to comment genuinely — comments drive ranking, aren't detected as manipulation
- Werner live on HN for 3 hours post-submit, replying to every top-level comment within 15 minutes
- If the post stalls (no momentum at 30 min), do NOT re-submit the same day; wait a week, different hook

### 6.3 Reddit rules (non-negotiable)

- Post to each sub with sub-specific framing (not the same HN title copy-pasted — auto-removed as spam)
- Include one original insight per sub that's not in the HN post
- Engage replies within the first hour; Reddit's algorithm punishes drive-by posting
- Don't link to your HN post in Reddit comments — mods read as cross-promotion

### 6.4 Live-engagement calendar commitment

- **Tue 04-28, 9am–12pm ET**: HN + Reddit live engagement. Non-delegable. Block the calendar.
- **Thu 04-30, 9am–12pm ET**: Same for sqry.
- **Both days after 12pm ET**: Inbound reply triage for the rest of the day at 2× daily checkpoints (1pm, 6pm).

### 6.5 ServiceNow day-job mitigation

- All public content attributed: Werner Kasselman, independent OSS developer, after-hours work
- No ServiceNow name, logo, or employment reference in any marketing material or comment reply
- Honest answer if asked in public: "I work in security/engineering elsewhere; these are my personal projects"
- `views-are-my-own` line in X bio and both repo READMEs

## 7. Measurement

A script at `llm-cli-gateway/scripts/sprint-metrics.sh` pulls daily:

- GitHub stars / forks / issues / PRs (via `gh api`) for both repos
- npm weekly downloads for llm-cli-gateway (via `api.npmjs.org`)
- GitHub release download counts for sqry (via `gh api /repos/verivus-oss/sqry/releases`) — sqry distributes as a Rust CLI binary via GitHub releases, not PyPI or crates.io
- Dev.to article views / reactions / comments (via Dev.to API, `devto-api-key` in `verivus-dev-secrets-kv`)
- X follower count + last-thread impressions (manual export from X Analytics)
- Reddit post scores + comment counts (via Reddit's JSON endpoints)
- HN post rank + comment count (via Algolia HN search API)

Output appended to `docs/superpowers/sprint-log.md`. Five minutes to maintain; provides retro-ready history.

### 7.1 Daily checkpoints during sprint

| Day | Checkpoint question | Action if failing |
|---|---|---|
| Wed 04-22 | Video 1 recorded? | Shrink to 6 min; ship rough |
| Fri 04-24 | Both videos done + 1 article drafted? | Cut article 2 from critical path |
| Sun 04-26 | All launch posts pre-scheduled in Typefully + Publer? | Delay launch by 24h rather than launch unprepared |
| Tue 04-28 3pm ET | Show HN still active (not flagged/buried)? | If buried, save Reddit + X burst for Wed fresh |
| Thu 04-30 3pm ET | Same for sqry | Same |
| Mon 05-04 | Retro — targets hit, near, missed? | Next-phase decision (§10) |

## 8. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Both HN launches flop | Moderate | Videos + articles are permanent assets; switch to drumbeat phase (2-3 posts/week for 4 weeks) |
| Video recording takes 2× expected | High | Record rough takes only; `claude_request` edits the transcript after if needed |
| Simon Willison doesn't reply | Very high | No-cost bet; don't build expectations on it |
| Werner burns out mid-sprint | Moderate | Sat 05-02 explicit buffer; sprint ends Sun 05-03; no content scheduled past retro until momentum observed |
| Reddit mods remove posts as self-promotion | Moderate | Read each sub's sidebar first; value-in-body > links; don't link own HN thread in Reddit |
| Day-job connection accidentally surfaces | Low | Nothing in materials references employer; "personal project, built after-hours, views are my own" disclaimer in bio and READMEs |
| Launch day coincides with competing AI launch (model release, Anthropic news) | Moderate | Monitor news Mon 04-27; if massive news drops, bump launch 24-48h |

## 9. Appendices

### 9.1 Simon Willison DM draft (send Sunday 04-26)

> Hi Simon — Werner here. Long-time reader of your `llm` posts; they shaped a lot of how I think about tool design.
>
> I built an `llm` plugin that bridges your tool into [llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway), an MCP server I've been working on that orchestrates Claude Code, Codex, and Gemini CLIs. The plugin lets `llm` users drive multi-LLM workflows directly — e.g. `llm review codebase.py` fans out to all three CLIs via MCP.
>
> Code's at `integrations/llm-plugin/` in the repo. No asks — just wanted to let you know it exists, and happy to take feedback any time you happen to look.
>
> — Werner

92 words. Send from Werner's personal X DMs or `simon@simonwillison.net`. No follow-up.

### 9.2 Show HN titles — draft copy for review

- **llm-cli-gateway (Tue 04-28):** *"Show HN: llm-cli-gateway – an MCP server that orchestrates Claude, Codex, and Gemini CLIs"* (60 chars)
- **sqry (Thu 04-30):** needs to be a **usage launch**, not a project announcement — sqry's first Show HN ran 2026-03-06 (5 pts, 1 comment; [item 47282106](https://news.ycombinator.com/item?id=47282106)). HN discourages vanilla resubmits. Draft: *"Show HN: I indexed the Anthropic SDK with sqry and asked it questions"* — frame as a *thing I did with the tool*, not a tool announcement. If mods flag it, fall back to Reddit + X + LinkedIn primacy for sqry and preserve the next HN slot for a genuine major-version moment.

### 9.3 Role split

- **Werner:** brand infrastructure setup, camera recording, final editorial sign-off, live launch-day engagement (non-delegable)
- **Claude (me):** first drafts of articles from transcripts and existing material, edit passes, HN/Reddit/X/LinkedIn copy variants, scheduling-queue population, directory submission text, Simon Willison DM draft, daily metrics script

## 10. Post-sprint decision (Mon 05-04 retro)

| Result | Action |
|---|---|
| Either launch lands (100+ stars, >30 comments, real strangers filing issues) | Double down on the winner. Spend 2 weeks building out its top-requested features — which might be BYO-server, but might be something else. Let user feedback reshape scope. |
| Both launches flop; dev.to + YouTube content performs well | Drumbeat phase — 4 weeks of 2-3 posts/week using the same automation stack. No new features until traction curve bends. Second launch attempt end of June with revised hooks. |
| Both launches flop; content doesn't move | Product re-examination required. Positioning may be wrong, or value prop isn't compelling to the reached audience. Strategic brainstorm, not execution. Don't "try again harder." |
| Launches land AND useful user feedback comes in | **Informed BYO-server resume.** Read `docs/superpowers/parked/2026-04-20-byo-server-brainstorm-notes.md`; adjust scope based on user asks; resume brainstorm at "Present design sections." |

---

## 11. References

- **Parked BYO-server design:** `docs/superpowers/parked/2026-04-20-byo-server-brainstorm-notes.md`
- **Existing Verivus-voice launch content:** `docs/launch/` (5 files — top-2 to be rewritten in Werner-voice)
- **Linux-distro research transcript (source for featured article):** `/home/werner/.claude/projects/-home-werner/ec852be9-6642-4f17-9ade-8b291b3c77ee/tool-results/2026-04-20-080114-Research-Linux-distros.txt`
- **Dev.to API key:** `devto-api-key` in `verivus-dev-secrets-kv` (Azure)
- **Dev.to existing posts to republish/canonicalise:** `https://dev.to/verivusossreleases` (5 published 2026-03-31 → 2026-04-16)
- **HN Show HN guidelines:** https://news.ycombinator.com/showhn.html
