# Prompt Optimization Examples for MCP Gateway

**Purpose:** Real-world before/after examples of token-efficient prompts for LLM CLI tools

**Applies to:** claude_request, codex_request, gemini_request via llm-cli-gateway

**Token Savings:** 35-50% reduction with maintained clarity

---

## Quick Reference

| Technique | Before | After | Savings |
|-----------|--------|-------|---------|
| **Remove filler** | "Please fix the bug found in..." | "Fix bug in..." | 60% |
| **Terse descriptions** | "Problem: The code has..." | State problem directly | 45% |
| **Inline locations** | "in the file src/index.ts on line 430" | "src/index.ts:430" | 70% |
| **Arrow notation** | "Change X to Y" | "X → Y" | 50% |
| **Implicit context** | "the critical bugs found in the product review" | "3 bugs:" | 75% |

---

## Example 1: Bug Fix Request (Codex)

### Before (VERBOSE - 450 tokens)

```
Fix the 3 critical bugs found in the product review:

1. **session_set_active schema bug** (src/index.ts line ~430)
   - Current: `sessionId: z.string().describe("Session ID (null to clear)")`
   - Problem: Says "null to clear" but z.string() rejects null
   - Fix: Change to `z.string().nullable()` or `z.union([z.string(), z.null()])`

2. **Session persistence race conditions** (src/session-manager.ts lines 57, 133)
   - Problem: writeFileSync with no file locking - concurrent writes corrupt data
   - Fix: Implement atomic writes using temp file + rename pattern:
     ```typescript
     const tempFile = sessionFile + '.tmp';
     writeFileSync(tempFile, JSON.stringify(sessions, null, 2));
     renameSync(tempFile, sessionFile);
     ```

3. **Retry/circuit breaker unused** (src/retry.ts)
   - Problem: Entire module exists but executeCli doesn't use withRetry or CircuitBreaker
   - Fix: Integrate retry logic into executor.ts executeCli function OR document why it's intentionally unused

Please:
1. Read the affected files first
2. Make the fixes
3. Run npm test to verify
4. Show the changes made
```

### After (OPTIMIZED - 250 tokens, 44% reduction)

```
Fix 3 bugs:

1. src/index.ts:430 - session_set_active schema
   z.string().describe("null to clear") → z.string().nullable()

2. src/session-manager.ts:57,133 - race conditions
   writeFileSync(file, data) → writeFileSync(file+'.tmp', data); renameSync(file+'.tmp', file)

3. src/retry.ts + src/executor.ts - unused module
   Integrate withRetry/CircuitBreaker into executeCli OR document why unused

Tasks: Read files → implement → npm test → show diff
```

**Optimizations applied:**
- Removed "found in the product review" (implicit context)
- Inline file locations: "line ~430" → ":430"
- Arrow notation: "Change X to Y" → "X → Y"
- Removed "Please" and bullets in task list
- Removed "Problem:" labels (state directly)
- Kept code examples but condensed formatting

---

## Example 2: Code Review Request (Gemini)

### Before (VERBOSE - 380 tokens)

```
Please review the following implementation for bugs and best practices:

I just implemented correlation ID tracking across 3 CLI tools in the llm-cli-gateway. The implementation includes:

1. Import randomUUID from crypto module
2. Add correlationId parameter to 3 tool schemas (claude_request, codex_request, gemini_request)
3. Generate IDs when not provided: `const corrId = correlationId || randomUUID()`
4. Update 21 logger.info calls with `[${corrId}]` prefix for tracing
5. Pass correlation ID to executeCli function

Could you check:
- Are there any bugs in the implementation?
- Did I miss any error handling cases?
- Are the correlation IDs properly propagated through all code paths?
- Is the logging format consistent?
- Any best practices I should follow?

Please provide specific line numbers and concrete examples if you find issues.
```

### After (OPTIMIZED - 180 tokens, 53% reduction)

```
Review correlation ID implementation for bugs:

Changes:
1. Import randomUUID from crypto
2. Add correlationId param to 3 tool schemas
3. Generate: corrId = correlationId || randomUUID()
4. Update 21 logger.info: [${corrId}] prefix
5. Pass corrId to executeCli

Check:
- Bugs or missed error paths?
- IDs propagated through all paths?
- Logging consistent?
- Best practices?

Include line numbers + examples for issues found.
```

**Optimizations applied:**
- Removed "Please review the following"
- Removed "I just implemented" (implicit)
- Removed "(claude_request, codex_request, gemini_request)" (implicit from "3 tools")
- Removed "Could you" and "Are there any" (direct questions)
- Removed "Did I miss any" → "missed?"
- Last line: command, not request

---

## Example 3: Feature Implementation (Codex)

### Before (VERBOSE - 520 tokens)

