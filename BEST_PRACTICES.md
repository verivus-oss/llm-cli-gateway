# Best Practices for LLM CLI Gateway

This document outlines design and implementation best practices collected from industry sources, specifically tailored for this MCP server implementation.

## Table of Contents
- [MCP Server Design](#mcp-server-design)
- [Multi-LLM Orchestration Patterns](#multi-llm-orchestration-patterns)
- [Error Handling](#error-handling)
- [Retry & Circuit Breaker Patterns](#retry--circuit-breaker-patterns)
- [Session Management](#session-management)
- [Testing Strategy](#testing-strategy)
- [Code Organization](#code-organization)

---

## MCP Server Design

### 1. Treat Server as a Bounded Context
**Current Status:** ✅ Implemented
- Our server focuses on a single domain: CLI gateway orchestration
- Tools are cohesive: `claude_request`, `codex_request`, `gemini_request`, session management
- Each tool has clear JSON schema inputs/outputs

**Recommendation:** Continue maintaining this focused scope. Avoid adding unrelated functionality.

### 2. Design Tools Around Outcomes, Not Operations
**Current Status:** ⚠️ Partial
- Good: `session_create` combines creation + optional activation in one call
- Could improve: Consider higher-level tools like `ask_claude_with_context(question, session_id)` that handle common orchestration patterns

**Recommendation from research:**
> "Design tools around what the agent wants to achieve, not API mappings. Perform internal orchestration in the server code, not in the LLM's context window."

**Action:** Consider adding convenience tools for common multi-step workflows.

### 3. Flatten Your Arguments
**Current Status:** ✅ Good
- We use top-level primitives: `prompt: string`, `model: string`, `sessionId: string`
- Enums are used appropriately: `cli: z.enum(["claude", "codex", "gemini"])`

**Why this matters:**
> "Use top-level primitives and constrained types (like Literal) instead of complex nested dictionaries to avoid agent hallucination of keys."

### 4. Instructions Are Context
**Current Status:** ✅ Implemented
- Tool descriptions are clear and specific
- Error messages provide actionable guidance to the agent
- Example: "The 'claude' command was not found. Please ensure claude CLI is installed..."

**Best Practice from research:**
> "Treat docstrings and error messages as crucial context. Error handling should inform the agent what to do next, not just return human-readable errors."

### 5. Tool Naming Standards
**Current Status:** ✅ Compliant
- Using snake_case: `claude_request`, `session_create`, `list_models`
- Consistent naming across all tools

**Why snake_case matters:**
> "Avoid spaces, dots (.), and brackets. Deviating from conventions like dash (-) or underscore (_) separators can confuse LLM tokenization and prevent MCP Clients from calling the tool."

### 6. Logging Best Practices
**Current Status:** ✅ Implemented
- Using stderr for logs (stdout reserved for MCP protocol)
- Structured logging with timestamps and levels
- Key fields captured: CLI type, model, timing, session IDs

**Research recommendation:**
> "Since STDIO channel is used for client-server communication, use file logging (e.g., pino) for troubleshooting."

**Future Enhancement:** Consider adding file-based logging for production debugging.

### 7. Avoid "Not Found" Response Text
**Current Status:** ⚠️ Review needed
- Check our error messages to ensure we provide useful context even for failures

**Research warning:**
> "When a tool call returns no result, avoid starting the response with 'not found.' Provide as much generalized, relevant data as possible, as the LLM may be steered away from useful data."

---

## Multi-LLM Orchestration Patterns

### 1. Single-Level Orchestration (Supported)
**Pattern:** Parent LLM orchestrates child LLMs directly

**Example:**
```typescript
// Claude orchestrates Codex for implementation
await codex_request({
  prompt: "Implement feature X",
  fullAuto: true
});

// Claude orchestrates Gemini for review
await gemini_request({
  prompt: "Review implementation of feature X"
});
```

**Status:** ✅ Fully supported and production-ready

**Use cases:**
- Implementation: Use Codex for code generation
- Review: Use Claude for code quality, Gemini for bug finding
- Specialized tasks: Route to appropriate LLM based on strength

---

### 2. Multi-Level Orchestration (Architectural Limitation)
**Pattern:** Child LLM tries to orchestrate grandchild LLMs

**Example that DOESN'T work:**
```typescript
// This will FAIL with "MCP error -32000: Connection closed"
await codex_request({
  prompt: "Implement feature X, then use claude_request to get a review",
  fullAuto: true
});
// ❌ The claude_request call from within Codex will fail
```

**Why it fails:**
- MCP server lifecycle is tied to the fullAuto execution context
- Nested MCP connections from within a subprocess are not supported
- The connection closes when a child tries to spawn a grandchild

**Status:** ❌ Not supported (architectural limitation)

**Discovered:** 2026-01-24 during performance metrics implementation (see DOGFOODING_LESSONS.md Issue #4)

---

### 3. Manual Multi-Level Orchestration (Recommended Pattern)
**Pattern:** Parent orchestrates each level manually

**Example that DOES work:**
```typescript
// Step 1: Parent → Child (implementation)
const implementation = await codex_request({
  prompt: "Implement feature X",
  fullAuto: true
});

// Step 2: Parent → Child (review #1)
const claudeReview = await claude_request({
  prompt: "Review this implementation for code quality...",
  model: "sonnet"
});

// Step 3: Parent → Child (review #2)
const geminiReview = await gemini_request({
  prompt: "Review this implementation for bugs...",
  model: "gemini-2.5-pro"
});

// Step 4: Parent → Child (fixes)
const fixes = await codex_request({
  prompt: `Fix these issues:\n${claudeReview}\n${geminiReview}`,
  fullAuto: true
});
```

**Status:** ✅ Fully supported and proven in production

**Benefits:**
- Parent maintains full control over workflow
- Each step is isolated and verifiable
- Reviews can run in parallel if independent
- Clear audit trail of orchestration

---

### 4. Orchestration Best Practices

**Choose the right LLM for each task:**
- **Codex**: Fast implementation, code generation
- **Claude**: Code quality review, architecture analysis, orchestration
- **Gemini**: Bug finding, edge case analysis

**Proven workflow pattern:**
```
1. Codex implements feature
2. Claude reviews for code quality
3. Gemini reviews for bugs/edge cases
4. Codex fixes issues found
5. Tests verify all changes
```

**Parallel vs Sequential:**
- Reviews can run in parallel (independent)
- Implementation must precede reviews (sequential)
- Fixes must follow reviews (sequential)

**Error handling:**
- Each orchestration step should handle failures independently
- Don't assume child LLM success - verify results
- Build/test verification after code changes

**Documentation:**
- Document which LLM performed each task
- Capture review findings for audit trail
- Track metrics on LLM performance per task type

---

### 5. Future Considerations

**Potential improvements to enable autonomous multi-level orchestration:**
1. **Batch request tool**: Package multiple sub-requests in a single call
2. **Session sharing**: Allow child LLMs to inherit parent's MCP connection
3. **Async orchestration**: Support fire-and-forget sub-tasks with callbacks
4. **Connection pooling**: Maintain persistent MCP connections for nested calls

**Current recommendation:** Use manual multi-level orchestration pattern until architecture supports nested connections.

---

## Error Handling

### 1. Error Handling in CLI Tools Pattern
**Current Status:** ✅ Implemented
- We throw errors from low-level functions (executeCli)
- Top-level tool handlers catch and format errors consistently
- Use `createErrorResponse` for standardized error formatting

**Best Practice from research:**
> "Low-level functions should throw errors. These errors bubble up to the top-level command handler, which catches them once and displays a friendly, consistent message."

### 2. Error Categorization
**Current Status:** ✅ Implemented in retry logic
- Transient errors: timeout (124), ECONNRESET, ETIMEDOUT, ECONNREFUSED
- Non-transient errors: ENOENT (command not found)

**Recommendation:** Document which errors are retryable vs. fail-fast.

### 3. Context-Aware Error Messages
**Current Status:** ✅ Good
- Exit code context: "Command timed out", "exit code 124"
- Actionable guidance: "Please ensure claude CLI is installed and in your PATH"
- CLI-specific context in error messages

**Research guideline:**
> "Ensure failures are Human-readable, Actionable, and Context-aware."

---

## Retry & Circuit Breaker Patterns

### 1. Exponential Backoff Implementation
**Current Status:** ✅ Implemented
- Formula: `delay = min(initialDelay * factor^(attempt-1), maxDelay)`
- Current config: 1s initial, 2x factor, 30s max
- Default: 5 retry attempts

**Best Practices from research:**
- ✅ Use exponential backoff to prevent overwhelming degraded services
- ✅ Set sensible upper limit (our max: 30s)
- ⚠️ **Consider adding jitter** to prevent synchronized retries

**Jitter Recommendation:**
> "Add randomness to wait intervals: `wait_interval = (base * 2^n) +/- (random_interval)` to break synchronization and smooth load distribution."

**Action:** Add jitter to retry delays:
```typescript
const jitter = Math.random() * 1000; // 0-1000ms
const delay = Math.min(options.initialDelay * options.factor ** (attempt - 1), options.maxDelay) + jitter;
```

### 2. Circuit Breaker States
**Current Status:** ✅ Implemented
- CLOSED: Normal operation
- OPEN: Failing fast after threshold
- HALF_OPEN: Testing recovery

**Configuration:**
- Failure threshold: 5 consecutive failures
- Reset timeout: 60 seconds
- Per-CLI circuit breakers (claude, codex, gemini, default)

**Best Practice from research:**
> "Combine Retry pattern with Circuit Breaker. Retry logic should be sensitive to exceptions returned by circuit breaker and abandon attempts if fault is not transient."

**Current Implementation:** ✅ Our retry logic respects circuit breaker state.

### 3. Idempotency Consideration
**Current Status:** ⚠️ Consideration needed
- Our CLI commands are generally idempotent (reading conversations, making requests)
- Session creation uses unique IDs, safe to retry

**Research warning:**
> "Operations should be idempotent when using retry patterns to avoid corrupting system state from partial updates."

**Action:** Document idempotency guarantees for each tool.

### 4. Monitoring Circuit Breaker Status
**Current Status:** ✅ Implemented
- `getCircuitBreakerStatus()` exports current state
- State change callbacks available

**Future Enhancement:** Expose circuit breaker status via MCP resource:
```typescript
// Resource: circuit-breakers://status
{
  "claude": { "state": "CLOSED", "failures": 0, ... },
  "codex": { "state": "OPEN", "failures": 5, ... }
}
```

---

## Session Management

### 1. Centralized State Storage
**Current Status:** ✅ Implemented
- File-based persistence: `~/.llm-cli-gateway/sessions.json`
- Atomic writes with temp file + rename
- In-memory cache for fast access

**Best Practices from research:**
- ✅ Centralized session store for consistency
- ✅ State persisted outside application memory
- ⚠️ **Consider Redis or database** for high-scale production

**Scalability Path:**
> "Use distributed session stores like Redis or DynamoDB for production. Implement TTL policies for data cleanup."

### 2. Session State Design
**Current Status:** ✅ Efficient
- Minimal state stored: id, cli, description, timestamps
- No conversation content in session state
- Active session tracking per CLI type

**Research recommendation:**
> "Maintain concise session states, persisting only essential data like user context and preferences to minimize overhead."

### 3. Security Considerations
**Current Status:** ⚠️ Enhancement needed
- Session IDs use crypto.randomUUID() (secure)
- File permissions: default (could be hardened)
- No encryption at rest

**Best Practices from research:**
> "Encrypt session data at rest and in transit. Implement robust authentication protocols (OAuth 2.0)."

**Actions:**
1. Set restrictive file permissions (0600) on sessions.json
2. Consider encrypting sensitive session data
3. Add session expiration/TTL

### 4. Avoid Session Affinity in Distributed Systems
**Current Status:** ✅ N/A (single instance)
- Our session store is shared (file-based)
- No instance stickiness required

**Future consideration:**
> "Avoid storing session state in memory. Design for statelessness or use external stores so any instance can handle any request."

### 5. Session Lifecycle Management
**Current Status:** ⚠️ Partial
- Creation, retrieval, deletion: ✅
- Update last used time: ✅
- TTL/expiration: ❌ Missing

**Action:** Add session expiration:
```typescript
// Clean up sessions older than 30 days
cleanupExpiredSessions(maxAge: number = 30 * 24 * 60 * 60 * 1000)
```

---

## Testing Strategy

### 1. Test Organization
**Current Status:** ✅ Good
- Unit tests: `executor.test.ts`, `session-manager.test.ts`
- Integration tests: `integration.test.ts`
- Tests co-located with source in `__tests__` directory

**Best Practices from research:**
- ✅ Separate unit and integration tests
- ✅ Tests close to source code
- ✅ Use `describe` blocks for grouping

**Vitest Best Practice:**
> "Group related tests using describe blocks and follow the AAA (Arrange, Act, Assert) pattern for clarity."

### 2. Unit vs Integration Testing
**Current Status:** ✅ Well-separated
- **Unit tests (63 tests):** SessionManager, executor logic in isolation
- **Integration tests (41 tests):** Full MCP protocol, actual CLI calls

**Research recommendation:**
> "Unit Tests: Mock aggressively to isolate the component. Integration Tests: Spy on internal logic, only mock external services."

**Current approach:** ✅ Integration tests make real CLI calls (good for validation)

### 3. Mocking Strategy
**Current Status:** ✅ Appropriate
- Unit tests: Mock file system, child processes
- Integration tests: Real MCP server instance, real CLI calls

**Vitest Best Practice:**
> "Use vi.mock() for complete replacement in unit tests. Use vi.spyOn() to observe behavior in integration tests."

**Example from our tests:**
```typescript
// Unit test: Complete mock
vi.mock("fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));

// Integration test: Real calls
const result = await client.callTool({ name: "claude_request", ... });
```

### 4. Test Coverage
**Current Status:** ✅ Comprehensive (104 tests)
- Executor: Error handling, timeouts, path resolution
- Sessions: CRUD, persistence, edge cases, concurrent access
- Integration: All tools, cross-client sharing, resources

**Best Practice from research:**
> "Ensure all code paths are covered, including edge cases and error scenarios."

### 5. Test Performance
**Current Status:** ⚠️ Integration tests are slow (40s)
- Real CLI calls take time (2-14 seconds each)
- Total: 104 tests in ~42 seconds

**Optimization options:**
1. Use faster models for tests (haiku, flash)
2. Mock more aggressively in some integration tests
3. Parallel test execution (Vitest default)

### 6. Test Isolation
**Current Status:** ✅ Good
- Each test creates/cleans up its own sessions
- No shared state between tests
- Session file cleaned up after tests

**Research recommendation:**
> "Disable isolation for specific test files to potentially speed up unit tests (set isolate: false in vitest config)."

---

## Code Organization

### 1. Single Responsibility Principle
**Current Status:** ✅ Excellent
- `executor.ts`: CLI command execution only
- `session-manager.ts`: Session persistence only
- `retry.ts`: Retry/circuit breaker logic only
- `resources.ts`: MCP resource definitions only
- `index.ts`: MCP server orchestration only

**Best Practice from research:**
> "Treat each server as a bounded context. Focus on specific, well-defined capabilities."

### 2. DRY Principle
**Current Status:** ✅ Fixed (was ❌)
- Previously: CLI_INFO defined in two places
- Now: Single source of truth in `resources.ts`, imported by `index.ts`

**Lesson learned:**
> "Having a single constant defined in two places doesn't seem like good practice" - User feedback

### 3. Type Safety
**Current Status:** ✅ Strong
- Full TypeScript with strict mode
- Zod schemas for runtime validation
- Exported types for reusability

**TypeScript Best Practice:**
> "Use TypeScript to catch errors at build time and make code more predictable."

### 4. Separation of Concerns
**Current Status:** ✅ Good
- Business logic: `executor.ts`, `session-manager.ts`, `retry.ts`
- Protocol layer: `index.ts` (MCP server)
- Data layer: `resources.ts` (MCP resources)
- Validation: Zod schemas inline with tools

**Potential improvement:** Extract Zod schemas to separate file for reusability:
```typescript
// schemas.ts
export const ClaudeRequestSchema = z.object({ ... });
```

### 5. Error Handling Consistency
**Current Status:** ✅ Implemented
- Centralized: `createErrorResponse()` helper
- Consistent format across all tools
- Logging at error points

### 6. Documentation
**Current Status:** ⚠️ Could improve
- ✅ Tool descriptions in MCP schema
- ✅ Code comments in complex areas (retry logic)
- ✅ README exists
- ❌ Missing: Architecture documentation
- ❌ Missing: API documentation for exported functions

**Actions:**
1. Add JSDoc comments to exported functions
2. Document architecture decisions (why circuit breakers per CLI?)
3. Add examples to README

---

## Recommended Improvements Priority

### High Priority
1. **Add jitter to retry delays** - Prevents synchronized retry storms
2. **Implement session TTL/expiration** - Prevents unbounded storage growth
3. **Expose circuit breaker status as MCP resource** - Better observability
4. **Document idempotency guarantees** - Critical for retry safety

### Medium Priority
5. **Add file-based logging option** - Better production debugging
6. **Harden session file permissions** - Security improvement
7. **Extract Zod schemas to separate file** - Better reusability
8. **Add architecture documentation** - Maintainability

### Low Priority
9. **Consider Redis for session storage** - Scalability (only if needed)
10. **Add session encryption at rest** - Security (assess risk first)

---

## References

Research sources consulted:
- 15 Best Practices for Building MCP Servers in Production (The New Stack, 2025)
- MCP Server Best Practices for 2026 (CData, 2025)
- Docker MCP Catalog Best Practices (2025)
- Model Context Protocol Architecture Specification (2025-03-26)
- Understanding Retry Pattern With Exponential Back-Off and Circuit Breaker Pattern (DZone)
- Application Resiliency Patterns (Microsoft, 2023)
- Mastering Session State Persistence (SparkCo AI, 2025)
- Tracking Sessions (Dr. Stearns Tutorial, 2021)
- Vitest Best Practices and Coding Standards (CursorRules)
- Error Handling in CLI Tools (Medium, 2025)
