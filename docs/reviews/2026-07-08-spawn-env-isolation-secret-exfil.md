# Spawn-env isolation: hostile-provider secret-exfil hardening

Date: 2026-07-08
Issue: #153
Status: opt-in, default off. Cross-LLM reviewed (round 1 applied).

## Motivation

Public research (N. Benkovich, citing Agyn) describes an exfiltration class
against LLM coding-agent CLIs: route an agent (Claude Code / Codex / opencode)
through an **untrusted LLM provider or proxy**, have that endpoint inject a tool
call into its response (e.g. "read `.env`"), and the agent executes it locally
and exfiltrates the result. His remediation: treat the provider as part of the
agent control plane, isolate the agent, and strip credentials.

This review asks whether `llm-cli-gateway` can be coerced into that pattern, and
hardens the one place where it partially can.

## Findings

### API-provider surface (OpenRouter / OpenAI-compatible HTTP): not exploitable

- No tool-call / function-call handling exists anywhere in `src/` (grep for
  `tool_calls|function_call|toolCalls|functionCall` = 0 hits). Each adapter's
  `parseResult` extracts only text; `tool_use` blocks are filtered out
  (`src/api-provider.ts:165-188`, `240-260`, `284-301`).
- `base_url` is operator TOML config, never a caller/request parameter
  (`src/api-request.ts:99-102`), https-or-loopback validated at both load and
  request time (`src/config.ts:759-761`, `src/api-http.ts:71-84`).
- The path never spawns a process or touches the filesystem based on the
  response; the provider text is returned as inert MCP text content
  (`src/index.ts:5124-5143`).

Conclusion: an untrusted endpoint can only return a text string. No local action.
(Residual, out of scope: that text still flows to the orchestrating parent agent,
so ordinary prompt-injection-via-content applies, a general agent concern.)

### CLI-provider surface (spawned `claude`/`codex`/...): the real gap

- A **caller cannot** redirect a spawned CLI: the per-request `env` param is
  allowlisted by `assertUpstreamCliEnv` (`src/upstream-contracts.ts:3263-3285`),
  no `*_BASE_URL` / proxy keys, and no `--base-url` flag is wired.
- **But** the spawned child inherits the gateway's **full `process.env`**
  (only PATH extended). A host-env `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` /
  `HTTPS_PROXY` silently redirects every spawned CLI's model traffic. Requires an
  already-compromised/misconfigured host, so this is defense-in-depth, not a
  caller-facing vulnerability, but it is the control-plane redirect the research
  names.
- Default tool posture varies: Claude/Codex/Gemini fall back to their own
  non-bypass defaults; **Mistral/Vibe defaults to `--agent auto-approve`** under
  `legacy` strategy (`src/index.ts:4187-4192`), so an injected tool call would
  auto-execute. (Tracked separately, not fixed here.)

## Change

New module `src/spawn-env-isolation.ts`:

- `isRedirectionEnvKey(key)`: matches the endpoint/proxy redirection surface
  (case-insensitive) via suffixes `*_BASE_URL`, `*_API_URL`, `*_API_BASE`,
  `*_ENDPOINT`, `*_ENDPOINT_URL`, `*_SERVER_URL`; any `*_PROXY`
  (HTTP(S)/ALL/FTP/SOCKS); and socket redirects `ANTHROPIC_UNIX_SOCKET` /
  `GROK_LEADER_SOCKET`. `NO_PROXY` (a narrowing allowlist) and `*_API_KEY`
  credentials are preserved.
- `sanitizeSpawnEnv` / `applySpawnEnvIsolation`: gated on
  `LLM_GATEWAY_ISOLATE_SPAWN_ENV`; warn-once listing withheld keys.

**Applied at the spawn chokepoint.** `applySpawnEnvIsolation` runs inside
`spawnCliProcess` (`src/executor.ts`) on the FINAL merged env, so both the
sync/inline (`executeCli`) and async/deferred (`async-job-manager.ts`) paths are
covered, and an upstream `{ ...process.env, ...env }` re-splat cannot reintroduce
a stripped var. The ACP provider env builder (`src/acp/process-manager.ts`
`buildProviderEnv`) applies the same isolation.

