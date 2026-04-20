# Publish Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make llm-cli-gateway ready for npm publishing and Claude Code plugin distribution.

**Architecture:** Fix npm metadata blockers, repair the broken default MCP config path, tighten API semantics, make approval logging opt-in, add CI/publish guards, rewrite README for release, and scaffold a Claude Code plugin wrapper.

**Tech Stack:** TypeScript, npm, Vitest, GitHub Actions, Claude Code plugin format

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `LICENSE` | Apache-2.0 license text |
| Modify | `package.json` | npm metadata, scripts, files field |
| Modify | `tsconfig.json` | Exclude tests from build output |
| Create | `tsconfig.build.json` | Production build config (no tests) |
| Modify | `src/index.ts` | Fix default mcpServers, strictMcpConfig defaults; tighten Codex/Gemini mcpServers semantics |
| Modify | `src/claude-mcp-config.ts` | Graceful handling when keys missing |
| Modify | `src/approval-manager.ts` | Make prompt logging opt-in |
| Modify | `README.md` | Release-grade rewrite |
| Create | `.github/workflows/ci.yml` | CI pipeline |
| Create | `.claude-plugin/plugin.json` | Claude Code plugin manifest |
| Create | `.claude-plugin/marketplace.json` | Plugin marketplace catalog |
| Create | `commands/claude-request.md` | Slash command for Claude requests |
| Create | `commands/codex-request.md` | Slash command for Codex requests |
| Create | `commands/gemini-request.md` | Slash command for Gemini requests |
| Create | `commands/session-manage.md` | Slash command for session management |
| Create | `skills/multi-llm-orchestration/SKILL.md` | Orchestration skill |

---

### Task 1: Create LICENSE file and fix npm metadata

**Files:**
- Create: `LICENSE`
- Modify: `package.json`

- [ ] **Step 1: Create Apache-2.0 LICENSE file**

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
   ...
