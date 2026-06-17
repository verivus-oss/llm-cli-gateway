# Plan v5: Strip internal MCP server names from the published artifact

Status: **PLAN v5 — revised after round-4 cross-LLM review. R1: all 3 BLOCKED.
R2: Codex BLOCKED (prepack vs `--ignore-scripts`). R3: Grok APPROVED; Codex
BLOCKED B6; Mistral BLOCKED on a false premise (rebutted by probe). R4: Grok +
Mistral APPROVED (unconditional); Codex BLOCKED B7 (guard token list omitted bare
`exa`/`ref_tools`). v5 fixes B7 + a §7 wording nit. Not yet implemented.**
Base commit: `175b975`. Working tree carries pre-existing agent_browser/provider
WIP.

Reviewers: this is v2. Section 9 lists each round-1 blocker and how v2 resolves
it — verify the resolutions are sound against the actual files. New code still
does not exist; treat the design as feasibility-assessable, not
correctness-verifiable. Approve only on inspected reality; cite file:line on
disagreement.

---

## 1. Problem (VERIFIED by all 3 reviewers in round 1)

Internal MCP names + host commands are hardcoded and compile into `dist/`, which
ships to npm. Confirmed sites:
- `src/claude-mcp-config.ts:19-25` — `CLAUDE_MCP_SERVER_NAMES` 5-name `as const`.
- `src/claude-mcp-config.ts:166-188` — `defaultServerDef` switch with
  `~/.local/bin/sqry-mcp`, `trstr-mcp`, `exa-mcp-server`, `ref-tools-mcp`,
  `agent-browser`; plus `findInstalledExaEntrypoint`.
- `src/index.ts:489` — `MCP_SERVER_ENUM = z.enum(CLAUDE_MCP_SERVER_NAMES)`; 10
  total sites (1 def + 9 `.array(MCP_SERVER_ENUM)` usages).
- `src/index.ts` — 8 `.default(["sqry"])` (6514, 6957, 7731, 8056, 8360, 8656,
  9030, 9454); 1 gemini `.default([])` (7540).
- `src/index.ts:1709` — `normalizeMcpServers()` independently `return ["sqry"]`.
- `src/approval-manager.ts:118-131` — scoring: `exa +2`, `ref_tools +1`,
  `agent_browser +4`, with fixed reason strings.
- `src/provider-tool-capabilities.ts:1463` — `entries: [...CLAUDE_MCP_SERVER_NAMES]`.
- `src/doctor.ts:214` — `checkGeminiConfig` whitelist default.
- `README.md` lines 394, 504, 865.
- `dist/claude-mcp-config.d.ts:1` — ships `readonly ["sqry","exa","ref_tools",
  "trstr","agent_browser"]` (the **.d.ts leak**, B2).

Publish pipeline: `npm-publish.yml` = `npm ci → build → security:audit → pack →
publish`; no sanitisation. **`scripts/release-security-audit.sh:221` runs its own
`npm run build`** (B3) and walks the rebuilt `dist/*.js` for the literal
`"fetch"` (the reusable guard pattern). `tsconfig.build.json` sets
`removeComments: true`, so `dist/*.js` carries no comments (comment-leak is a
non-issue).

## 2. Goal

Published tarball (`dist/**/*.js`, `dist/**/*.d.ts`, `README.md`) contains
**zero** internal MCP names (`sqry`, `trstr`, `exa`, `ref_tools`,
`agent_browser`) or host paths. Repo keeps the full list for dev use. Strip is
enforced by the security audit scanning the **packed tarball** (non-bypassable).

## 3. Empty-registry runtime (CORRECTED — B1)

Round-1 reviewers proved the v1 premise FALSE: `src/index.ts:19` imports `z` from
`zod/v3` (zod 4.4.3). `z.enum([])` **constructs without throwing**;
`z.array(z.enum([])).default([])` parses `undefined`→`[]` and rejects non-empty.
So there is **no import-time crash**. The empty-registry handling is therefore a
**typing + public-UX choice**, not crash avoidance: a stripped public build
should *accept arbitrary* server names (open `z.string()`), not reject all via an
empty enum.

## 4. Design

