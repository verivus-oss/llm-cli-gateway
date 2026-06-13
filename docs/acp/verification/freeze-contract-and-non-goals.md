# Verification report — step `freeze-contract-and-non-goals`

Plan: `docs/plans/first-class-acp-gateway-extension.dag.toml`
Step block: lines 432-453 (`[[steps]]` id = `freeze-contract-and-non-goals`, `depends_on = []`).
Verifier role: independent (implementer not trusted; all claims re-derived from disk + command output).
Date: 2026-06-13.
Result: **validationPassed = true** (all validation rows pass, no vacuous tests).

This is the first (contract-freeze / documentation) step of the slice. It ships
no `src/acp/` runtime code; it freezes the contract in docs and asserts the
terminology + "no raw ACP JSON-RPC public tool" invariants. No mutation probe is
required for this phase per the task brief; tests cited below were read to confirm
they are real (non-vacuous), and the relevant `[test_matrix]` rows that touch the
public-tool / ACP-flag surface were executed.

---

## Validation clause (verbatim, dag lines 449-453)

> Spec, implementation notes, and docs all use Agent Client Protocol terminology
> consistently and state that Agent Communication Protocol is out of scope. No
> new public tool exposes raw ACP JSON-RPC.

Decomposed into three behavioral claims (V1, V2, V3) below.

---

## V1 — Consistent "Agent Client Protocol" terminology across spec/notes/docs

**Status: PASS.**

The protocol target is named "Agent Client Protocol" (not the agent-to-agent
"Agent Communication Protocol") consistently in the spec, the implementation
notes, and the scope doc:

| Artifact (role) | file:line | text |
|---|---|---|
| Spec / DAG (`protocol_target`) | `docs/plans/first-class-acp-gateway-extension.dag.toml:48` | `protocol_target = "Agent Client Protocol"` |
| Spec / DAG (scope header) | `docs/plans/first-class-acp-gateway-extension.dag.toml:4` | `Add Agent Client Protocol (ACP) as a first-class, optional provider` |
| Spec / DAG (acronym note) | `docs/plans/first-class-acp-gateway-extension.dag.toml:10` | `This plan targets Agent Client Protocol, the JSON-RPC protocol used by` |
| Implementation notes (decisions) | `docs/acp/state/decisions.md:13` | `Protocol target is **Agent Client Protocol** (the JSON-RPC protocol between` |
| Docs (scope) | `docs/acp-scope.md:10` | `Current implementation planning targets Agent Client Protocol as an` |
| Docs (scope) | `docs/acp-scope.md:21` | `- Agent Client Protocol is an additive provider transport for provider agents` |

Command digest (mentions counted per artifact):

```
$ grep -rc 'Agent Client Protocol' docs/acp-scope.md docs/acp/state/decisions.md \
    docs/plans/first-class-acp-gateway-extension.dag.toml
docs/acp-scope.md:2
docs/acp/state/decisions.md:1
docs/plans/first-class-acp-gateway-extension.dag.toml:4
```

No artifact uses "Agent Communication Protocol" as the *target* term; every
occurrence (see V2) is an explicit out-of-scope disclaimer.

---

## V2 — "Agent Communication Protocol" stated out of scope everywhere it appears

**Status: PASS.**

Every occurrence of the phrase "Agent Communication Protocol" in `docs/`
declares it out of scope / not the target — none use it as the protocol being
built.

Command digest:

```
$ grep -rn 'Agent Communication Protocol' docs/
docs/acp-scope.md:12:frontend and not an agent-to-agent Agent Communication Protocol layer. Use the
docs/acp/state/decisions.md:14:editors/clients and coding agents). Agent-to-agent "Agent Communication Protocol"
docs/plans/acp-provider-transport-research.dag.toml:8:#   "Agent Communication Protocol" usually refers to agent-to-agent
docs/plans/acp-provider-transport-research.dag.toml:83:  - Agent Communication Protocol: agent-to-agent interoperability family.
docs/research/2026-06-12-acp-provider-transport-feasibility.md:9:"Agent Communication Protocol", but the coding-agent CLI/editor ecosystem uses
docs/plans/first-class-acp-gateway-extension.dag.toml:12:#   agent-to-agent "Agent Communication Protocol" work unless a provider CLI
docs/plans/first-class-acp-gateway-extension.dag.toml:451:consistently and state that Agent Communication Protocol is out of scope. No
```

Context-checked citations confirming out-of-scope framing:

- `docs/acp/state/decisions.md:14-15` — `Agent-to-agent "Agent Communication Protocol" work is explicitly out of scope.`
- `docs/acp-scope.md:11-12` — targets ACP `not an agent-to-agent Agent Communication Protocol layer.`
- `docs/plans/first-class-acp-gateway-extension.dag.toml:10-13` — plan targets Agent Client Protocol; `does not target agent-to-agent "Agent Communication Protocol" work unless a provider CLI explicitly documents that meaning later.`
- `docs/plans/acp-provider-transport-research.dag.toml:6-10` — Agent Communication Protocol `is not the protocol targeted by this research`.
- `docs/research/2026-06-12-acp-provider-transport-feasibility.md:7-12` — `Agent-to-agent "Agent Communication Protocol" is not the target for this task`.

