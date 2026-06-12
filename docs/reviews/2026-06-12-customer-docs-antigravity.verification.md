# Verification report — customer-facing docs accuracy for the Gemini→Antigravity release

Date: 2026-06-12. Base commit: `e11b5cf` (master, the 2.5.0 release commit).
Working tree, uncommitted. Proposed release version: **2.6.0**.

This report is the corrective-program spec for the cross-LLM review gate. It
audits **customer-facing documentation** for accuracy against the actual code
after the Gemini provider was re-backed by Google Antigravity CLI (`agy`).
**Reviewers must verify every claim against the working-tree code and the docs
themselves, not against this summary.** File:line citations are exact at the
time of writing; re-resolve them against the tree.

## 0. Code ground truth (the source of "correct")

The Gemini *outbound provider* now shells out to Antigravity (`agy`), not the
Google Gemini CLI. Verify:

- `src/executor.ts:32` — `providerCommandName("gemini")` returns `"agy"` (and
  `"mistral"` → `"vibe"`).
- `src/provider-status.ts:47` — `PROVIDER_COMMANDS.gemini = providerCommandName("gemini")` (= `agy`).
- `src/provider-login-guidance.ts` gemini block — displayName "Google Antigravity CLI";
  install `curl -fsSL https://antigravity.google/cli/install.sh | bash`; docs
  `https://antigravity.google/docs/cli-overview`; login `agy`; verify `agy --version`.
- `src/cli-updater.ts` gemini branch — upgrade strategy `agy update` (self-update);
  explicit non-`latest` target THROWS "Antigravity CLI upgrades support only the
  'latest' target via 'agy update'."
- `src/index.ts:6562-6563` — `gemini_request` description: "Run a Google
  Antigravity CLI (`agy`) request through the Gemini-compatible gateway tool…".
  `:7751` — same for `gemini_request_async`.
- `src/index.ts:6578` — model hint: "agy --model (e.g. gemini-3-pro-preview,
  gemini-2.5-flash, pro, flash, latest)". `:6583` — sessionId emits `--conversation`.
- `src/index.ts:2721-2756` — the following params are **rejected** for Antigravity:
  `allowedTools`, `mcpServers`, `outputFormat` (json/stream-json), `policyFiles`,
  `adminPolicyFiles`, `attachments`, `skipTrust`. `includeDirs` (→ `--add-dir`),
  `sandbox` (→ `--sandbox`), `approvalMode`, `model`, `sessionId` remain supported.

The grok provider-codegen / Issue-#1 work in this same tree is **internal and
proven byte-identical** (separate gate: `docs/reviews/2026-06-10-issue1-provider-codegen.*`,
unconditional approval ×3). It does NOT change any user-visible surface, so no
customer-facing doc changes are required for it. This report is scoped to the
Gemini→Antigravity user-visible delta plus the stale site version.

## 1. Role distinction (do not flatten)

"Gemini" appears in two roles. Keep them separate:

- **OUTBOUND provider** — the gateway invoking the Gemini provider CLI
  (`gemini_request`, provider install, model names, version/upgrade, the spawned
  binary). This role **changed** to Antigravity. Category **A** findings below.
- **INBOUND MCP client** — "Gemini CLI" connecting *to* the gateway as an MCP
  host (the Personal MCP Appliance connect guides / support-matrix inbound rows).
  This is a **different capability**; the code change does not establish that
  Antigravity (`agy`) is a verified inbound MCP host. Category **B** findings are
  flagged but NOT rewritten in this pass — they need a product decision +
  verification, not a blind find/replace.

## 2. Category A — outbound, factually wrong, MUST fix

### site/ (deploys to llm-cli-gateway.dev)
| # | File:line | Current | Fix | Evidence |
|---|-----------|---------|-----|----------|
| A1 | site/index.html:157 | "`gemini_request` uses the installed Gemini CLI" | "…uses the installed Antigravity CLI (`agy`)" | index.ts:6563 |
| A2 | site/index.html:211 | Provider CLIs "claude / codex / gemini / grok / vibe" | "claude / codex / agy / grok / vibe" (actual spawned binaries) | executor.ts:32 |
| A3 | site/index.html:38 | JSON-LD `"softwareVersion": "2.0.0"` | "2.6.0" | package.json (2.5.0→2.6.0) |
| A4 | site/index.html:229 | footer "llm-cli-gateway v2.0.0" | "v2.6.0" | package.json |
| A5 | site/install.md:38 | `npm install -g @google/gemini-cli` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | provider-login-guidance.ts |

