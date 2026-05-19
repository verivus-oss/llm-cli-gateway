# Three Things That Have Changed Since "Why CLI Wrapping Beats API Proxying"

*Published 2026-05-19 by VerivusAI Labs*

A few weeks ago I wrote [Why CLI Wrapping Beats API Proxying for Multi-LLM Development](./blog-cli-vs-api.md), the case for spawning `claude`, `codex`, and `gemini` as child processes instead of proxying to their APIs. Three things have changed since I published that piece. Two of them fix real limitations I named at the time, and one of them is a new capability that I wish had been there from the start. Worth a follow-up.

## Codex sessions are now real, not bookkeeping

In the original post I said llm-cli-gateway uses real CLI continuity flags, "`--continue` and `--resume`, not bookkeeping". That was true for Claude and Gemini. For Codex it was, frankly, a half-truth.

Codex did not have a documented resume mechanism at the time. So when you opened a Codex session through the gateway, the session record was real (UUID, created/lastUsed timestamps, the active-session-per-CLI invariant) but the `codex` process itself started fresh on every request. The gateway tagged subsequent requests as belonging to a session, you could see the session in `session_list`, but Codex did not know that.

Codex shipped `exec resume <session-id>` and `exec resume --last`, and the gateway now wires both. If you pass a real Codex session UUID (the kind that lives in `~/.codex/sessions/`), `codex_request` invokes `exec resume` and you get genuine continuity, the same tool-use history, file context, and partial work the CLI itself preserves. `resumeLatest: true` pins to the most recent session without you having to look the UUID up.

Two caveats worth naming up front. First, only real Codex UUIDs are accepted, gateway-issued `gw-*` IDs are rejected on resume, because there is no Codex-side session for them to attach to. Second, `--full-auto` is dropped on resume, which is a Codex constraint and not something the gateway can paper over. The trade-off is reasonable, you keep the continuity, you restate the approval policy.

Codex now sits where Claude and Gemini sit. The bullet that said "Session continuity using real CLI flags, not bookkeeping" is now true for all of them.

## Grok makes four, on purpose

xAI shipped an official Grok CLI (the `grok-build` TUI) and we added it as the fourth provider. The tools mirror the others one-for-one, `grok_request` and `grok_request_async`, sessions through `--resume` / `--continue`, model registry entries, self-update via `grok update`, the same circuit-breaker and approval-gate plumbing, the same flight recorder, the same metrics. Auth follows the same shape, a prior `grok login` (OAuth) or a `GROK_CODE_XAI_API_KEY` environment variable, with `GROK_DEFAULT_MODEL`, `GROK_MODELS`, and `GROK_MODEL_ALIASES` all honoured.

The interesting question is not whether to add Grok (the parity work is mechanical) but why. The case is consensus diversity.

Claude, Codex, and Gemini cover Anthropic, OpenAI, and Google. That lineup is well-suited for parallel review work, but it is three of the same kind of organisation, three model families that share a lot of training data lineage and a lot of post-training tendencies. When you ask all three to red-team the same change, the disagreements are real, but the agreements are sometimes less informative than they look, because you are sampling three points from a narrower distribution than the org names suggest.

Grok's training lineage sits outside the OpenAI/Anthropic/Google adjacent triangle. So when a four-way consensus check returns 4/4 agreement on a security finding, the signal is stronger than 3/3. And when Grok dissents alone, that is a data point worth reading, not a vote to discard. The value is not that Grok is better at reviews than the others (I do not believe that, and the workflows do not assume it). The value is independence.

## Durable job results and auto-dedup

This is the change that came from running the gateway against real work for a few months and watching the same failure happen over and over.

The original architecture had a soft spot. Async jobs run long, sometimes longer than the orchestrating agent's polling window. The agent gives up, reissues the request, and the whole Codex or Claude invocation starts over. The CLI work you just paid 90 seconds for is thrown away and replaced with a second 90-second run that does exactly the same thing. I lost track of how much wall time this cost me before we sat down and fixed it properly.

The fix is two pieces, both wired into the existing flight recorder SQLite database at `~/.llm-cli-gateway/logs.db`:

- **Every async job persists** to a new `jobs` table on every state transition (start, throttled output flush, completion). `llm_job_status` and `llm_job_result` transparently fall back to the durable store when the in-memory job is gone, so a caller can collect a result regardless of how long ago the work finished. Retention defaults to 30 days, configurable via `LLM_GATEWAY_JOB_RETENTION_DAYS`. Jobs still "running" when the gateway stops are marked `orphaned` on next boot, and the partial output stays readable.
- **Identical requests within a dedup window short-circuit** onto the existing running or completed job. The default window is 1 hour, configurable via `LLM_GATEWAY_DEDUP_WINDOW_MS`. The "polling timed out, reissue, run it all again" loop is structurally gone. For the case where the prior result is actually wrong and you want a fresh invocation rather than a re-attach, every request tool accepts `forceRefresh: true`.

The change moves the gateway closer to what I wanted it to be from the start, a durable result-collection layer for CLI agents rather than a thin process spawner that hopes the caller is still listening when the CLI finishes. 20 new tests cover persistence, dedup, restart-orphan, retention, and Grok parity, and the full suite passes at 322 tests.

## What this changes about the original argument

Nothing, actually. The thesis from the first post still stands, that CLI wrapping gives you capabilities (real file access, real test execution, real session state) that API proxying fundamentally cannot. These three updates strengthen the same case rather than contradict it.

What they fix is the gap between the thesis and the implementation. Codex sessions now carry the same real-CLI continuity as Claude and Gemini. The consensus pattern now has a fourth, vendor-independent voice. And the long-running-job failure mode that always threatened to undercut the whole CLI-spawning approach is gone, because the result lives on disk regardless of who is or is not still polling for it.

If you are evaluating llm-cli-gateway against an API proxy, the comparison is slightly different now than it was in March, on three specific axes. That seemed worth writing down.

---

*llm-cli-gateway is MIT licensed. npm: [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway) | GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)*