**4a. Centralise — new `src/mcp-registry.ts` (the single strip target).**
Holds ALL internal literals + server-specific logic: the 5-name list (as a
literal so source still type-checks), each server's command/args/env/availability
closure (including `findInstalledExaEntrypoint` and the `exa-mcp-server` /
`ref-tools-mcp` / host-path strings), and approval-scoring metadata
(`{score, reason}` per server). Public export surface is exactly:
- `INTERNAL_MCP_REGISTRY: Record<string, RegistryEntry>`
- `CLAUDE_MCP_SERVER_NAMES: readonly string[]` (= `Object.keys(INTERNAL_MCP_REGISTRY)`)

No other module imports server-specific literals. `commandExists` (generic, no
names) stays in `claude-mcp-config.ts`.

**4b. Type design (B4).** `ClaudeMcpServerName` widens from the const-tuple union
to **`string`** (a plain alias). Rationale: the schema (4c) widens to `string[]`,
and `buildClaudeMcpConfig`/`normalizeMcpServers` must accept arbitrary names
anyway (known → registry; unknown → codex-config or `missing`). The exhaustive
`switch(server)` + `never` check in `defaultServerDef` is **replaced by a
registry lookup** (`INTERNAL_MCP_REGISTRY[name]`), removing the only
exhaustiveness dependence. Widening union→`string` is assignment-safe for all
existing `ClaudeMcpServerName[]` consumers. `npm run build` must pass — this is a
hard gate, not an assumption.

**4c. Empty-safe schema.** Replace `MCP_SERVER_ENUM` usage with a runtime
conditional, element-typed correctly (the exact shape all 3 reviewers required):
```ts
const mcpServerSchema = () =>
  z.array(CLAUDE_MCP_SERVER_NAMES.length
    ? z.enum(CLAUDE_MCP_SERVER_NAMES as [string, ...string[]])
    : z.string());
```
Evaluated at runtime against the *imported* `CLAUDE_MCP_SERVER_NAMES` (empty in a
stripped build → open `z.string()`; full in dev → closed enum). All defaults
become `.default([])`; `normalizeMcpServers` returns `[]` (not `["sqry"]`) when
empty.

**4d. Approval scoring (B-adjacent).** `approval-manager.ts` iterates
`INTERNAL_MCP_REGISTRY` entries and applies each entry's `{score, reason}`,
preserving exactly `exa +2 / ref_tools +1 / agent_browser +4` and the current
reason strings. Empty registry → no per-server score (correct for public build).

**4e. README at source.** Commit a **generic** README (no internal names; point
to gateway config). No runtime README scrub — removes README from the strip
scope entirely. Internal devs get names from CLAUDE.md / gateway config.

**4f. Strip via an EXPLICIT release step — NOT `prepack` (B3 + B5 fix).**
Round-2/Codex proved `prepack` is the wrong hook: `.github/workflows/npm-publish.yml:72,76`
publish with `npm publish --ignore-scripts`, which disables ALL package.json
lifecycle scripts — `prepack` would never run on the real publish tarball.
Instead, `scripts/strip-internal-mcp.mjs` is invoked as an **explicit step** in
the release flow, positioned **after** `npm run security:audit` (npm-publish.yml:53,
whose internal `npm run build` at release-security-audit.sh:221 last rebuilds the
working dist) and **before** `npm pack`/`npm publish` (lines 67/72/76). It mutates
the working `dist/` in place; `npm publish --ignore-scripts` still *packs* the
working dist (the flag skips lifecycle scripts, not file inclusion), so the
shipped tarball is stripped. No rebuild occurs between the strip step and
publish (there is no `prepare`/`prepack` for the un-flagged `npm pack --dry-run`
at line 67 to trigger). Wiring:
- npm-publish.yml: insert two steps after line 53 — `node scripts/strip-internal-mcp.mjs`,
  then `node scripts/verify-no-internal-mcp.mjs` (§4g). (Codex round-3 verified
  this CI ordering is sound: no rebuild occurs between the strip and
  `npm publish --ignore-scripts`.)
- `scripts/pre-release.sh`: run the strip + verify as the **FINAL** steps —
  **after** `bash scripts/verify-registry-install.sh` (B6 fix). That script does
  an UNFLAGGED `npm publish` to Verdaccio (verify-registry-install.sh:155), which
  runs `prepublishOnly` (`"npm run build && npm test"`, package.json:60) and
  rebuilds dist; a strip placed before it would be clobbered (and would publish
  unstripped dist to the local Verdaccio). Running strip+verify last avoids this.
  The Verdaccio publish legitimately tests full dist (dependency/shrinkwrap
  fidelity, not name-stripping), so an unstripped Verdaccio publish is correct.
