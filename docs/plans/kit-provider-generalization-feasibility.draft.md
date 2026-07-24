# Personal Agent Config Kit: per-provider generalization feasibility

Status: investigation draft (2026-07-24). Not a committed plan. Grounded in three
parallel code investigations against master `4d766e3`.

## The question

The Personal Agent Config Kit currently supports **Claude and Codex only** (hard gate
`src/personal-config.ts:2525`). The goal being assessed: can each of the other five
CLI providers (grok, gemini, devin, mistral, cursor) get its own Kit, so every provider
draws the same verified baseline, repository overlay, and bounded context?

**TL;DR verdict.** None is feasible now. Ranked readiness:

| Provider | Combined verdict | The wall |
|----------|------------------|----------|
| **mistral** | FEASIBLE-WITH-WORK (best candidate) | needs an isolation module; native UUID exists on disk (`~/.vibe/.../meta.json`) like Codex but is not strict-v4 |
| **grok** | FEASIBLE-WITH-WORK (hazarded) | needs an isolation module; captures a native id on stdout, but the worker-handshake flake (exit 0 / empty stdout) breaks fail-closed continuity |
| **gemini** | BLOCKED (isolation) | no isolation surface at the tracked `agy` version: no ACP, no strict-MCP flag, even `allowedTools` is rejected |
| **devin** | UNKNOWN, effectively BLOCKED (session) | gateway captures no native session id at all (falls through the `default` metadata branch); needs a new parser first |
| **cursor** | BLOCKED (policy) | `capabilityScope: "maintain-only"` fences it off from new capability, plus no native-id parser |

Ranked: **mistral ≈ grok > gemini ≈ devin > cursor**.

This is a **separate initiative** from the async-envelope refactor (A2..A5). That refactor
only makes the async handler path uniform; it does not add Kit isolation to any provider.

---

## How the Kit executes (the constraint that reframes everything)

Two facts about the Kit's execution model determine which isolation routes are even usable:

1. **Kit is durable/async and local-only.** It requires `persistence.backend = sqlite`
   or `postgres` with async jobs enabled (`src/doctor.ts:1404`); sync Kit admission is
   rejected before an attempt is claimed. Kit provider output is withheld from durable job
   history (`src/async-job-manager.ts:192`).
2. **The Kit path never touches ACP.** `src/personal-config.ts` and
   `src/codex-kit-isolation.ts` contain zero references to ACP. Kit isolation today is
   done on the plain CLI/process transport, not through the Agent Client Protocol runtime.

This matters because the only MCP-server allowlisting surface the five providers expose is
their **ACP** `session/new`, and ACP is a different (sync, dormant) transport. See the
isolation section below.

---

## The provider contract: what is free and what must be built

A Kit-eligible provider must satisfy nine primitives. Six are already **generic** (a new
provider inherits them by joining the `"claude" | "codex"` unions) and three-and-a-half are
**provider-specific** (must be built from scratch per provider).

### Already generic (inherited for free)

- **Immutable context stamp** (`compilePersonalKitContext`, `src/personal-config.ts` ~2263):
  `contextDigest` + `configStamp` over instructions, preferences, repo digest, release-tree
  digest, scope cwd, machine id. Provider-agnostic.
- **Attempt lease + fail-closed recovery** (`runWithPersonalKitAttemptLease`,
  `src/index.ts:8332`; `finalizePersonalKitSession` compare-and-swap `:8627`;
  `config_recover_kit_attempt` writes a permanent single-use fence). Provider joins only as
  an `attemptKind` + provider-union value.
- **Machine / workstation binding** (`LocalMachineBinding.machineId`,
  `src/personal-config.ts:606`), folded into the stamp; never synced.
- **Provider-session scoping** (`kitScopeKey(scopeRoot, configStamp, ownerPrincipal)`,
  `src/personal-config-types.ts:214`): release + repo scope + revision + folder + stamp +
  owner + workstation.
- **No-content persistence + flight-recorder withholding**: durable rows carry references
  and digests only, never instructions, argv, stdin/stdout/stderr, or native handles
  (`src/personal-config-types.ts:1`, dedup key `kit:<jobId>`).
- **The native-UUID validator + in-memory handle plumbing** (`isKitNativeSessionId`,
  `src/personal-config-types.ts:71`; `liveKitNativeHandles` WeakMap, `src/index.ts:7993`):
  the *check* and the *never-persist, retire-on-restart* rule are shared.

