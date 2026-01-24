# Contributing to LLM CLI Gateway

## Before You Start

**Read the best practices first:**
```bash
cat BEST_PRACTICES.md
```

Or if you're an LLM working via MCP:
- Use MCP resource: `docs://best-practices`

## Development Workflow

### 1. Setup
```bash
npm install
npm run build
```

### 2. Make Changes
- Follow patterns in BEST_PRACTICES.md
- Write tests as you code
- Use TypeScript strict mode
- Add JSDoc comments for exported functions

### 3. Code Quality
```bash
# Lint your code
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

### 4. Test
```bash
# Run all tests
npm test

# Run specific test file
npm run test:unit
npm run test:session
npm run test:integration

# Run tests in watch mode
npm run test:watch

# Check coverage
npm test -- --coverage
```

### 5. Build
```bash
npm run build
```

## Code Review Checklist

Before submitting PR, verify:
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] Linting passes (`npm run lint`)
- [ ] Code is properly formatted (`npm run format:check`)
- [ ] Test coverage >= 80% for new code
- [ ] No `console.log` statements (use `logger.info/error/debug`)
- [ ] Error messages are actionable and context-aware
- [ ] Tool names use `snake_case`
- [ ] All exported functions have TypeScript return types
- [ ] No duplicate code or constants (DRY principle)
- [ ] BEST_PRACTICES.md updated if new patterns introduced

## Best Practices Highlights

### Tool Naming
✅ CORRECT: `claude_request`, `session_create`, `list_models`
❌ WRONG: `claudeRequest`, `createSession`, `listModels`

### Error Messages
✅ CORRECT: `Session abc123 could not be found. Available sessions: xyz789, def456`
❌ WRONG: `not found`

### Logging
✅ CORRECT: `logger.info("Starting request...")` (goes to stderr)
❌ WRONG: `console.log("Starting...")` (breaks MCP protocol on stdout)

### Type Safety
✅ CORRECT:
```typescript
export async function executeCli(cmd: string, args: string[]): Promise<ExecuteResult> {
  // ...
}
```
❌ WRONG:
```typescript
export async function executeCli(cmd, args) {  // Missing types
  // ...
}
```

### Session State
✅ CORRECT: Store only `{ id, cli, description, timestamps }`
❌ WRONG: Store entire conversation history in session

### DRY Principle
✅ CORRECT: Define constants once, import where needed
❌ WRONG: Copy-paste same constant in multiple files

## Testing Guidelines

### Unit Tests
- Test single functions/classes in isolation
- Mock external dependencies (file system, network, child processes)
- Fast execution (< 100ms per test)

```typescript
// Good unit test example
describe("SessionManager", () => {
  it("should create a new session with unique ID", () => {
    const manager = new SessionManager();
    const session = manager.createSession("claude");
    expect(session.id).toBeDefined();
    expect(session.cli).toBe("claude");
  });
});
```

### Integration Tests
- Test interactions between components
- Test full MCP protocol flows
- Make real CLI calls (slower, but validates end-to-end)

```typescript
// Good integration test example
it("should execute claude request via MCP", async () => {
  const result = await client.callTool({
    name: "claude_request",
    arguments: { prompt: "Say hi", model: "haiku" }
  });
  expect(result.content[0].text).toBeTruthy();
});
```

## Common Mistakes to Avoid

### 1. Breaking MCP Protocol
```typescript
// ❌ WRONG - stdout is reserved for MCP
console.log("Debug info");

// ✅ CORRECT - use stderr
logger.info("Debug info");  // Goes to stderr
```

### 2. Poor Error Messages
```typescript
// ❌ WRONG - Not actionable
throw new Error("not found");

// ✅ CORRECT - Actionable with context
throw new Error(
  `Session ${sessionId} not found. Available sessions: ${availableIds.join(", ")}`
);
```

### 3. Missing Tests
```typescript
// ❌ WRONG - New function without tests
export function newFeature() { ... }

// ✅ CORRECT - Add tests alongside code
// src/new-feature.ts
export function newFeature() { ... }

// src/__tests__/new-feature.test.ts
describe("newFeature", () => {
  it("should work correctly", () => { ... });
});
```

### 4. Ignoring Circuit Breaker
```typescript
// ❌ WRONG - Direct retry without checking circuit breaker
for (let i = 0; i < 5; i++) {
  try { await operation(); break; }
  catch { await sleep(1000); }
}

// ✅ CORRECT - Use withRetry which respects circuit breaker
await withRetry(operation, circuitBreaker, { ... });
```

## Getting Help

- Read [BEST_PRACTICES.md](./BEST_PRACTICES.md) for architectural guidance
- Read [ENFORCEMENT.md](./ENFORCEMENT.md) for enforcement mechanisms
- Check existing code for patterns
- Run tests to understand expected behavior

## For LLM Contributors

If you're an LLM being asked to modify this codebase:

1. **First action:** Read `docs://best-practices` MCP resource
2. **Verify:** Check if the requested change aligns with best practices
3. **Plan:** Outline changes and tests before implementing
4. **Implement:** Follow the patterns in existing code
5. **Validate:** Run build + lint + tests before declaring done
6. **Self-review:** Use the checklist above

### Self-Validation Prompt Template
```
Before finalizing my changes, I verify:

1. ✅ Tool naming: All new tools use snake_case
2. ✅ Error handling: All errors use createErrorResponse()
3. ✅ Logging: Using logger (stderr), not console (stdout)
4. ✅ Testing: Added tests for new functionality
5. ✅ Type safety: All functions have return type annotations
6. ✅ DRY: No duplicate code or constants
7. ✅ Build: TypeScript compiles without errors
8. ✅ Tests: All tests pass

[Run: npm run build && npm run lint && npm test]

Result: [All checks passed / Issues to fix: ...]
```