Tests: `src/__tests__/spawn-env-isolation.test.ts`, including an integration test
that spawns a child through `spawnCliProcess` and asserts redirection vars are
stripped from the real child environment (and pass through when the flag is off).

**Opt-in by design.** Self-hosted operators legitimately point a CLI at a private
endpoint via these same variables; a default-on strip would break those setups.
A future major could flip the default after a deprecation window.

## Cross-LLM review (round 1, applied)

Codex, Grok, and Mistral independently reviewed the first cut against the code.
Consensus blockers, all addressed here:

1. **Sync-path bypass (critical).** The inline path (`src/index.ts:1214`) passes
   `{ ...process.env, ...env }` as the spawn env, which re-injected redirection
   vars after a base-env-only sanitization. Fixed by moving sanitization to the
   `spawnCliProcess` chokepoint (final merged env).
2. **Denylist coverage.** Original `*_BASE_URL` / `*_API_BASE` only missed
   `*_API_URL` (`ANTHROPIC_API_URL`, `MISTRAL_API_URL`, `DEVIN_API_URL`, ...),
   `*_ENDPOINT` / `*_ENDPOINT_URL` (`AWS_ENDPOINT_URL`), `*_SERVER_URL`
   (`WINDSURF_API_SERVER_URL`), and `ANTHROPIC_UNIX_SOCKET`. Patterns broadened.
3. **Warn-once latch.** The latch was armed before the logger check, so an early
   logger-less spawn could swallow the single operator signal. Now the latch arms
   only when a warning is actually emitted.
4. **ACP coverage.** `buildProviderEnv` did not isolate; now it does.

Opt-in-default-off was unanimously judged the right call.

### Cross-LLM review (round 2, applied)

Grok approved. Codex blocked on one concrete miss, now fixed:

- **`GROK_LEADER_SOCKET`** (Codex, blocker): an inherited value redirects Grok to
  an attacker-controlled local leader socket and matched no pattern. Added to the
  socket-redirect exact set. (The ACP builder sets its own isolated socket value
  after isolation, so stripping the inherited one is correct.)
- **SOCKS proxies** (both): proxy matching generalized from four exact names to
  any `*_PROXY` (still preserving `NO_PROXY`), covering `SOCKS_PROXY` /
  `SOCKS5_PROXY`.

## Scope notes / follow-ups

- This is a best-effort **denylist** of the LLM-endpoint/proxy redirection
  surface, not an exhaustive allowlist. A stricter allowlist mode (strip all but a
  known-safe base set plus each provider's required vars) is a possible future
  hardening. TLS-trust vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) are
  intentionally not stripped: they cannot redirect traffic alone, and stripping
  them would break legitimate corporate-CA setups.
- **Vibe/Mistral `auto-approve` default** under `legacy` strategy is the sharpest
  edge (the one provider that would auto-execute an injected tool call). Revisit
  the default or surface it in `doctor`. Tracked separately.
- **`doctor` visibility**: warn when `*_BASE_URL`/proxy vars are present in the
  gateway env.
- Read-only `--help`/`--version` provider probes inherit env too but take no
  prompt (no injection surface), so they are out of scope.
- Model-catalog / capability discovery probes (`provider-capability-discovery.ts`)
  and CLI-upgrade / provider-admin spawns use their own `envWithExtendedPath` +
  spawn rather than the `spawnCliProcess` chokepoint. They fetch data with no
  tool-execution loop, so they are not the injected-tool-call vector; extending
  the chokepoint to them is a defense-in-depth follow-up.
- ACP `buildProviderEnv` applies isolation without a logger, so an ACP-first
  process does not emit the one-time warning. Thread a logger through when ACP
  live routing is enabled.