### README.md
| # | File:line | Current | Fix | Evidence |
|---|-----------|---------|-----|----------|
| A6 | README.md:238-242 | "### Gemini CLI" + `npm install -g @google/gemini-cli` + github URL | "### Gemini (Google Antigravity CLI)" + curl installer + antigravity.google docs URL | provider-login-guidance.ts |
| A7 | README.md:480 | "Execute a Gemini CLI request with session support." | "Execute a Google Antigravity CLI (`agy`) request with session support." | index.ts:6563 |
| A8 | README.md:492 | "`mcpServers` … Allowed Gemini MCP server names" (documents as functional) | mark Unsupported (rejected by Antigravity) | index.ts:2740 |
| A9 | README.md:493 | "`allowedTools` … Restrict Gemini tools" (functional) | mark Unsupported (rejected) | index.ts:2735 |
| A10 | README.md:496 | "`sandbox` … (`-s`)" | flag is `--sandbox` | index.ts:6638 |
| A11 | README.md:1049 | "Gemini: `npm install -g @google/gemini-cli@<target>`" | "Gemini latest: `agy update` (explicit version targets unsupported)" | cli-updater.ts |
| A12 | README.md:1239 | troubleshooting `which gemini` | `which agy` | executor.ts:32 |
| A13 | README.md:1256 | `chmod +x $(which gemini)` | `chmod +x $(which agy)` | executor.ts:32 |
| A14 | README.md:1309 | security allow-list "(claude, codex, gemini, grok, vibe)" | "(claude, codex, agy, grok, vibe)" — actual spawned binary | executor.ts:32 |

### docs/launch (published tutorial; asserts a now-wrong install command)
| # | File:line | Current | Fix |
|---|-----------|---------|-----|
| A15 | docs/launch/devto-tutorial.md:26 | `npm install -g @google/gemini-cli` | antigravity curl installer |

## 3. Category B — inbound MCP client (flagged, NOT changed this pass)

These describe "Gemini CLI" as an inbound MCP client / outbound *validation*
provider in the Personal MCP Appliance. The outbound-provider migration does not,
by itself, make these wrong, and there is no code evidence that `agy` is a
verified inbound MCP host. Listed for the reviewers / product owner; left as-is.

- docs/personal-mcp/connect-gemini-cli.md (entire file)
- docs/personal-mcp/PROVIDER_SUPPORT_MATRIX.md:17,74-85 (incl. stale source URLs L84-85)
- docs/personal-mcp/PRODUCT_CONTRACT.md:57
- README.md:70,335 (provider-support-matrix gating language)
- docs/personal-mcp/ENDPOINT_EXPOSURE.md:21, connect-chatgpt.md:33, DOGFOODING_RESULTS.md:39

## 4. Category C — verify or branding (low confidence)

- README.md:1137 "Gemini: `~/.gemini/config.json`" — Antigravity config path
  unverified; left unless evidence found. Marked UNASSESSABLE without an `agy`
  config-path source.
- "Gemini" as a provider/model-family label in site/README taglines
  (index.html:7,13,33,100,166,210; llms.txt:3; agent.json:3; README:12,158) —
  defensible (the tool is still `gemini_request`, provider enum still `gemini`).
  Not changed.
- README.md:194 gemini cache-support row — `gemini_request` still exposes
  promptParts/cacheControl; left unchanged.

## 5. Out of scope (explicit)

- grok provider-codegen / Issue #1 (separate, already-approved gate; internal).
- async stall telemetry, upstream-contracts grok-0.2.38 sync (code, not
  customer docs).

## 6. Build/test evidence to reproduce after fixes

- `npm run build` → clean.
- `npm test` → full suite passes (docs changes do not touch test fixtures; the
  code in this tree already passed 1184 in the codegen gate — re-run to confirm
  no regressions from the release branch state).
- Doc-only changes: verify each Category A citation now reads the corrected text
  and that NO Category A `@google/gemini-cli` / "Gemini CLI" outbound-install
  string remains: `grep -rniE '@google/gemini-cli|gemini --version' README.md site/ docs/launch/devto-tutorial.md` → empty.

