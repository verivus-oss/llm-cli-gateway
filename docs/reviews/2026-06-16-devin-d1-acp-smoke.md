# Slice D1 — Devin native ACP smoke evidence

**Date:** 2026-06-16
**CLI:** `devin 2026.5.26-8 (1a388fa9)`, installed at `~/.local/bin/devin`, authenticated via `devin auth login` (org "My Team", account werner@verivus.com).
**Entrypoint under test:** `devin acp` (native ACP server over stdio JSON-RPC).

## Method
Drove the `devin acp` stdio server directly with line-delimited JSON-RPC 2.0:
an `initialize` request, then a `session/new` request. The server is long-lived
(it does not exit on EOF), so the run was reaped by a timeout after the
responses arrived — exit 124 is expected and is not a failure.

(Print-mode was also confirmed end to end beforehand: `devin -p "Reply with
exactly one word: pong"` returned `pong`, exit 0 — validating the Slice D0
runtime path against the live authenticated CLI.)

## Request 1 — `initialize` (client → agent)
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}
```

### Response (agent → client) — PASS
```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":false,"sse":false},
    "sessionCapabilities":{"list":{},"additionalDirectories":{}},
    "_meta":{"cognition.ai/multiRootWorkspace":true,"cognition.ai/sessionRename":true,"cognition.ai/documentLifecycle":true}
  },
  "authMethods":[{"id":"windsurf-api-key","name":"API Key","description":"Authenticate with your API key"}],
  "agentInfo":{"name":"affogato","title":"Affogato Agent","version":"0.0.0-dev"}
}}
```

Key confirmations:
- `protocolVersion: 1` — matches `ACP_ENTRYPOINT_CONTRACTS.devin` / the registry entrypoint.
- `loadSession: true` — native session resume is advertised.
- `authMethods: [windsurf-api-key]` — matches the caveat (WINDSURF_API_KEY for empty-env; stored CLI creds used here because we are logged in).
- `agentInfo.name: "affogato"` — Cognition's agent codename.
- `mcpCapabilities`: `http:false, sse:false` — the Devin ACP agent does not accept HTTP/SSE MCP servers (stdio MCP only). Noted for future runtime wiring.

## Request 2 — `session/new` (client → agent)
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}
```

### Response (agent → client) — PASS
A session was created (`sessionId` assigned), with the available session modes
and config options returned, preceded by streamed `session/update`
notifications (`config_option_update`, `current_mode_update`,
`available_commands_update`):
```json
{"jsonrpc":"2.0","id":2,"result":{
  "sessionId":"<assigned>",
  "modes":{"currentModeId":"accept-edits","availableModes":[
    {"id":"accept-edits","name":"Code"},
    {"id":"ask","name":"Ask"},
    {"id":"plan","name":"Plan"},
    {"id":"bypass","name":"Bypass Permissions"}
  ]},
  "configOptions":[
    {"id":"mode","category":"mode",...},
    {"id":"model","category":"model","currentValue":"swe-1-6-slow","options":[{"value":"swe-1-6-slow","name":"SWE-1.6 Slow"}]}
  ]
}}
```
Server log: `Created new session: <id>` / `Saved 2 message nodes for session <id>`.

Key confirmations:
- `session/new` creates a real session and returns a `sessionId` — the resume surface is live.
- ACP session modes are `accept-edits` / `ask` / `plan` / `bypass` (distinct from the CLI `--permission-mode normal/dangerous` set; the ACP transport exposes its own mode vocabulary).
- On the Free plan only `swe-1-6-slow` (SWE-1.6 Slow) is offered — consistent with "limited model availability".

## Verdict
Native `devin acp` ACP smoke **PASSED** (initialize + session/new). On this
evidence Slice D1 promotes Devin from `native_candidate` to
`native_smoke_passed` with `shipRuntimePilot: true` (third pilot after
mistral, grok). Live runtime routing stays disabled by default
(`runtimeEnabledDefault: false`), identical to every other provider — the
gateway's ACP runtime is still config-gated (Phase A dormant).
