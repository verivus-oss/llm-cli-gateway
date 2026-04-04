# Best Practices: LLM CLI Gateway

MCP server best practices (research-sourced, production-validated).

## Table of Contents
- [MCP Server Design](#mcp-server-design)
- [Multi-LLM Orchestration](#multi-llm-orchestration)
- [Error Handling](#error-handling)
- [Retry & Circuit Breaker](#retry--circuit-breaker)
- [Session Management](#session-management)
- [Testing](#testing)
- [Code Organization](#code-organization)

---

## MCP Server Design

### Bounded Context
**Status:** ✅ Implemented

Single domain focus: CLI gateway orchestration
- Tools: `claude_request`, `codex_request`, `gemini_request`, session management
- Clear JSON schemas for inputs/outputs

**Guideline:** Maintain focused scope, reject unrelated features.

---

### Tools = Outcomes, Not Operations
**Status:** ⚠️ Partial

✅ Good: `session_create` combines creation + optional activation
⚠️ Consider: Higher-level tools for common patterns (e.g., `ask_claude_with_context`)

**Pattern:** Design tools for agent goals, not API mappings. Orchestrate internally.

**Action:** Add convenience tools for multi-step workflows.

---

### Flatten Arguments
**Status:** ✅ Good

Top-level primitives: `prompt:str`, `model:str`, `session_id:str`
Enums for constraints: `cli:enum(claude|codex|gemini)`

**Why:** Avoid nested dictionaries → prevents agent hallucination of keys.

---

### Instructions = Context
**Status:** ✅ Implemented

Tool descriptions: clear, specific
Error messages: actionable guidance

**Example:** "claude CLI not found. Ensure installed and in PATH"

**Pattern:** Docstrings and errors inform agent's next action.

---

### Tool Naming
**Status:** ✅ Compliant

snake_case: `claude_request`, `session_create`, `list_models`

**Why:** Consistent separators (\_) prevent LLM tokenization confusion.

---

### Logging
**Status:** ✅ Implemented

- stderr for logs (stdout = MCP protocol)
- Structured: timestamps, levels, CLI type, model, timing, session IDs

**Enhancement:** File-based logging for production debugging.

---

### Avoid "Not Found" Text
**Status:** ⚠️ Review needed

**Pattern:** Return relevant data on failure, not bare "not found".

---

## Multi-LLM Orchestration

### Pattern 1: Single-Level (Supported)
**Status:** ✅ Production-ready

Parent orchestrates children directly:
```typescript
codex_request({prompt:"Implement X",fullAuto:true})
gemini_request({prompt:"Review X"})
```

**Use:**
- Codex: implementation, code generation
- Claude: code quality, architecture, orchestration
- Gemini: bug finding, edge cases

---

### Pattern 2: Multi-Level (Not Supported)
**Status:** ❌ Architectural limitation

Child cannot orchestrate grandchild:
```typescript
// ❌ FAILS: MCP error -32000
codex_request({
  prompt:"Implement X, then use claude_request for review",
  fullAuto:true
})
```

**Why:** MCP server lifecycle tied to fullAuto context. Nested connections unsupported.

**Discovered:** 2026-01-24 (DOGFOODING_LESSONS.md #4)

---

### Pattern 3: Manual Multi-Level (Recommended)
**Status:** ✅ Production-proven

Parent coordinates all levels:
```typescript
// Step 1: Implementation
impl = codex_request({prompt:"Implement X",fullAuto:true})

// Step 2-3: Reviews (parallel)
review1 = claude_request({prompt:"Review quality",model:"sonnet"})
review2 = gemini_request({prompt:"Review bugs",model:"gemini-2.5-pro"})

// Step 4: Fixes
fixes = codex_request({prompt:`Fix:${review1}${review2}`,fullAuto:true})
```

**Benefits:**
- Full parent control
- Isolated steps
- Parallel reviews
- Clear audit trail

---

### Orchestration Workflow
**Proven pattern:**
```
1. Codex implements
2. Claude reviews (code quality)
3. Gemini reviews (bugs/edge cases)
4. Codex fixes
5. Tests verify
```

**Execution:**
- Parallel: independent reviews
- Sequential: implementation → reviews → fixes

**Error handling:**
- Handle failures per step
- Verify results, don't assume success
- Build/test after code changes

**Documentation:**
- Track which LLM per task
- Capture review findings
- Record metrics by LLM/task

---

### Future Improvements
Potential autonomous multi-level:
1. Batch request tool (multi-sub-requests)
2. Session sharing (inherit parent MCP connection)
3. Async orchestration (fire-and-forget + callbacks)
4. Connection pooling (persistent nested connections)

**Current:** Use manual multi-level until nested supported.

---

## Error Handling

### Pattern: Low-Level Throws, Top-Level Catches
**Status:** ✅ Implemented

- Low-level (`executeCli`): throws errors
- Top-level (tool handlers): catch, format via `createErrorResponse`

**Pattern:** Errors bubble to top-level for consistent formatting.

---

### Error Categorization
**Status:** ✅ Implemented

Transient (retry): 124 (timeout), ECONNRESET, ETIMEDOUT, ECONNREFUSED
Non-transient (fail-fast): ENOENT (CLI not found)

**Action:** Document retryable vs fail-fast per error.

---

### Context-Aware Messages
**Status:** ✅ Good

Exit code context: "Command timed out", "exit code 124"
Actionable: "Ensure claude CLI installed and in PATH"
CLI-specific details

**Pattern:** Human-readable + Actionable + Context-aware.

---

## Retry & Circuit Breaker

### Exponential Backoff
**Status:** ✅ Implemented

Formula: `delay = min(initial * factor^(attempt-1), max)`
Config: 1s initial, 2x factor, 30s max, 5 attempts

⚠️ **Missing:** Jitter to prevent synchronized retries

**Action:** Add jitter:
```typescript
jitter = Math.random()*1000
delay = Math.min(initial*factor**(attempt-1),max)+jitter
```

---

### Circuit Breaker States
**Status:** ✅ Implemented

- CLOSED: normal
- OPEN: fail-fast after threshold
- HALF_OPEN: testing recovery

Config: 5 failures threshold, 60s reset timeout, per-CLI breakers

**Pattern:** Retry respects circuit breaker state, abandons if non-transient fault.

---

### Idempotency
**Status:** ⚠️ Consideration needed

Generally idempotent: read conversations, make requests
Session creation: unique IDs (safe retry)

**Action:** Document idempotency per tool.

---

### Monitoring
**Status:** ✅ Implemented

`getCircuitBreakerStatus()` exports state, callbacks available

**Enhancement:** Expose as MCP resource:
```typescript
// circuit-breakers://status
{claude:{state:"CLOSED",failures:0},codex:{state:"OPEN",failures:5}}
```

---

## Session Management

### Centralized Storage
**Status:** ✅ Implemented

File: `~/.llm-cli-gateway/sessions.json`
- Atomic writes (temp + rename)
- In-memory cache

⚠️ **Scale:** Consider Redis/DynamoDB for production.

**Pattern:** Distributed stores with TTL for cleanup.

---

### Session State Design
**Status:** ✅ Efficient

Minimal state: {id,cli,description,created,lastUsed,active}
No conversation content in state

**Pattern:** Persist only essential data.

---

### Security
**Status:** ⚠️ Enhancement needed

✅ Secure IDs: crypto.randomUUID()
⚠️ File permissions: default
❌ No encryption at rest

**Actions:**
1. Set 0600 permissions on sessions.json
2. Consider encryption for sensitive data
3. Add TTL/expiration

---

### Lifecycle
**Status:** ⚠️ Partial

✅ CRUD operations
✅ Update lastUsed
❌ TTL/expiration missing

**Action:** Add cleanup:
```typescript
cleanupExpiredSessions(maxAge=30*24*60*60*1000) // 30 days
```

---

## Testing

### Organization
**Status:** ✅ Good

Unit: `executor.test.ts`, `session-manager.test.ts`
Integration: `integration.test.ts`
Co-located: `__tests__/` directory

**Pattern:** Separate unit/integration, `describe` blocks, AAA pattern.

---

### Unit vs Integration
**Status:** ✅ Well-separated

Unit (63 tests): SessionManager, executor (mocked)
Integration (41 tests): Full MCP, real CLI calls

**Pattern:** Unit = mock aggressively. Integration = spy, mock external only.

---

### Mocking
**Status:** ✅ Appropriate

Unit: `vi.mock("fs")` for complete replacement
Integration: Real MCP server, real CLI calls

**Pattern:** Complete mock for isolation, observe for integration.

---

### Coverage
**Status:** ✅ Comprehensive (284 tests)

- Executor: errors, timeouts, paths
- Sessions: CRUD, persistence, edge cases, concurrency
- Integration: all tools, cross-client, resources
- Metrics: aggregation, resource exposure

**Pattern:** All paths: happy, edge, error.

---

### Performance
**Status:** ⚠️ Integration slow (~42s)

Real CLI calls: 2-14s each
Total: 284 tests in ~60s

**Options:**
1. Faster models (haiku, flash)
2. Mock more in integration
3. Parallel execution (Vitest default)

---

### Isolation
**Status:** ✅ Good

Each test: own sessions, cleanup
No shared state
Session file cleanup after tests

**Pattern:** Consider `isolate:false` for speedup.

---

## Code Organization

### Single Responsibility
**Status:** ✅ Excellent

- `executor.ts`: CLI execution only
- `session-manager.ts`: persistence only
- `retry.ts`: retry/circuit breaker only
- `resources.ts`: MCP resources only
- `metrics.ts`: performance tracking only
- `index.ts`: MCP server orchestration only

**Pattern:** Bounded context per module.

---

### DRY
**Status:** ✅ Fixed

Previously: CLI_INFO in 2 places
Now: Single source (`resources.ts`), imported

**Lesson:** "Single constant in two places isn't good practice" - User

---

### Type Safety
**Status:** ✅ Strong

TypeScript strict mode
Zod runtime validation
Exported types

**Pattern:** Catch errors at build time.

---

### Separation of Concerns
**Status:** ✅ Good

Business: executor, session-manager, retry, metrics
Protocol: index (MCP server)
Data: resources (MCP resources)
Validation: Zod inline

**Enhancement:** Extract schemas to `schemas.ts`.

---

### Error Consistency
**Status:** ✅ Implemented

Centralized: `createErrorResponse()`
Consistent format across tools
Logging at error points

---

### Documentation
**Status:** ⚠️ Could improve

✅ Tool descriptions (MCP schema)
✅ Code comments (complex areas)
✅ README, BEST_PRACTICES, guides
❌ Missing JSDoc on exports
❌ Missing architecture docs

**Actions:**
1. JSDoc exported functions
2. Document architectural decisions
3. Add examples to README

---

## Priority Improvements

### High
1. **Jitter in retry delays** - Prevent synchronized storms
2. **Session TTL/expiration** - Prevent unbounded growth
3. **Circuit breaker MCP resource** - Better observability
4. **Document idempotency** - Critical for retry safety

### Medium
5. **File-based logging** - Production debugging
6. **Harden session permissions** - Security (0600)
7. **Extract Zod schemas** - Reusability
8. **Architecture docs** - Maintainability

### Low
9. **Redis for sessions** - Scalability (if needed)
10. **Session encryption** - Security (assess risk first)

---

## References

- 15 Best Practices for Building MCP Servers (The New Stack, 2025)
- MCP Server Best Practices 2026 (CData, 2025)
- Docker MCP Catalog Best Practices (2025)
- Model Context Protocol Spec (2025-03-26)
- Retry Pattern with Exponential Back-Off (DZone)
- Application Resiliency Patterns (Microsoft, 2023)
- Mastering Session State Persistence (SparkCo AI, 2025)
- Vitest Best Practices (CursorRules)
- Error Handling in CLI Tools (Medium, 2025)