- The audit script stays read-only (no dist mutation) — the strip is deliberately
  a separate, visible step, not a side effect of the audit.

The script overwrites **both** `dist/mcp-registry.js` **and
`dist/mcp-registry.d.ts`** with stubs exporting the exact public surface:
```js
// dist/mcp-registry.js
export const INTERNAL_MCP_REGISTRY = {};
export const CLAUDE_MCP_SERVER_NAMES = [];
```
```ts
// dist/mcp-registry.d.ts
export declare const INTERNAL_MCP_REGISTRY: Record<string, never>;
export declare const CLAUDE_MCP_SERVER_NAMES: readonly string[];
```
Because consumers import only those two symbols (4a) and `ClaudeMcpServerName` is
now `string` (4b), no other `dist/**/*.d.ts` embeds the literal tuple.

**4g. Enforce on the TARBALL (B2 + B3 fix).** `scripts/verify-no-internal-mcp.mjs`
runs **`npm pack --ignore-scripts`**, extracts the tgz, and hard-fails if any
internal token appears in **any** shipped file. Scope = every entry the `files`
allowlist ships: `package/dist/**/*` (all extensions), `package/README.md`,
`package/CHANGELOG.md`, `package/LICENSE`, `package/*.json`,
`package/migrations/**`, `package/setup/**`, `package/socket.yml`. Token-exact
patterns covering **all five names as bare tokens AND their command forms**
(B7 — the gate must enforce §2's zero-name goal for every name, not just sqry/
trstr/agent_browser): `\bsqry\b`, `sqry-mcp`, `\bexa\b`, `exa-mcp-server`,
`\bref_tools\b`, `ref-tools-mcp`, `\btrstr\b`, `trstr-mcp`, `\bagent_browser\b`,
`agent-browser`. Case-sensitive, so `\bexa\b` does not match `EXA_API_KEY`
(uppercase — and post-strip that env reference lives only in the stubbed
registry anyway) and `\b` boundaries mean `\bexa\b` does not match `example`/
`exact`. Because this packs *after* the strip step (4f), it reflects the real
shipped (stripped) bytes.

Note on `--ignore-scripts` (rebuts Mistral round-3 blocker): a live npm 11.12.1
probe shows `npm pack` fires **`prepack` + `prepare`**, NOT `prepublishOnly`
(which runs only on `npm publish`). This repo defines only `prepublishOnly`
(package.json:60), so an unflagged `npm pack` here triggers *nothing* and cannot
rebuild. Mistral's claim that the verify's `npm pack` re-runs `prepublishOnly` is
therefore false. `--ignore-scripts` is adopted anyway as defense-in-depth (so a
future `prepack`/`prepare` can never rebuild mid-verify).

**4h. Tests.** empty-registry schema accepts arbitrary strings + rejects nothing;
`buildClaudeMcpConfig` with unknown names → `missing`; `normalizeMcpServers([])
=== []`; stub export-surface shape; audit guard catches a planted token; approval
scoring unchanged for known names.

## 5. hono (CORRECTED — B-note from Grok/Mistral)