## 7. Post-review corrections (round 2 — from Codex blocker, code-verified)

The first review round produced one concrete, code-cited blocker (Codex) plus
a same-class defect found while fixing it. Both are now corrected:

- **A16 — README.md:491 `approvalMode`.** Previously listed
  `default|auto_edit|yolo|plan` as if all four were accepted. Code
  `src/index.ts:2724-2733` rejects any `effectiveApprovalMode` other than
  `default` or `yolo` via `unsupported("approvalMode", …)`. Corrected to: only
  `default` and `yolo` accepted; `auto_edit`/`plan` rejected.
- **A17 — README.md:498 `yolo`.** Previously claimed it "Emits `--yolo` … when
  `--approval-mode yolo` is not already being emitted". Code
  `src/index.ts:2768-2770` pushes `--dangerously-skip-permissions` (the only
  approval flag emitted for `agy`); `--yolo`/`--approval-mode` are never pushed
  in the Antigravity arg builder (2759-2770). Corrected to: emits
  `--dangerously-skip-permissions`.

Non-customer-facing follow-up (NOT in this docs release, flagged only): the
`yolo` param JSDoc at `src/index.ts:2643-2647` still describes the old
`--yolo`/`--approval-mode yolo` behavior; the runtime (2768-2770) emits
`--dangerously-skip-permissions`. Internal comment, no customer surface — track
as a code cleanup, not a release blocker.

## 8. Post-review corrections (round 3 — from second Codex blocker, code-verified)

Second concrete code-cited blocker (Codex round 2): a stale Gemini session-resume
flag. Ground truth — `resolveGeminiSessionPlan` (`src/request-helpers.ts:1140-1146`):
`sessionId` → `["--conversation", id]`; `resumeLatest` (and not createNewSession)
→ `["--continue"]`; else `[]`. So Antigravity sessions resume via `--conversation`
/`--continue`, NOT `--resume`. Corrected:

- **A18 — docs/launch/devto-tutorial.md:182.** Was "Gemini sessions use `--resume`".
  Now: "Gemini (Antigravity) sessions use `--conversation <id>` when you pass
  `sessionId`, or `--continue` with `resumeLatest`."
- **A19 — src/index.ts:365 (the gateway's customer-facing MCP `instructions`
  "Key behaviors" string).** Was "Gemini --resume". Now "Gemini (Antigravity)
  --conversation <id>/--continue". This is a code string but it is surfaced to
  every MCP client, so it is customer-facing documentation. (Requires `npm run
  build` so dist/ carries the corrected string.)

### Flagged, NOT changed — historical launch/marketing blogs
These published announcement posts assert the now-stale `Gemini ... --resume`
claim but describe the product as it was (Gemini CLI genuinely had `--resume`).
Rewriting published positioning posts to Antigravity is a content decision, not a
doc-accuracy fix, and would make the flag claim inconsistent with their "Gemini
CLI" framing. Recommend a SEPARATE content refresh; left unchanged this release:
- docs/launch/blog-cli-vs-api.md:19,21
- docs/launch/reddit-claudecode.md:24
(Reviewers: if you judge these MUST change for THIS release, cite why with the
scope rule. They are not part of the live README/site/install/tutorial surface.)

## 9. Post-review corrections (round 4 — from third Codex blocker, code-verified)

- **A20 — docs/launch/devto-tutorial.md:208.** Was "It spawns `claude`, `codex`,
  and `gemini` as child processes." The gateway spawns `agy` for the Gemini
  provider (`src/executor.ts:32`, `src/index.ts:6563`). Now: "…spawns `claude`,
  `codex`, and `agy` (Antigravity, for the Gemini provider) as child processes."
- **A21 — docs/launch/devto-tutorial.md:90.** Example used `"model":
  "gemini-2.5-pro"`, not in the current documented model set. Updated to
  `gemini-3-pro-preview` (the documented pro-tier model per `src/index.ts:6578`).

Full re-scan of docs/launch/devto-tutorial.md confirms all remaining "Gemini"
references (title, prose capability descriptions, the `gemini_request` tool name,
section headers) are provider/model-family labels — Category C, accurate for the
still-named `gemini` provider — with no remaining binary/flag/install identity
errors in the live customer-facing scope (README, site/, devto-tutorial.md, the
index.ts MCP instructions string).
</content>
</invoke>