### Provider-specific (the real cost)

1. **Ambient-config / MCP isolation module** (the dominant cost). The agent must be
   prevented from seeing ambient instructions, tools, MCP servers, plugins, skills,
   memories, and keychain. Two shipped models:
   - **Claude model:** `--bare` + `--disable-slash-commands` + forced API-key auth
     (`src/index.ts:5636`), plus a generated `--mcp-config` allowlist behind
     `--strict-mcp-config` for the non-Kit managed path.
   - **Codex model:** the 561-line `src/codex-kit-isolation.ts`: `--ignore-user-config
     --ignore-rules --disable apps,plugins,hooks,multi_agent,memories`, static `-c`
     overrides, and a **live two-pass probe** (`codex debug prompt-input`) that discovers
     injected `SKILL.md` paths, re-launches with them disabled, and **verifies** the
     model-visible prompt carries no skills/apps instruction block, failing closed
     otherwise.
   A new provider needs its own equivalent, custom to that CLI's discovery model.
2. **Request-surface conflict list** (`CLAUDE_KIT_CONFLICT_FIELDS` 37 fields /
   `CODEX_KIT_CONFLICT_FIELDS` 25 fields, `src/personal-config.ts:2452` / `:2490`): a
   hand-audited per-provider list of every flag that could inject instructions, tools, MCP
   config, or a raw native session, rejected in Kit mode.
3. **Native-session extractor** (the extractor half of primitive 5): the provider must emit
   a UUID-shaped native session id in **machine-readable output**, with a parser wired into
   `extractProviderOutputMetadata` (`src/provider-output-metadata.ts:118`). Without this the
   provider can run one-shot only, never continue a conversation.
4. **MCP-artifact provenance** (`src/mcp-artifact-admission.ts`): only if the provider
   generates gateway-owned config artifacts (Claude does; Codex does not).

---

## The two isolation architectures, and why ACP is the wrong door today

There are two ways to make the isolation boundary real:

- **Inject an allowlist** (Claude): the host declares the exact server set. For the five
  providers this is only available through **ACP** `session/new { mcpServers: [...] }`
  (`src/acp/client.ts`, `src/acp/types.ts:352`). But: (a) the ACP runtime currently
  hardcodes `mcpServers: []` (`src/acp/runtime.ts:243,246`); (b) ACP is dormant and
  **sync-only** (async ACP parity is unshipped); (c) it is unproven whether a provider's
  ACP agent treats `session/new mcpServers` as **exclusive** (suppresses the provider's own
  `~/.<provider>/config` servers) or merely **additive**. Because the Kit runs on the
  durable/async transport and never touches ACP, this door is architecturally misaligned
  with how Kits execute.
- **Strip the ambient** (Codex): use the CLI's own `--ignore-user-config` /
  feature-disable flags on the plain async transport, then verify the effective prompt.
  This is the model that actually fits the Kit's execution path.

**Consequence:** the realistic near-term route for a new-provider Kit is the **Codex
model** (CLI-native strip-ambient + effective-prompt verification), not the ACP allowlist.
The critical un-probed question per provider is therefore: *does this CLI have a
Codex-style ignore-ambient-config + feature-disable surface on its async path, and can the
gateway verify what took effect?* The investigations answered the ACP-allowlist question
(only ACP can inject); the CLI-native strip-ambient question is the open frontier.

---

## Per-provider detail

### mistral (vibe): strongest candidate

- **Native session (A): FEASIBLE-WITH-WORK.** A real durable native UUID is persisted on
  disk at `~/.vibe/logs/session/session_<ts>_<first8>/meta.json` `session_id`, parseable
  via `parseVibeMetaJson` (`src/mistral-meta-json-parser.ts:1`). This is the closest
  structural analog to `~/.codex/sessions/`. Gaps: stdout emits no id (must resolve from
  disk); gated on `session_logging.enabled` (already checked by `doctor.ts:177`); vibe
  UUIDs are "not strictly v4" so may fail the strict variant/version regex in
  `isKitNativeSessionId` (relax or verify the guard for vibe).
