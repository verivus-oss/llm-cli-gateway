# Enforcing Best Practices

This document outlines how to ensure adherence to the best practices defined in BEST_PRACTICES.md.

## Multi-Layer Enforcement Strategy

### 1. Make Best Practices Available to LLMs via MCP Resources

**Approach:** Expose best practices as an MCP resource so LLMs working on this codebase can reference them.

**Implementation:**

```typescript
// Add to src/resources.ts
export const BEST_PRACTICES_CONTENT = `... (content from BEST_PRACTICES.md) ...`;

// Add to listResources():
{
  uri: "docs://best-practices",
  name: "Best Practices",
  title: "📚 Development Best Practices",
  description: "Best practices for developing and maintaining this MCP server",
  mimeType: "text/markdown",
  annotations: {
    audience: ["assistant"],
    priority: 0.9
  }
}

// Add to readResource():
if (uri === "docs://best-practices") {
  return {
    uri,
    mimeType: "text/markdown",
    text: fs.readFileSync("./BEST_PRACTICES.md", "utf-8")
  };
}
```

**Benefit:** Any LLM using this MCP server can read the best practices before making changes.

---

### 2. Static Analysis & Linting

**Tools to Add:**

#### ESLint Configuration
```json
// .eslintrc.json
{
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "./tsconfig.json"
  },
  "rules": {
    // Enforce best practices
    "no-console": ["error", { "allow": ["error", "warn"] }],
    "prefer-const": "error",
    "no-var": "error",
    "@typescript-eslint/explicit-function-return-type": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": "error",

    // Naming conventions
    "@typescript-eslint/naming-convention": [
      "error",
      {
        "selector": "function",
        "format": ["camelCase", "snake_case"]
      },
      {
        "selector": "variable",
        "format": ["camelCase", "UPPER_CASE", "snake_case"]
      }
    ]
  }
}
```

#### Prettier Configuration
```json
// .prettierrc
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": false,
  "printWidth": 100,
  "tabWidth": 2
}
```

**Installation:**
```bash
npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier
```

**Package.json scripts:**
```json
{
  "scripts": {
    "lint": "eslint src/**/*.ts",
    "lint:fix": "eslint src/**/*.ts --fix",
    "format": "prettier --write 'src/**/*.ts'",
    "format:check": "prettier --check 'src/**/*.ts'"
  }
}
```

---

### 3. Pre-commit Hooks

**Tool:** Husky + lint-staged

**Installation:**
```bash
npm install --save-dev husky lint-staged
npx husky install
```

**Configuration:**

```json
// package.json
{
  "lint-staged": {
    "*.ts": [
      "eslint --fix",
      "prettier --write",
      "vitest related --run"
    ]
  }
}
```

**Create hook:**
```bash
npx husky add .husky/pre-commit "npx lint-staged"
```

**Enforces:**
- Code formatting
- Linting rules
- Tests must pass before commit
- No console.log statements (except console.error/warn)

---

### 4. CI/CD Pipeline Checks

**GitHub Actions Example:**

```yaml
# .github/workflows/quality-checks.yml
name: Quality Checks

on: [push, pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run build

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Run tests
        run: npm test

      - name: Check test coverage
        run: npm run test -- --coverage --coverage.threshold.lines=80

      - name: Dependency audit
        run: npm audit --audit-level=moderate
```

**Enforces:**
- ✅ TypeScript compiles without errors
- ✅ All linting rules pass
- ✅ Code is properly formatted
- ✅ All tests pass
- ✅ Minimum 80% test coverage
- ✅ No high/critical security vulnerabilities

---

### 5. Custom Validation Rules

**Create custom validators for MCP-specific patterns:**

```typescript
// src/validators/mcp-validators.ts

/**
 * Validates that tool names follow snake_case convention
 */
export function validateToolName(name: string): boolean {
  const snakeCaseRegex = /^[a-z][a-z0-9_]*$/;
  return snakeCaseRegex.test(name);
}

/**
 * Validates that error responses provide actionable context
 */
export function validateErrorMessage(message: string): boolean {
  // Error messages should not start with "not found" or similar
  const badPrefixes = ["not found", "doesn't exist", "does not exist"];
  const lowerMessage = message.toLowerCase();
  return !badPrefixes.some(prefix => lowerMessage.startsWith(prefix));
}

/**
 * Validates that tool descriptions are clear and specific
 */
export function validateToolDescription(description: string): boolean {
  // Must be at least 20 characters and contain action words
  if (description.length < 20) return false;

  const actionWords = ["create", "get", "list", "delete", "update", "execute", "manage"];
  const lowerDesc = description.toLowerCase();
  return actionWords.some(word => lowerDesc.includes(word));
}

// Test these validators
// src/__tests__/validators.test.ts
import { describe, it, expect } from "vitest";
import { validateToolName, validateErrorMessage, validateToolDescription } from "../validators/mcp-validators";

describe("MCP Validators", () => {
  describe("validateToolName", () => {
    it("should accept snake_case names", () => {
      expect(validateToolName("claude_request")).toBe(true);
      expect(validateToolName("session_create")).toBe(true);
      expect(validateToolName("list_models")).toBe(true);
    });

    it("should reject non-snake_case names", () => {
      expect(validateToolName("claudeRequest")).toBe(false);
      expect(validateToolName("Claude-Request")).toBe(false);
      expect(validateToolName("Claude Request")).toBe(false);
    });
  });

  describe("validateErrorMessage", () => {
    it("should reject messages starting with 'not found'", () => {
      expect(validateErrorMessage("not found: session xyz")).toBe(false);
      expect(validateErrorMessage("Not found")).toBe(false);
    });

    it("should accept actionable error messages", () => {
      expect(validateErrorMessage("Session xyz could not be retrieved. Available sessions: ...")).toBe(true);
      expect(validateErrorMessage("Command failed with exit code 1. Please check...")).toBe(true);
    });
  });
});
```

