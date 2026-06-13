# Verification report: `add-acp-config-schema`

- Step id: `add-acp-config-schema`
- DAG source: `docs/plans/first-class-acp-gateway-extension.dag.toml` lines 455-480
- Depends on: `freeze-contract-and-non-goals`
- Verifier role: independent (implementer not trusted)
- Repo HEAD at verification: `662bfdc`
- Date: 2026-06-13
- Result: **FAIL — implementation absent**

## What the step requires

Action (DAG lines 459-473): extend gateway configuration with an `[acp]`
section plus provider-specific ACP settings, with Zod validation for: global
`enabled` flag, default transport, smoke and prompt timeouts, idle timeout,
`allow_write_host_services`, `allow_terminal_host_services`, per-provider
command and args, and per-provider `runtime_enabled` flag. Shell strings that
require parsing must be rejected; commands stored as executable + argv array
only.

Validation clause (DAG lines 476-480): unit tests must cover (1) default
config, (2) explicit disabled config, (3) provider override config, (4) invalid
default transport, (5) invalid timeout, (6) rejected shell-style entrypoint
strings, and existing config tests must continue to pass.

## Verification method

Read the step + test_matrix from the DAG, grepped the entire `src/` and
`installer/` trees for every ACP config key named in the action, inspected
`src/config.ts` schema inventory, listed the config test files, and ran the
existing config test suites. Tests confirmed real by reading
`src/__tests__/config.test.ts` in full.

## Behavioral claims

The step makes six testable behavioral claims (the six validation rows). For
each, a passing verification would require a file:line of the schema/loader and
the exact test name proving it. **None can be cited because neither the schema
nor the tests exist.**

| # | Required behavior | Implementation citation | Test citation | Status |
|---|---|---|---|---|
| 1 | default ACP config | none — no `[acp]` schema in `src/config.ts` | none | FAIL (absent) |
| 2 | explicit disabled config | none | none | FAIL (absent) |
| 3 | provider override config | none | none | FAIL (absent) |
| 4 | invalid default transport rejected | none | none | FAIL (absent) |
| 5 | invalid timeout rejected | none | none | FAIL (absent) |
| 6 | shell-style entrypoint string rejected | none | none | FAIL (absent) |

## Evidence digests

### `src/config.ts` contains no ACP schema

`grep -n -i 'acp' src/config.ts` → empty output. The schema inventory in
`src/config.ts` is: `DatabaseUrlSchema` (line 12), `PersistenceSchema`
(line 104), `MinStableTokensSchema` (line 377), `CacheAwarenessSchema`
(line 396), `XaiProviderSchema` (line 511), `OAuth*Schema` (lines 602+). No
`AcpSchema`, no `[acp]` loader, no `default_transport`, no
`allow_write_host_services`, no `allow_terminal_host_services`, no
`runtime_enabled`, no per-provider command/argv.

### Repo-wide key search returns nothing

`grep -rln -iE 'allow_write_host_services|allow_terminal_host_services|runtime_enabled|default_transport|acpConfig|AcpConfig| acp:' src/ installer/`
→ empty output. None of the action's distinctive config keys appear anywhere in
`src/` or the Go installer config.

### Only ACP token in `src/` is unrelated

`grep -rln -i 'acp' src/` → `src/__tests__/upstream-contracts.test.ts` only.
That hit is `src/__tests__/upstream-contracts.test.ts:587`:
`validateUpstreamCliArgs("gemini", ["-p", "hello", "--acp"])` — a Gemini CLI
arg-validation fixture, not an ACP config test.

### No ACP config tests anywhere

`grep -rniE 'default transport|invalid.*transport|shell.*entrypoint|provider override|allow_write_host|runtime_enabled|\[acp\]' src/__tests__/`
→ `NONE FOUND`. Config test files present are
`config.test.ts`, `persistence-config.test.ts`,
`cache-awareness-config.test.ts`, `claude-mcp-config.test.ts` — none cover ACP.

### Existing config tests pass (baseline only)

`npx vitest run src/__tests__/config.test.ts src/__tests__/persistence-config.test.ts src/__tests__/cache-awareness-config.test.ts`
→ `Test Files 3 passed (3) / Tests 52 passed (52)`. These satisfy only the
"existing config tests continue to pass" sub-clause; they prove none of the six
required new behaviors.

### Working tree does not touch config

`git diff --stat -- src/config.ts src/__tests__/config.test.ts src/__tests__/persistence-config.test.ts`
→ empty. The uncommitted changes in the tree are in `installer/*`, `src/auth.ts`,
`src/doctor.ts`, `src/endpoint-exposure.ts`, `src/http-transport.ts`,
`src/oauth.ts` and their tests — unrelated to this step.

## Conclusion

The `add-acp-config-schema` step is **not implemented**. The ACP config schema,
loader, and all six required unit tests are absent from the codebase at HEAD
`662bfdc` and from the working tree. The validation clause cannot pass: every
behavioral claim lacks both a code citation and a test citation, which under
the strict-evidence rule means the claim fails.

`validationPassed = false`.

## Corrective program (to make this step pass)

1. Add an `AcpSchema` (Zod) to `src/config.ts` modeling: `enabled: boolean`,
   `default_transport` (enum, e.g. `["cli","acp"]`), `smoke_timeout_ms`,
   `prompt_timeout_ms`, `idle_timeout_ms` (positive-int constraints),
   `allow_write_host_services: boolean`, `allow_terminal_host_services: boolean`,
   and a `providers` map keyed by provider with `command: string`,
   `args: string[]`, `runtime_enabled: boolean`.
2. Enforce executable-plus-argv: reject any entrypoint command string that
   embeds shell metacharacters / requires parsing (e.g. spaces, `|`, `&&`, `;`,
   redirects). Commands must be a bare executable; arguments come from the
   `args` array only.
3. Add a loader (mirroring `loadPersistenceConfig`) reading the `[acp]` TOML
   section with one-time deprecation/diagnostic behavior consistent with the
   existing config loaders.
4. Add unit tests (suggest `src/__tests__/acp-config.test.ts`) with one test per
   validation row: default config, explicit disabled config, provider override
   config, invalid default transport, invalid timeout, rejected shell-style
   entrypoint string.
5. Re-run `npm run check` and the config suites; confirm existing config tests
   still pass.