- Published `llm-cli-gateway@2.10.0` shrinkwrap pins **hono@4.12.22** (verified).
- Snyk (https://security.snyk.io/package/npm/hono): **latest non-vulnerable =
  4.12.25**; 4.12.22 carries 2 High + 3 Moderate advisories
  (`SNYK-JS-HONO-*`); **fix line is "upgrade to 4.12.25 or higher."** (v1's
  "<4.12.21" was imprecise.)
- hono is transitive via `@modelcontextprotocol/sdk@^1.29.0` (`hono: ^4.11.4` +
  `@hono/node-server`); SDK latest is 1.29.0, so an SDK bump does **not** raise
  the hono floor — an `overrides` pin does.
- Fix: add `"hono": "^4.12.25"` to `package.json` overrides; refresh
  lockfile/shrinkwrap; add a hono-floor tripwire to `release-security-audit.sh`
  (mirroring the existing blocked-version checks). Current tree already resolves
  4.12.25; the override prevents regression.

## 6. Risks / open questions

- R-type: confirm `npm run build` passes after widening `ClaudeMcpServerName` →
  `string` and removing the exhaustive switch (hard gate in 4b).
- R-striporder: confirm no dist rebuild occurs between the explicit strip step
  (4f) and `npm publish` — i.e. no `prepare`/`prepack` exists and `npm pack
  --dry-run` (line 67) does not re-emit dist. (No lifecycle scripts are added in
  v3; verify at impl time.)
- R-ignorescripts: the strip MUST be an explicit CI/pre-release step, never a
  lifecycle script, because publish uses `--ignore-scripts` (verified
  npm-publish.yml:72,76).
- R-surface: confirm no consumer imports anything from `mcp-registry.ts` beyond
  the two stubbed symbols (enforced by 4a; verify by grep at impl time).

## 7. Boundary

Strip is release-only, via the explicit step (§4f) — never a lifecycle script.
Local `npm run build`, `npm run check`, and the `security:audit` rebuild all keep
**full** names (their packs see full dist). The strip + tarball name-guard runs
only as the explicit final step in `pre-release.sh` and in the CI publish job, so
the leak gate is exercised at release time on the genuinely stripped bytes —
`npm run check`/audit alone do not strip.

## 8. What approval means

PLAN v5 review. Approve only if (a) the round-1 current-state/hono claims still
check out, and (b) the v2–v5 resolutions to B1–B7 + missed sites are feasible and
sound as designed. Do NOT approve on intent or "should work". Either unconditional
plan approval or one concrete blocker.

## 9. Blockers → resolution (verify each)

Round 1 (B1–B4) + Round 2 (B5):
- **B1** (z.enum([]) crash false): §3 rewritten — no crash; empty handling is a
  typing/UX choice; schema conditional in §4c.
- **B2** (.d.ts leak): §4f stubs `dist/mcp-registry.d.ts` too; §4b widens
  `ClaudeMcpServerName`→`string` so no other `.d.ts` carries the tuple; §4g audit
  scans all `package/dist/**/*` (incl. `.d.ts`) in the tarball.
- **B3** (audit rebuild clobbers strip): §4f strips *after* the audit's rebuild,
  as the last step before pack/publish; §4g audits the packed tarball.
- **B4** (type `never`/`string` mismatch + schema shape): §4b widens the type +
  registry lookup; §4c uses `z.array(NAMES.length ? z.enum(NAMES) : z.string())`.
  (Grok round-2 confirmed only the `defaultServerDef` switch is exhaustiveness-
  dependent; all other `ClaudeMcpServerName` uses are assignment-compatible.)
- **B5** (round-2, Codex — `prepack` defeated by `npm publish --ignore-scripts`,
  npm-publish.yml:76): §4f replaces `prepack` with an explicit release step that
  runs regardless of `--ignore-scripts`; §4g packs/scans after it.
- **B6** (round-3, Codex — pre-release.sh strip clobbered by
  verify-registry-install.sh:155's unflagged `npm publish` → `prepublishOnly`
  rebuild): §4f moves pre-release strip+verify to AFTER verify-registry-install.sh.
- **Mistral round-3 blocker (REBUTTED, not adopted as a defect):** claimed the
  verify's `npm pack` re-runs `prepublishOnly`; disproved by npm 11.12.1 probe
  (`npm pack` fires prepack/prepare only, none defined here). §4g adds
  `--ignore-scripts` as defense-in-depth regardless. (Mistral withdrew it round-4
  after running the probe itself.)
- **B7** (round-4, Codex — guard omitted bare `exa`/`ref_tools`, so a tarball
  leak of those exact names would pass): §4g token list now includes `\bexa\b`
  and `\bref_tools\b` (case-sensitive) alongside every other name + command form.
- **Missed sites**: §4c (`normalizeMcpServers`→`[]`, 8 defaults→`[]`), §4e
  (README at source), §4a (host-path literals only in the stripped registry).

Validations to preserve (Grok r2+r3 + Codex r3, all inspected): §4b widening
compiles (only `defaultServerDef`'s `never` switch is exhaustiveness-dependent →
becomes a registry lookup); the 2-symbol stub is sufficient; ESM `export const`
stub matches `"type":"module"` + NodeNext emit; `npm publish --ignore-scripts`
still packs working-dir files; CI strip ordering is race-free; §4g tarball scan
covers every shipped vector (`files` allowlist enumerated, all token-free today).