```

Use the full Apache-2.0 license text. Copyright line: `Copyright 2026 VerivusAI Labs`

- [ ] **Step 2: Update package.json with all missing fields**

Add these fields to `package.json`:

```json
{
  "name": "llm-cli-gateway",
  "version": "1.0.0",
  "description": "MCP server providing unified access to Claude Code, Codex, and Gemini CLIs with session management, retry logic, and async job orchestration.",
  "license": "Apache-2.0",
  "author": {
    "name": "VerivusAI Labs",
    "url": "https://github.com/verivusai-labs"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/verivusai-labs/llm-cli-gateway.git"
  },
  "homepage": "https://github.com/verivusai-labs/llm-cli-gateway#readme",
  "bugs": {
    "url": "https://github.com/verivusai-labs/llm-cli-gateway/issues"
  },
  "keywords": [
    "mcp",
    "llm",
    "claude",
    "codex",
    "gemini",
    "orchestration",
    "model-context-protocol",
    "ai",
    "cli-gateway"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "files": [
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

Merge these into the existing `package.json`, preserving existing fields (`type`, `main`, `bin`, `scripts`, `dependencies`, `devDependencies`).

- [ ] **Step 3: Run `npm pack --dry-run` to verify tarball contents**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npm pack --dry-run`

Expected: Only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` listed. No `src/`, `node_modules/`, `__tests__/`, or config files.

- [ ] **Step 4: Commit**

```bash
git add LICENSE package.json
git commit -m "feat: add LICENSE and npm publishing metadata"
```

---

### Task 2: Fix build to exclude tests from dist/

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json` (build script + publish guards)

- [ ] **Step 1: Create tsconfig.build.json that excludes tests**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

- [ ] **Step 2: Update package.json build and publish scripts**

Change the `build` script and add publish guards:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "build:all": "tsc",
    "prepublishOnly": "npm run build && npm test",
    ...existing scripts...
  }
}
```

Keep the base `tsconfig.json` unchanged (IDEs and `vitest` need it to see tests). Only production builds use `tsconfig.build.json`.

- [ ] **Step 3: Verify tests still compile and no test files in dist/**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && rm -rf dist && npm run build && ls dist/__tests__ 2>/dev/null; echo "exit: $?"`

Expected: No `dist/__tests__/` directory. Exit code from `ls` should be non-zero.

- [ ] **Step 4: Verify tests still run**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npm test`

Expected: All tests pass. Tests use `tsconfig.json` (via vitest), not `tsconfig.build.json`.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.build.json package.json
git commit -m "fix: exclude tests from production build, add publish guards"
```

---

### Task 3: Fix default Claude MCP config (broken fresh install)

The core bug: `mcpServers` defaults to `["sqry", "exa", "ref_tools"]` and `strictMcpConfig` defaults to `true`. Without `EXA_API_KEY`/`REF_API_KEY`, `exa` and `ref_tools` are marked missing, and strict mode fails the request. A fresh install with no API keys will fail on every `claude_request`.

**Files:**
- Modify: `src/index.ts` (lines ~288-290, ~1059-1060, ~1163, ~1247, ~1281-1282, ~1367, ~1393)

- [ ] **Step 1: Write a test for the default mcpServers behavior**

Create or add to an existing test file. The test should verify that when `mcpServers` is omitted, only `sqry` is included (not `exa`/`ref_tools` which need API keys):

```typescript
// In src/__tests__/mcp-defaults.test.ts (or add to integration.test.ts)
import { describe, it, expect } from "vitest";

describe("normalizeMcpServers defaults", () => {
  it("should default to sqry only when no servers specified", () => {
    // The function should return ["sqry"] — the only server that works without credentials
    const result = normalizeMcpServers(undefined);
    expect(result).toEqual(["sqry"]);
  });

  it("should pass through explicitly requested servers", () => {
    const result = normalizeMcpServers(["sqry", "exa"]);
    expect(result).toEqual(["sqry", "exa"]);
  });
});
```

Note: `normalizeMcpServers` is not exported. Either export it or test through the tool schema defaults.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npx vitest run src/__tests__/mcp-defaults.test.ts`

Expected: FAIL — current default returns `["sqry", "exa", "ref_tools"]`.

- [ ] **Step 3: Fix normalizeMcpServers default**

In `src/index.ts`, change `normalizeMcpServers`:

```typescript
function normalizeMcpServers(mcpServers?: ClaudeMcpServerName[]): ClaudeMcpServerName[] {
  if (!mcpServers || mcpServers.length === 0) {
    return ["sqry"];
  }
  return mcpServers;
}
```

- [ ] **Step 4: Fix Zod schema defaults for all tool definitions**

Change every `.default(["sqry", "exa", "ref_tools"])` to `.default(["sqry"])` in tool schemas:

- `claude_request` schema (~line 1059): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`
- `codex_request` schema (~line 1163): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`
- `gemini_request` schema (~line 1247): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`
- `claude_request_async` schema (~line 1281): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`
- `codex_request_async` schema (~line 1367): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`
- `gemini_request_async` schema (~line 1393): `mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"])`

- [ ] **Step 5: Change strictMcpConfig default to false**

Change `strictMcpConfig` defaults from `true` to `false`:

- `claude_request` schema (~line 1060): `strictMcpConfig: z.boolean().default(false)`
- `claude_request_async` schema (~line 1282): `strictMcpConfig: z.boolean().default(false)`

This means a fresh install will attempt to use available servers but won't fail when optional ones are missing. Users who want strict enforcement can opt in.

- [ ] **Step 6: Run tests to confirm fix**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npm test`

Expected: All tests pass, including the new default test.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/__tests__/mcp-defaults.test.ts
git commit -m "fix: default to sqry-only MCP servers, non-strict mode for fresh installs"
```

---

### Task 4: Tighten mcpServers API semantics across CLIs

Codex's `prepareCodexRequest` accepts `mcpServers` in the schema but never applies them to the CLI args. Gemini similarly accepts them but only for approval tracking. This is misleading — the schema suggests the servers are provisioned.

**Files:**
- Modify: `src/index.ts` (tool schema descriptions for codex_request, codex_request_async, gemini_request, gemini_request_async)

- [ ] **Step 1: Update Codex tool schema descriptions to be honest**

Change the `mcpServers` description in `codex_request` and `codex_request_async` from:

```typescript
mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP servers expected for Codex"),
```

to:

```typescript
mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP server names for approval tracking (Codex manages its own MCP config)"),
```

- [ ] **Step 2: Update Gemini tool schema descriptions to be honest**

Change the `mcpServers` description in `gemini_request` and `gemini_request_async` from:

```typescript
mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("Allowed MCP server names"),
```

to:

```typescript
mcpServers: z.array(MCP_SERVER_ENUM).default(["sqry"]).describe("MCP server names for approval tracking (Gemini manages its own MCP config)"),
```

- [ ] **Step 3: Build to verify no type errors**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npm run build`

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix: clarify mcpServers semantics — approval tracking only for Codex/Gemini"
```

---

### Task 5: Make approval prompt logging opt-in

**Files:**
- Modify: `src/approval-manager.ts`

- [ ] **Step 1: Write test for redacted prompt preview**

```typescript
// Add to src/__tests__/approval-manager.test.ts
describe("prompt redaction", () => {
  it("should redact prompt preview when APPROVAL_LOG_PROMPTS is not set", () => {
    delete process.env.APPROVAL_LOG_PROMPTS;
    const manager = new ApprovalManager(tempLogPath);
    const record = manager.decide({
      cli: "claude",
      operation: "test",
      prompt: "this is a secret prompt",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });
    expect(record.promptPreview).toBe("[redacted]");
    expect(record.promptSha256).toBeTruthy(); // hash is always kept
  });

  it("should include prompt preview when APPROVAL_LOG_PROMPTS=1", () => {
    process.env.APPROVAL_LOG_PROMPTS = "1";
    const manager = new ApprovalManager(tempLogPath);
    const record = manager.decide({
      cli: "claude",
      operation: "test",
      prompt: "this is a visible prompt",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });
    expect(record.promptPreview).toContain("visible prompt");
    delete process.env.APPROVAL_LOG_PROMPTS;
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npx vitest run src/__tests__/approval-manager.test.ts`

Expected: FAIL — currently always stores prompt preview.

- [ ] **Step 3: Make promptPreview conditional on env var**

In `src/approval-manager.ts`, change the `promptPreview` function:

```typescript
function promptPreview(prompt: string): string {
  if (process.env.APPROVAL_LOG_PROMPTS === "1") {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 280);
  }
  return "[redacted]";
}
```

The `promptHash` stays — it's non-reversible and useful for dedup without exposing content.

- [ ] **Step 4: Run tests to confirm fix**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npx vitest run src/__tests__/approval-manager.test.ts`

Expected: All approval tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/approval-manager.ts src/__tests__/approval-manager.test.ts
git commit -m "fix: redact prompt previews in approval logs by default (opt-in via APPROVAL_LOG_PROMPTS=1)"
```

---

### Task 6: Rewrite README for release

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace placeholder badges with real ones or remove them**

Remove the fake badge URLs (`https://github.com/yourusername/...`) and the "Bug Free" / "Production Ready" badges. Replace with version badge only:

```markdown
# llm-cli-gateway

A Model Context Protocol (MCP) server providing unified access to Claude Code, Codex, and Gemini CLIs with session management, retry logic, and async job orchestration.
```

- [ ] **Step 2: Add real installation instructions**

Replace the "clone and build" section with npm install instructions:

```markdown
## Installation

### As an MCP server (npm)

```bash
npm install -g llm-cli-gateway
```

Or use directly with `npx`:

```json
{
  "mcpServers": {
    "llm-gateway": {
      "command": "npx",
      "args": ["-y", "llm-cli-gateway"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/verivusai-labs/llm-cli-gateway.git
cd llm-cli-gateway
npm install
npm run build
```
```

- [ ] **Step 3: Fix the license section**

Replace `[Your License Here]` with:

```markdown
## License

Apache-2.0. See [LICENSE](LICENSE) for details.
```

- [ ] **Step 4: Remove "100% Bug-Free" and "production-ready" marketing claims**

Replace lines like:
- `**100% Bug-Free**: All 16 bugs found through multi-LLM reviews fixed`
- `**Status:** 100% Bug-Free - 114 Tests Passing`

With honest statements:
- `**Comprehensive Testing**: 221 tests covering unit, integration, and regression scenarios`
- Remove the v1.0.0 changelog duplicate at the bottom of the README (it's in CHANGELOG.md).

- [ ] **Step 5: Update prerequisite CLI installation instructions**

Replace placeholder comments with real install commands:

```markdown
### Codex CLI
```bash
npm install -g @openai/codex
codex login
```

### Gemini CLI
```bash
npm install -g @anthropic-ai/gemini-cli
# Or follow: https://github.com/google-gemini/gemini-cli
```
```

- [ ] **Step 6: Build and verify README renders**

Run: `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && npm run build`

Expected: No build errors (README changes are non-code).

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for npm publication — real badges, install instructions, license"
```

---

### Task 7: Add CI workflow and coverage thresholds

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (add coverage script)
- Modify: `vitest.config.ts` (add coverage thresholds)

- [ ] **Step 1: Add coverage script to package.json**

```json
{
  "scripts": {
    ...existing...,
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 2: Add coverage thresholds to vitest.config.ts**

Add `thresholds` inside the `coverage` block:

```typescript
coverage: {
  provider: "v8",
  reporter: ["text", "json", "html"],
  include: ["src/**/*.ts"],
  exclude: ["src/__tests__/**"],
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
    statements: 70
  }
}
```

Start conservative (70%) — we can raise thresholds after measuring actual coverage.

- [ ] **Step 3: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm run format:check
      - run: npm test

  pack-smoke-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Verify npm pack contents
        run: |
          npm pack --dry-run 2>&1 | tee pack-output.txt
          # Fail if src/ or node_modules/ appear in tarball
          if grep -E '^npm notice [0-9]' pack-output.txt | grep -qE 'src/|node_modules/|__tests__'; then
            echo "ERROR: Unwanted files in npm tarball"
            exit 1
          fi
      - name: Verify server starts
        run: |
          timeout 5 node dist/index.js < /dev/null 2>/dev/null || true
          echo "Server startup smoke test passed"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json vitest.config.ts
git commit -m "ci: add GitHub Actions workflow with build/test/pack smoke test"
```

---

### Task 8: Scaffold Claude Code plugin wrapper

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `commands/claude-request.md`
- Create: `commands/codex-request.md`
- Create: `commands/gemini-request.md`
- Create: `commands/session-manage.md`
- Create: `skills/multi-llm-orchestration/SKILL.md`

- [ ] **Step 1: Create plugin manifest**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "llm-gateway",
  "description": "Multi-LLM orchestration: delegate to Claude, Codex, and Gemini from a single interface with session management and async jobs.",
  "version": "1.0.0",
  "author": {
    "name": "VerivusAI Labs",
    "url": "https://github.com/verivusai-labs"
  },
  "repository": "https://github.com/verivusai-labs/llm-cli-gateway",
  "license": "Apache-2.0",
  "keywords": ["llm", "orchestration", "codex", "gemini", "multi-model"],
  "commands": "./commands/",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

- [ ] **Step 2: Create marketplace catalog**

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "verivusai-llm-gateway",
  "owner": {
    "name": "VerivusAI Labs"
  },
  "metadata": {
    "description": "Multi-LLM orchestration plugins for Claude Code.",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "llm-gateway",
      "description": "Delegate to Codex and Gemini from Claude Code with session management and async jobs.",
      "version": "1.0.0",
      "author": {
        "name": "VerivusAI Labs"
      },
      "source": "."
    }
  ]
}
```

- [ ] **Step 3: Create MCP server config for plugin**

Create `.mcp.json` at project root:

```json
{
  "mcpServers": {
    "llm-gateway": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]
    }
  }
}
```

- [ ] **Step 4: Create slash commands**

Create `commands/claude-request.md`:

```markdown
---
description: Send a prompt to Claude Code via the LLM gateway with session tracking
argument-hint: '<prompt>'
allowed-tools: Bash
---