- **Probe result (2026-07-24, vibe 2.22.0, this host, n=2892 on-disk sessions).** The
  handle is real, durable, and reliably written: meta.json present in 2892/2893 dirs
  (99.97%), every `session_id` is a well-formed 8-4-4-4-12 hex UUID (100%), and the
  directory `first8` matches the UUID `first8` in every case (0 mismatches), so
  deterministic dir resolution works. BUT only **344/2892 (11.9%)** pass the strict
  `isKitNativeSessionId` guard; **88.1% would be rejected.** The version and variant
  nibbles are uniformly random across all 16 hex values (observed pass rate 11.9% matches
  the theoretical 12.5% for fully random nibbles), proving vibe mints 128-bit random hex,
  not RFC-4122 UUIDs. **Conclusion: a per-provider broad-shape guard (a `isVibeNativeSessionId`
  accepting the 8-4-4-4-12 shape) is mandatory, not optional; using the strict guard as-is
  breaks continuity for ~7 of every 8 vibe sessions.** The relax is safe and precedented:
  the ids are hex-charset-gated, `parseVibeMetaJson` already uses exactly this broad shape
  (`mistral-meta-json-parser.ts:88`) for the same reason, and resolution requires an exact
  on-disk `session_id` match (single-candidate is not trusted, `:99-102`), so a hex-only
  broad guard cannot inject or cross-attribute. Keep claude/codex strict; scope the relax
  to vibe.
