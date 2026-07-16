---
name: public-demo-session
description: Prepare and drive clean public llm-cli-gateway demo sessions for recordings, README demos, screenshots, or transcripts. Use when the user needs a redacted path, compact Codex output, direct provider calls, or a demo-safe Codex environment.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Public Demo Session

Use this skill when the goal is a public recording, README demo, screenshot, or clean transcript. The priority is a short, reliable demo surface, not exhaustive orchestration.

## Goals

- Show only a public-safe workspace path such as `/llm-cli-gateway`.
- Keep the llm-cli-gateway MCP server and workspace skills available.
- Prefer direct, synchronous provider calls that return compact text.
- Avoid validation wrappers, async polling, nested Codex, and repeated stuck-job polling unless the user explicitly asks for those features.

## Full-access review handoff

A public demo is not a review shortcut. If the user explicitly asks for a
full-access, native-MCP, evidence-backed review, leave demo mode and follow the
`multi-llm-review` full-access protocol. Build the exact target checkout and
launch `node dist/index.js --transport=stdio` from it, rather than using a demo
or globally installed gateway. Reapply the provider-native grant per new job,
send the corrective-program verification report and exact diff/file identity,
require independent code/docs/tests inspection, set no caller caps, and honor a
user-required 90-second progress cadence. Do not use direct provider calls or a
public demo home as a substitute for that review path.

## Path Hygiene

Do not start Codex directly from an internal checkout path for public demos. A symlink may still leak a resolved path in some tools. Prefer a bind-mounted public path:

```bash
bwrap \
  --bind "$REAL_REPO" /llm-cli-gateway \
  --chdir /llm-cli-gateway \
  --setenv CODEX_HOME "$DEMO_CODEX_HOME" \
  codex --dangerously-bypass-approvals-and-sandbox
```

If the host needs Codex HTTPS/WebSocket support inside the mount namespace, bind the host CA backing store too. On this host `/etc/ssl/certs` depends on `/var/lib/ca-certificates`.

The demo `CODEX_HOME` should have a minimal `config.toml` with:

```toml
model = "gpt-5.5"
model_reasoning_effort = "high"
project_doc_max_bytes = 0

[projects."/llm-cli-gateway"]
trust_level = "trusted"

[mcp_servers.llm-gateway]
command = "node"
args = ["/llm-cli-gateway/dist/index.js"]
```

Keep the demo home separate from the normal Codex home. Symlink `auth.json` from the normal Codex home if needed, but do not copy private history or sessions.

## Demo Dispatch Defaults

For simple “ask the other LLMs” demo prompts, use direct provider tools:

```js
claude_request({ prompt: "...", outputFormat: "text" });
gemini_request({ prompt: "...", outputFormat: "text" });
mistral_request({ prompt: "...", outputFormat: "text", trust: true });
```

Provider-specific notes:

- Do not pass `maxTurns` to `claude_request` unless the current schema explicitly supports it.
- Do not pass `skipTrust:true` to Gemini/Antigravity: the current gateway path
  rejects it. Establish the intended workspace/project trust before recording.
- Pass `trust:true` to Mistral/Vibe for the same reason.
- Avoid `grok_request` in demos unless the user explicitly names Grok and the local Grok CLI has been checked in this environment.
- Avoid `codex_request` from inside a Codex demo unless the user explicitly asks for nested Codex.

## Avoid In Demo Mode

Do not use these by default for a public demo prompt:

- `ask_model`
- `validate_with_models`
- `compare_answers`
- `consensus_check`
- `second_opinion`
- `red_team_review`
- `synthesize_validation`
- `*_request_async`
- `llm_job_status`, `llm_job_watch`, `llm_job_result`, `llm_job_cancel`
- web search, unless the user explicitly asks for live verification

If a provider fails, state that briefly and continue with useful returned outputs. Do not turn a short demo into a recovery workflow.

## Quick Verification

Before recording:

```bash
codex doctor --summary --no-color
```

Expected: MCP server present, WebSocket connected, provider endpoints reachable, and `0 warn · 0 fail`.

Confirm the opening screen shows:

```text
directory: /llm-cli-gateway
```