Send a request through the llm-gateway MCP server's claude_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `claude_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt.
```

Create `commands/codex-request.md`:

```markdown
---
description: Delegate a task to Codex via the LLM gateway
argument-hint: '<prompt>'
allowed-tools: Bash
---

Send a request through the llm-gateway MCP server's codex_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `codex_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt. Default to fullAuto mode.
```

Create `commands/gemini-request.md`:

```markdown
---
description: Delegate a task to Gemini via the LLM gateway
argument-hint: '<prompt>'
allowed-tools: Bash
---

Send a request through the llm-gateway MCP server's gemini_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `gemini_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt.
```

Create `commands/session-manage.md`:

```markdown
---
description: Manage LLM gateway sessions (list, create, delete, switch)
argument-hint: '[list|create|delete|set-active] [options]'
allowed-tools: Bash
---

Manage sessions through the llm-gateway MCP server.

Raw arguments: `$ARGUMENTS`

Parse the arguments to determine which session tool to use:
- `list` or no args: use `session_list`
- `create [description]`: use `session_create`
- `delete <id>`: use `session_delete`
- `set-active <id>`: use `session_set_active`

Show the results in a readable format.
```

- [ ] **Step 5: Create orchestration skill**

Create `skills/multi-llm-orchestration/SKILL.md`:

```markdown
---
name: multi-llm-orchestration
description: Guide for orchestrating multiple LLMs via the llm-gateway — use when delegating tasks to Codex or Gemini, running parallel reviews, or managing cross-LLM workflows
---