---

### 6. Runtime Validation

**Add runtime checks in critical paths:**

```typescript
// src/index.ts - Add validation when registering tools

function registerToolWithValidation(
  name: string,
  schema: any,
  description: string,
  handler: Function
) {
  // Validate tool name
  if (!validateToolName(name)) {
    throw new Error(
      `Tool name "${name}" does not follow snake_case convention. ` +
      `See BEST_PRACTICES.md section "Tool Naming Standards"`
    );
  }

  // Validate description
  if (!validateToolDescription(description)) {
    throw new Error(
      `Tool description for "${name}" is not clear enough. ` +
      `See BEST_PRACTICES.md section "Instructions Are Context"`
    );
  }

  // Register the tool
  server.tool(name, schema, handler);
}
```

---

### 7. Documentation & Prompts

#### A. Create a .cursorrules file for AI assistants

```markdown
# .cursorrules
You are working on the llm-cli-gateway MCP server.

CRITICAL: Before making ANY changes to this codebase:
1. Read the best practices: Use the MCP resource "docs://best-practices"
2. Follow ALL conventions outlined in BEST_PRACTICES.md

Key Rules:
- Tool names MUST use snake_case (e.g., claude_request, not claudeRequest)
- Error messages MUST be actionable, not just "not found"
- Logging MUST go to stderr, never stdout (MCP protocol uses stdout)
- All exported functions MUST have TypeScript return types
- Session state MUST be minimal - only IDs and metadata
- Circuit breaker state MUST be respected in retry logic
- Tests MUST be added for any new functionality
- DRY principle - no duplicate constants or logic

When adding new tools:
1. Use Zod for input validation
2. Provide clear descriptions (20+ chars with action words)
3. Return structured error responses via createErrorResponse()
4. Add unit AND integration tests
5. Update BEST_PRACTICES.md if introducing new patterns

When adding retry/resilience logic:
1. Always add jitter to exponential backoff
2. Ensure operations are idempotent
3. Use appropriate circuit breaker
4. Log retry attempts with context

Test Requirements:
- Minimum 80% coverage
- Both unit tests (isolation) and integration tests (real calls)
- Follow AAA pattern (Arrange, Act, Assert)
```

#### B. Add a CONTRIBUTING.md

```markdown
# Contributing to LLM CLI Gateway

## Before You Start

**Read the best practices first:**
```bash
cat BEST_PRACTICES.md
```

Or if you're an LLM working via MCP:
- Use MCP resource: `docs://best-practices`

## Development Workflow

1. **Setup**
   ```bash
   npm install
   npm run build
   ```

2. **Make Changes**
   - Follow patterns in BEST_PRACTICES.md
   - Write tests as you code
   - Lint and format: `npm run lint:fix && npm run format`

3. **Test**
   ```bash
   npm test
   npm run test -- --coverage
   ```

4. **Commit**
   - Pre-commit hooks will run automatically
   - Ensure all checks pass

## Code Review Checklist

Before submitting PR, verify:
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run build`)
- [ ] Linting passes (`npm run lint`)
- [ ] Code is formatted (`npm run format:check`)
- [ ] Test coverage >= 80%
- [ ] No console.log statements (use logger)
- [ ] Error messages are actionable
- [ ] Tool names use snake_case
- [ ] Best practices document updated (if new patterns added)
```

---

### 8. Automated Code Review

**Install danger.js for automated PR reviews:**