- **Isolation (2): needs a module, and it is BUILDABLE (probe #2, 2026-07-24, vibe 2.22.0).**
  vibe has no `--ignore-user-config` flag, but it has a *cleaner* lever: `VIBE_HOME`
  overrides the entire Vibe home (config.toml, MCP servers, skills, agents, memories, AND
  the session-log store) to a gateway-controlled directory, and `VIBE_*` env vars override
  any config field. So a vibe isolation module is a **hermetic-home** model (point
  `VIBE_HOME` at a clean gateway dir, force features off via `VIBE_*`, restrict the built-in
  catalog with `--enabled-tools`), structurally analogous to Codex's `CODEX_HOME` but
  stronger (relocate the whole home rather than scrub flags). Bonus: the native-session UUID
  lives under `$VIBE_HOME/logs/session/`, so isolation and continuity are compatible (both
  under the same gateway-owned home, no conflict). **Two caveats:** (a) a clean home lacks
  credentials, so auth must be provisioned into it or via env (parallels Kit Claude needing
  `ANTHROPIC_API_KEY`); (b) vibe exposes **no prompt-inspection / debug-prompt capability**
  (no analog of `codex debug prompt-input`), so fail-closed would rest on the *structural*
  hermetic-home guarantee rather than a positive "no ambient block leaked" prompt check.
  That is the one primitive that would be weaker than Codex's.
- **VIBE_HOME suppression confirmed empirically (2026-07-24, behavioral, no syscall tracer
  on host).** With `VIBE_HOME` pointed at a clean dir (only `.env` provisioned for auth),
  a real `vibe -p` run: (1) wrote every home-scoped artifact (session dir, `vibehistory`,
  `trusted_folders.toml`, connector cache, `logs/vibe.log`) into the clean home and **zero**
  into ambient `~/.vibe/logs/session` (2893 to 2893); (2) produced an **empty** `vibe.log`
  with no MCP references, while the same run under ambient `~/.vibe` logs loading the local
  `[[mcp_servers]]` entry ("MCP server 'gtwy'" keyring warning). So the ambient local MCP
  server is **not** loaded under a clean `VIBE_HOME`. Residual: without strace/inotify (both
  absent here) there is no syscall-level proof vibe never opened `~/.vibe/config.toml`, and
  the full tool manifest was not independently enumerated, so a Kit would still lean on the
  structural hermetic-home guarantee plus this behavioral evidence rather than a positive
  prompt/tool-manifest verify.
- **Why best:** it is the only non-baseline provider with a durable on-disk native UUID,
  so the hardest-to-fake primitive (verifiable continuity) is closest to done.

### grok: viable but hazarded

- **Native session (A): FEASIBLE-WITH-WORK.** grok emits a native `sessionId` in
  json/streaming output, already extracted (`src/grok-json-parser.ts:38`, dispatched
  `src/provider-output-metadata.ts:161`); on-disk `grok sessions` + `~/.grok/`. Gaps: id
  shape not proven against `isKitNativeSessionId`; and the **worker-handshake flake** (grok
  can exit 0 with empty stdout) means a "successful" run can yield no native id, silently
  dropping continuity. Any grok Kit must treat empty-stdout-on-success as a hard
  no-evidence refusal (the pattern already exists at
  `src/provider-capability-discovery.ts:522`).
- **Isolation (2): HARD, no clean CLI lever (probe #2, 2026-07-24, grok 0.2.106).** grok
  has *no* home-override env var and *no* `--ignore-user-config` / `--config <path>` /
  strict-config flag. It can disable some features by flag (`--no-memory`,
  `--disable-web-search`, disable plan mode, disable subagent spawning), but ambient MCP
  servers (`grok mcp`) and plugins (`grok plugin`) in `~/.grok/config.toml` cannot be
  wholesale stripped on the CLI path. The one useful lever is `grok inspect` ("show the
  configuration Grok discovers for this directory"), which enables a **detect-and-refuse**
  fail-closed posture (refuse Kit launch if any ambient MCP/plugin is present) but not
  active isolation. A `HOME`-override hermetic approach is theoretically possible but crude
  (relocates credentials too). Net: grok isolation is detect-and-refuse or ACP-gated, not
  active, and is materially harder than vibe.

### gemini (agy): blocked on isolation

- **Native session (A): FEASIBLE-WITH-WORK** but only via forced stream-json: gemini emits
  `session_id` only on the stream-json init event (`src/gemini-json-parser.ts:33`); `-o
  json` and text emit none, and text is the default output.
- **Isolation (2): BLOCKED.** Google Antigravity exposes no ACP and no strict/scoped MCP
  flag at the tracked version; the gateway even rejects non-empty `allowedTools` because
  `agy` has no non-interactive allow-list flag. There is no mechanism to make the agent see
  only a gateway allowlist. **This is the one true upstream blocker** and only changes if a
  future `agy` release adds a scoped-MCP or ACP capability.

### devin: furthest on session evidence

- **Native session (A): UNKNOWN, effectively BLOCKED.** `--continue` / `--resume <id>` are
  declared, but there is **no devin output parser**: `extractProviderOutputMetadata` hits
  the `default` branch and emits nothing (`src/provider-output-metadata.ts:177`). The
  gateway never observes a native id. Needs a new parser plus confirmation devin emits a
  real UUID-shaped durable id.
- **Isolation (2): needs a module** (ACP entrypoint `devin acp` exists but is the wrong
  transport; CLI-native path un-probed).

### cursor: blocked by policy

- **Native session (A): BLOCKED.** No cursor output parser (`default` branch); the request
  schema itself warns the gw-* id is not resumable (`src/index.ts:20463`).
- **Policy:** `capabilityScope: "maintain-only"` (`src/provider-definitions.ts:1196`)
  explicitly puts cursor out of scope for new capability. It is also the minimal
  async-envelope member (A1), which is orthogonal to Kit support.

---

## Recommended next steps (cheap probes before any build)

1. **Vibe on-disk UUID probe: DONE (2026-07-24).** Confirmed stable and reliably written
   (2892/2893 sessions, deterministic dir resolution). Decision made: a vibe-scoped
   broad-shape guard is required (strict guard rejects 88.1%). See the mistral probe result
   above. Continuity, the hardest primitive, is de-risked for mistral.
2. **CLI-native strip-ambient probe (mistral, grok): DONE (2026-07-24).** vibe: BUILDABLE
   via the `VIBE_HOME` hermetic-home model (no prompt-verify capability is the one caveat).
   grok: HARD, no home-override or ignore-config flag, so isolation is detect-and-refuse
   (via `grok inspect`) or ACP-gated, not active. See the per-provider isolation notes. This
   widens mistral's lead over grok: mistral now has both a solved continuity primitive and a
   buildable isolation lever, while grok has a hazarded continuity and no clean isolation
   lever.
3. **grok empty-stdout fail-closed handling:** adopt the empty-stdout-as-not-succeeded
   pattern for the Kit terminal path.
4. **devin metadata parser probe:** does `devin` emit a durable UUID in any machine-readable
   output mode? If not, devin cannot continue conversations under a Kit.
5. **gemini / cursor:** treat as blocked. gemini needs an upstream `agy` capability; cursor
   needs a deliberate scope change out of `maintain-only`.

## Effort shape

Per feasible provider the build is roughly: one isolation module analogous to
`codex-kit-isolation.ts` (the large item), one conflict-field list, one native-id parser
(mistral: disk-resolution; grok: already present; devin: net-new), plus joining the four
provider unions. The generic stamp/lease/recovery/scoping/machine-binding machinery is
reused unchanged.