# Multi-LLM Orchestration

Use the llm-gateway MCP server tools to orchestrate work across Claude, Codex, and Gemini.

## Available Tools

- `claude_request` / `claude_request_async` — Send prompts to Claude Code CLI
- `codex_request` / `codex_request_async` — Delegate tasks to Codex CLI
- `gemini_request` / `gemini_request_async` — Delegate tasks to Gemini CLI
- `llm_job_status` — Check async job progress
- `llm_job_result` — Fetch completed job output
- `llm_job_cancel` — Cancel a running async job
- `session_*` — Manage conversation sessions

## Patterns

### Parallel Review
Send the same review request to multiple LLMs simultaneously using async tools, then compare results:
1. `codex_request_async` with review prompt
2. `gemini_request_async` with same review prompt
3. Poll both with `llm_job_status`
4. Fetch results with `llm_job_result`
5. Synthesize findings

### Implement-Review-Fix
1. `codex_request` to implement
2. `gemini_request` to review the implementation
3. `codex_request` to apply fixes

### Session Continuity
Use `session_create` before a multi-turn workflow. Pass the `sessionId` to subsequent requests for conversation continuity.

## Rules
- Async tools return a `jobId` — poll with `llm_job_status`, fetch with `llm_job_result`
- Sync requests that exceed 45s auto-defer to async — check the response for `jobId`
- `mcpServers` on Codex/Gemini is for approval tracking only — those CLIs manage their own MCP config
- Default MCP server is `sqry` only. Add `exa` or `ref_tools` explicitly when you need web search or docs (requires API keys)
```

- [ ] **Step 6: Test plugin loads locally**

Run: `claude --plugin-dir /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`

Expected: Plugin loads, commands visible via `/llm-gateway:claude-request` etc.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/ .mcp.json commands/ skills/
git commit -m "feat: scaffold Claude Code plugin wrapper with commands, skills, and MCP config"
```

---

## Self-Review Checklist

1. **Spec coverage:** All 8 priorities from the review are covered:
   - [x] npm metadata + LICENSE (Task 1)
   - [x] Build exclusions + publish guards (Task 2)
   - [x] Default MCP config fix (Task 3)
   - [x] mcpServers API semantics (Task 4)
   - [x] Approval log prompt redaction (Task 5)
   - [x] README rewrite (Task 6)
   - [x] CI + coverage (Task 7)
   - [x] Claude Code plugin scaffold (Task 8)

2. **Placeholder scan:** No TBD/TODO/placeholder text in any task.

3. **Type consistency:** All function names, file paths, and schema field names match what exists in the codebase.