```typescript
// dangerfile.ts
import { danger, warn, fail, message } from "danger";

// Check for best practices document updates
const modifiedFiles = danger.git.modified_files;
const createdFiles = danger.git.created_files;

// New tools require best practices review
const hasNewTools = modifiedFiles.includes("src/index.ts") &&
                    danger.git.diffForFile("src/index.ts").then(diff =>
                      diff?.added.includes("server.tool(")
                    );

if (hasNewTools) {
  message("⚠️ New tool detected. Ensure it follows BEST_PRACTICES.md conventions.");
}

// Warn if best practices not updated with new patterns
const hasNewRetryLogic = modifiedFiles.includes("src/retry.ts");
const updatedBestPractices = modifiedFiles.includes("BEST_PRACTICES.md");

if ((hasNewTools || hasNewRetryLogic) && !updatedBestPractices) {
  warn("Consider updating BEST_PRACTICES.md if you introduced new patterns.");
}

// Fail if console.log detected
const hasConsoleLogs = danger.git.diffForFile("src/**/*.ts").then(diff =>
  diff?.added.match(/console\.log/)
);

if (hasConsoleLogs) {
  fail("❌ Found console.log statements. Use logger.info/error/debug instead.");
}

// Check test coverage in PR
const testFiles = modifiedFiles.filter(f => f.includes(".test.ts"));
const sourceFiles = modifiedFiles.filter(f => f.endsWith(".ts") && !f.includes("test"));

if (sourceFiles.length > testFiles.length) {
  warn("📝 More source files than test files changed. Consider adding tests.");
}
```

---

### 9. Monitoring & Observability

**Add runtime best practices adherence monitoring:**

```typescript
// src/metrics.ts
export interface BestPracticeViolation {
  rule: string;
  severity: "error" | "warning";
  context: string;
  timestamp: Date;
}

class BestPracticesMonitor {
  private violations: BestPracticeViolation[] = [];

  recordViolation(rule: string, severity: "error" | "warning", context: string) {
    this.violations.push({
      rule,
      severity,
      context,
      timestamp: new Date()
    });

    logger.warn(`[Best Practice Violation] ${rule}: ${context}`);
  }

  getViolations() {
    return this.violations;
  }

  // Expose via MCP resource
  getViolationsReport() {
    const grouped = this.violations.reduce((acc, v) => {
      acc[v.rule] = (acc[v.rule] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      total: this.violations.length,
      byRule: grouped,
      recent: this.violations.slice(-10)
    };
  }
}

export const monitor = new BestPracticesMonitor();

// Use in code
if (!validateToolName(name)) {
  monitor.recordViolation(
    "TOOL_NAMING_CONVENTION",
    "error",
    `Tool "${name}" does not use snake_case`
  );
}
```

---

## Implementation Priority

### Phase 1: Immediate (No LLM needed)
1. ✅ Create BEST_PRACTICES.md (done)
2. ✅ Create this ENFORCEMENT.md (in progress)
3. Add .cursorrules file
4. Add CONTRIBUTING.md

### Phase 2: Development Tools (1-2 hours)
5. Install and configure ESLint + Prettier
6. Add npm scripts for linting/formatting
7. Create custom MCP validators
8. Add validator tests

### Phase 3: Automation (2-4 hours)
9. Setup Husky + lint-staged
10. Create GitHub Actions workflow
11. Add best practices as MCP resource
12. Setup Danger.js

### Phase 4: Monitoring (Optional)
13. Add best practices violation tracking
14. Expose metrics via MCP resource
15. Add alerting for repeated violations

---

## Testing Enforcement

**Verify enforcement is working:**

```bash
# Test 1: Try to commit code with console.log
echo "console.log('test');" >> src/index.ts
git add src/index.ts
git commit -m "test"  # Should fail with pre-commit hook

# Test 2: Try to build with linting errors
npm run lint  # Should show errors

# Test 3: Try to format check
npm run format:check  # Should pass

# Test 4: Run CI checks locally
npm run build && npm run lint && npm test
```

---

## For LLMs: Self-Enforcement Checklist

When an LLM (Claude, Codex, Gemini) is asked to modify this codebase:

**Before making changes:**
- [ ] Read `docs://best-practices` MCP resource (or BEST_PRACTICES.md)
- [ ] Check existing code patterns in the relevant file
- [ ] Verify tool naming convention if adding new tools
- [ ] Plan tests alongside code changes

**While making changes:**
- [ ] Follow snake_case for tool names
- [ ] Use Zod for input validation
- [ ] Provide actionable error messages
- [ ] Add JSDoc comments for exported functions
- [ ] Respect circuit breaker state in retry logic
- [ ] Keep session state minimal

**After making changes:**
- [ ] Run `npm run build` - verify TypeScript compiles
- [ ] Run `npm run lint` - verify linting passes
- [ ] Run `npm test` - verify all tests pass
- [ ] Add tests for new functionality
- [ ] Update BEST_PRACTICES.md if introducing new patterns

**Self-validation prompt:**
```
Before finalizing my changes, let me verify adherence to best practices:

1. Tool naming: [Check tool names are snake_case]
2. Error handling: [Check errors use createErrorResponse()]
3. Logging: [Check using stderr, not stdout]
4. Testing: [Check tests added for new code]
5. Type safety: [Check all functions have return types]
6. DRY: [Check for duplicate code/constants]

If any violations found, fix them now.
```