---

## V3 — No new public tool exposes raw ACP JSON-RPC

**Status: PASS (structural — no ACP runtime/tool code exists in this freeze step).**

This step ships no `src/acp/` directory and registers no ACP tool. The only
`acp` reference in `src/` is an unrelated legacy-flag rejection test (see "Tests
read for veracity"). Therefore no public MCP tool exposing raw ACP JSON-RPC can
exist by construction.

Evidence:

```
$ ls src/acp/ 2>/dev/null   # directory does not exist (no runtime ACP code shipped)
$ grep -rln -i 'acp' src/
src/__tests__/upstream-contracts.test.ts        # the ONLY acp reference in src/
$ grep -rni 'acp' src/index.ts src/resources.ts src/provider-tool-capabilities.ts \
    src/upstream-contracts.ts src/doctor.ts
# (no matches — exit 1)
$ grep -rni 'raw.*rpc\|json_rpc.*tool\|acp_request\|acp_smoke\|acp_json' src/
# (no matches — exit 1)
```

- Tool-registration surface (`src/index.ts`): no `acp`-named tool, no
  `acp_request`/`acp_smoke`/`acp_json*` tool name. (grep exit 1.)
- Resources surface (`src/resources.ts`), capability surface
  (`src/provider-tool-capabilities.ts`), upstream-contracts surface
  (`src/upstream-contracts.ts`), doctor (`src/doctor.ts`): no `acp` reference.
  (grep exit 1.)

The spec itself fixes this invariant for the eventual implementation:
`docs/plans/first-class-acp-gateway-extension.dag.toml:77`
(`expose_raw_acp_json_rpc = "Agents continue using gateway MCP tools and resources, not provider-specific JSON-RPC calls."`)
and line 55 (`no_direct_provider_acp_exposure = true`). The `[api_surface].diagnostic_surface`
clause (dag) further constrains any future public ACP diagnostic to
`readOnlyHint = true` and "cannot start prompts".

---

## `[test_matrix]` rows relevant to this step

This freeze step predates the ACP runtime; most `[test_matrix]` rows describe
tests for later steps (json_rpc_transport, schemas, host_services, session_map,
mock_acp_agent, etc.) and are not yet implementable here. The rows whose
*current* invariant the freeze step must not regress are the public-tool / ACP-flag
boundary, covered by existing suites that I executed:

| Suite | Command | Result digest |
|---|---|---|
| `src/__tests__/upstream-contracts.test.ts` | `npx vitest run src/__tests__/upstream-contracts.test.ts` | `Test Files 1 passed (1)` / `Tests 33 passed (33)` |
| `src/__tests__/provider-tool-capabilities.test.ts` + `src/__tests__/cache-state-resources.test.ts` | `npx vitest run ...` | `Test Files 2 passed (2)` / `Tests 18 passed (18)` |

Release-gate / structural commands run:

```
$ node -e "...smol-toml...parse(...first-class-acp-gateway-extension.dag.toml...)"
TOML OK
$ git diff --check
diff-check clean
$ npm run build   # tsc -p tsconfig.build.json
(clean, exit 0)
```

---

## Tests read for veracity (no mutation probe required this phase)

- `src/__tests__/upstream-contracts.test.ts:584-590` — test
  `"acknowledgement never affects the argv allowlist"`. Asserts that the legacy
  gemini `--acp` flag, even though probe-acknowledged, is **rejected** by
  `validateUpstreamCliArgs("gemini", ["-p", "hello", "--acp"])`:
  `expect(result.ok).toBe(false)` and
  `expect(result.violations[0]?.message).toMatch(/Unsupported gemini CLI flag/)`.
  This is a real, non-vacuous test (two concrete assertions on returned values)
  and directly supports the slice's `no_direct_provider_acp_exposure` /
  `no_arbitrary_subcommand_execution` invariants — an ACP-shaped flag is not
  silently allowed into provider argv. Confirmed green in the 33-pass run above.

No test in `src/` was found that is vacuous relative to this step's claims.
`vacuousTests = []`.

---

## Conclusion

All three validation claims (V1 consistent ACP terminology, V2 Agent
Communication Protocol declared out of scope, V3 no public tool exposes raw ACP
JSON-RPC) pass against the spec, the implementation notes
(`docs/acp/state/decisions.md`), and the docs (`docs/acp-scope.md`), with
supporting command digests. No ACP runtime/tool code is shipped, so the
"no new public tool" invariant holds structurally. Cited tests are real.

`validationPassed = true`, `vacuousTests = []`, `failures = []`.

Note (non-blocking): `docs/acp/state/decisions.md` and this report live under the
untracked `docs/acp/` tree (`git status` shows `?? docs/acp/`); they are on disk
as required for verification but are not yet committed. Committing is a later
release-flow concern, not a validation-row failure for this step.