```
I need you to implement a new feature for session management in the llm-cli-gateway.

The feature should add a new MCP tool called `session_export` that allows users to export all sessions for a specific CLI tool to a JSON file.

Requirements:
1. Add a new tool to src/index.ts with the following parameters:
   - `cli`: string enum of ["claude", "codex", "gemini"] to specify which CLI's sessions to export
   - `outputPath`: string for the file path where the JSON should be written
   - `includeInactive`: optional boolean (default false) to include inactive sessions

2. The tool should:
   - Get all sessions for the specified CLI using sessionManager.listSessions(cli)
   - Filter out inactive sessions unless includeInactive is true
   - Write the sessions to the outputPath as formatted JSON
   - Return a success message with the count of sessions exported

3. Error handling:
   - Validate that the outputPath is writable
   - Handle file system errors gracefully
   - Return clear error messages

4. Add unit tests in src/__tests__/session-manager.test.ts covering:
   - Export with active sessions only
   - Export with includeInactive flag
   - Error handling for invalid paths

Please implement this feature following the existing code patterns in the gateway.
```

### After (OPTIMIZED - 260 tokens, 50% reduction)

```
Implement session_export MCP tool:

Tool spec (src/index.ts):
- cli: enum["claude","codex","gemini"] - which CLI
- outputPath: string! - JSON output file
- includeInactive: bool=false - include inactive sessions

Logic:
1. sessions = sessionManager.listSessions(cli)
2. if !includeInactive: filter active only
3. writeFileSync(outputPath, JSON.stringify(sessions, null, 2))
4. return {count, path}

Error handling:
- Validate outputPath writable
- Catch fs errors → clear messages

Tests (src/__tests__/session-manager.test.ts):
- Active only export
- includeInactive=true
- Invalid path error

Follow existing patterns.
```

**Optimizations applied:**
- Removed "I need you to" and "The feature should"
- Inline types: "string enum" → "enum[...]"
- Constraints: "(default false)" → "=false"
- Required: explicit "!" or implicit
- Removed "should", "please", "covering"
- Condensed logic to numbered steps
- Arrow notation for return value

---

## Example 4: Product Review Request (Multi-LLM)

### Before (VERBOSE - 340 tokens)

```
I would like you to perform a comprehensive product review of the llm-cli-gateway from your perspective as an expert LLM.

Please evaluate the following aspects:
1. Overall architecture and design quality
2. Code quality and implementation patterns
3. Documentation completeness and clarity
4. Testing coverage and quality
5. Production readiness
6. Security considerations
7. Scalability and performance
8. Innovation and unique value proposition

For each aspect, please provide:
- A rating (1-10 or ⭐ stars)
- Key strengths you observe
- Critical weaknesses or gaps
- Specific recommendations for improvement

Please be thorough and honest in your assessment. Include specific file names and line numbers when referencing code issues.

The goal is to validate the product through self-dogfooding and identify any critical bugs before the 1.0 release.
```

### After (OPTIMIZED - 160 tokens, 53% reduction)

```
Product review of llm-cli-gateway (self-dogfooding):

Evaluate:
1. Architecture/design
2. Code quality
3. Documentation
4. Testing
5. Production readiness
6. Security
7. Scalability/performance
8. Innovation/value

Per aspect: rating, strengths, weaknesses, recommendations

Include file:line for code issues.
Goal: Find critical bugs before 1.0.
```

**Optimizations applied:**
- Removed "I would like you to perform"
- Removed "from your perspective as an expert LLM" (implicit)
- Removed "please provide" and "please be"
- Slash notation: "and" → "/"
- Removed "Key" and "Specific" (adjectives)
- Removed "The goal is to validate" → "Goal:"

---

## Example 5: Documentation Task (Claude)

### Before (VERBOSE - 280 tokens)

```
I need you to help me create comprehensive documentation for the new prompt optimization feature we're adding to the llm-cli-gateway.

The documentation should include:

1. An overview section explaining what prompt optimization is and why it matters for token efficiency

2. A detailed guide on how to enable the feature, including:
   - Configuration options in the MCP tool parameters
   - Examples of the optimizePrompts flag
   - Examples of the optimizeResponses flag

3. Before and after examples showing the token savings:
   - At least 3 real-world examples
   - Show the original verbose prompt
   - Show the optimized version
   - Calculate the percentage reduction

4. Best practices section with tips for writing token-efficient prompts even when auto-optimization is disabled

Please write this in Markdown format following the style of our existing documentation files like BEST_PRACTICES.md and TOKEN_OPTIMIZATION_GUIDE.md.
```

### After (OPTIMIZED - 140 tokens, 50% reduction)

```
Create docs for prompt optimization feature:

Structure:
1. Overview: what + why (token efficiency)
2. Usage:
   - Config options in MCP params
   - optimizePrompts flag examples
   - optimizeResponses flag examples
3. Examples (3x):
   - Verbose prompt
   - Optimized version
   - % reduction
4. Best practices: manual optimization tips

Format: Markdown, match style of BEST_PRACTICES.md + TOKEN_OPTIMIZATION_GUIDE.md
```

**Optimizations applied:**
- Removed "I need you to help me"
- Removed "The documentation should include"
- Removed "section explaining" → "what + why"
- Removed "detailed guide on how to"
- Numbers in compact form: "3x" vs "at least 3"
- Removed "Please write this in"
- Removed "our existing documentation files like"

---

## General Optimization Patterns

### Pattern 1: Remove Courtesies
```diff
- Please implement the following feature:
+ Implement feature:

- Could you review this code?
+ Review code:

- I would like you to help me with...
+ Help with...
```

### Pattern 2: Inline File References
```diff
- in the file src/index.ts on line 430
+ src/index.ts:430

- in the session-manager.ts file at lines 57 and 133
+ session-manager.ts:57,133
```

### Pattern 3: Arrow Notation
```diff
- Change foo to bar
+ foo → bar

- Convert the string to a number
+ string → number

- The result should be an array
+ result: array
```

### Pattern 4: Compact Types
```diff
- a string parameter
+ param:str

- an optional boolean (default false)
+ bool=false

- a required integer
+ int!

- an array of strings
+ str[]
```

### Pattern 5: Remove Context Repetition
```diff
- Fix the 3 critical bugs found in the product review:
+ Fix 3 bugs:

- the correlation ID tracking feature we implemented
+ correlation ID tracking

- the session management system
+ session management
```

### Pattern 6: Slash Notation
```diff
- Architecture and design
+ Architecture/design

- Security and reliability
+ Security/reliability

- Before and after
+ Before/after
```

### Pattern 7: Terse Task Lists
```diff
- 1. First, you should read the files
- 2. Then, make the changes
- 3. After that, run the tests
- 4. Finally, show the diff
+ Tasks: Read → change → test → diff

- Please do the following:
- - Review the code
- - Fix any bugs
- - Add tests
+ Review → fix bugs → add tests
```

---

## Optimization Checklist

Before sending prompts via MCP gateway, check:

- [ ] Removed "Please", "Could you", "I would like"?
- [ ] File references use path:line format?
- [ ] Types use compact notation (str, int, bool)?
- [ ] Used arrows (→) instead of "change to"?
- [ ] Removed implicit context repetition?
- [ ] Task lists condensed with arrows?
- [ ] Removed adjectives ("comprehensive", "detailed")?
- [ ] Used slash notation for "and" (architecture/design)?
- [ ] Questions direct, not tentative ("Check bugs?" not "Are there any bugs?")?
- [ ] Code examples minimal but clear?

---

## Validation: Token Counting

Use `cl4` tokenizer or estimate:
- Average English word ≈ 1.3 tokens
- Code tokens ≈ 1:1 ratio
- Punctuation typically 1 token each

**Target reduction:** 35-50% from verbose baseline

---

## When NOT to Optimize

**Keep verbosity when:**
- Complex requirements need disambiguation
- Critical context prevents errors
- User explicitly requests detailed explanation
- First-time instructions for unfamiliar tasks

**Always optimize when:**
- Repeating similar requests
- Standard CRUD operations
- Code reviews, bug fixes
- File operations with clear paths

---

## Auto-Optimization Feature

The llm-cli-gateway supports optional auto-optimization:

```typescript
// Enable prompt optimization
await callTool("codex_request", {
  prompt: "Your verbose prompt here...",
  optimizePrompt: true  // Auto-compress before sending
});

// Enable response optimization
await callTool("claude_request", {
  prompt: "Generate documentation...",
  optimizeResponse: true  // Auto-compress response
});
```

**How it works:**
1. Applies optimization patterns from this guide
2. Preserves code blocks and critical details
3. Reduces token count 35-50%
4. Maintains semantic equivalence

**Use auto-optimization for:**
- Repeated workflows
- Batch operations
- Cost-sensitive applications
- High-volume usage

---

## Results: Token Savings at Scale

**Per request:**
- Verbose: ~400 tokens average
- Optimized: ~220 tokens average
- **Savings: 180 tokens (45%)**

**Monthly (200 requests):**
- Verbose: 80,000 tokens
- Optimized: 44,000 tokens
- **Savings: 36,000 tokens**

**Annual:**
- **Savings: 432,000 tokens**
- **Cost savings: ~$5-15** (varies by model)
- **More importantly: Faster processing, less context pollution**

---

**Created:** 2026-01-24
**Based on:** TOKEN_OPTIMIZATION_GUIDE.md research
**Applies to:** llm-cli-gateway MCP tools
**Target:** 35-50% token reduction
