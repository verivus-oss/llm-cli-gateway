# Dogfooding Lessons Learned

## Issue #1: Wrong Permission Bypass Flag

**Discovered:** 2026-01-24 during correlation ID implementation

**Problem:** The `dangerouslySkipPermissions` parameter was using `--dangerously-skip-permissions` flag, which doesn't actually work.

**Fix:** Changed to `--permission-mode bypassPermissions` (line 238 in src/index.ts)

**Test:**
```bash
# Doesn't work:
claude -p "create file" --dangerously-skip-permissions

# Works:
claude -p "create file" --permission-mode bypassPermissions
```

**Lesson:** Always test CLI flags directly before assuming they work.

---

## Issue #2: Subprocess Permissions Don't Affect Parent

**Discovered:** 2026-01-24 during correlation ID implementation attempt

**Problem:** When using `claude_request` tool with `dangerouslySkipPermissions=true`, the permission bypass only affects the **subprocess** Claude instance, not the **parent** Claude instance that's executing the tool call.

**Scenario:**
1. Parent Claude (the one responding to user) needs permission to use Edit tool
2. `dangerouslySkipPermissions=true` is passed to subprocess Claude via `claude_request`
3. Subprocess gets permission bypass, but parent still asks for permission
4. Parent can't proceed without approval

**Why This Happens:**
- The tool spawns a subprocess: `executeCli("claude", args, ...)`
- The subprocess runs with `--permission-mode bypassPermissions`
- But the **parent** Claude process (handling the MCP tool call) has its own permission system
- Subprocess permissions don't propagate to parent

**Architectural Issue:**
The `claude_request` tool cannot use itself to bypass permissions for file modifications. This creates a chicken-and-egg problem:
- To modify code via the tool, we need permission bypass
- But the bypass only affects the subprocess, not the parent
- The parent still requires manual approval

**Workaround:**
The parent Claude must be started with permission bypass:
```bash
# When running the MCP server, start Claude with:
claude --permission-mode bypassPermissions
```

**Alternative:**
Use a different LLM (codex_request or gemini_request) to modify the code, as they don't have this self-referential permission issue.

**Lesson:** Dogfooding reveals architectural limitations. A tool cannot recursively bypass its own permission system through subprocess spawning.

---

## Issue #3: Manual Implementation Defeats Dogfooding Purpose

**Discovered:** Multiple times during session

**Problem:** When the tool doesn't work as expected, there's a strong temptation to "just implement it manually" instead of debugging why the tool failed.

**Why This Is Bad:**
- Prevents discovery of real bugs (like Issue #1 and #2)
- Defeats the purpose of dogfooding
- Doesn't improve the tool for future use
- Misses UX issues

**Correct Approach:**
1. Try to use the tool
2. When it fails, DEBUG why it failed
3. Fix the underlying issue
4. Try again
5. Repeat until it works OR document the limitation

**Lesson:** Resist the urge to bypass the tool. The bugs you find are valuable!

---

## Issue #4: FullAuto Sessions Cannot Spawn MCP Sub-Sessions

**Discovered:** 2026-01-24 during performance metrics implementation

**Problem:** When an LLM runs in fullAuto mode and tries to use MCP tools (like `claude_request` or `gemini_request`) to spawn sub-sessions, the connection fails with "MCP error -32000: Connection closed".

**Scenario:**
1. User asks Claude to orchestrate Codex with instructions to use MCP tools
2. Claude calls `codex_request` with fullAuto=true and instructions to call `claude_request` and `gemini_request` for code reviews
3. Codex implements the feature successfully
4. Codex tries to call `claude_request` for review
5. **MCP connection closes** - sub-session fails

**Why This Happens:**
- The MCP server lifecycle is tied to the fullAuto execution context
- When Codex runs in fullAuto mode, it's executing within a subprocess
- Attempting to spawn another MCP tool call from within that subprocess tries to create a nested connection
- The MCP server isn't designed for nested/recursive connections from the same execution context

**Architectural Issue:**
True multi-level autonomous orchestration is not currently possible. An LLM in fullAuto mode cannot orchestrate other LLMs via MCP tools.

**Workaround:**
Manual orchestration at each level:
1. Parent LLM (Claude) orchestrates child LLM (Codex) for implementation
2. Parent LLM manually orchestrates additional children (Claude + Gemini) for reviews
3. Parent LLM orchestrates child LLM (Codex) again for fixes

**Example that DOESN'T work:**
```
codex_request with instructions:
  "Implement feature X, then use claude_request to get a review, then fix any issues found"
  ❌ The claude_request call will fail with connection closed
```

**Example that DOES work:**
```
1. codex_request: "Implement feature X"
2. claude_request: "Review the implementation of feature X"
3. codex_request: "Fix these issues: [paste review feedback]"
✅ Each is a separate top-level call from the orchestrator
```

**Impact:**
- Limits autonomous multi-level orchestration
- Requires human or top-level LLM to coordinate each step
- Cannot delegate orchestration responsibilities to child LLMs

**Future Consideration:**
- Could be addressed with MCP server session management improvements
- Would require supporting nested/concurrent MCP connections
- Or: design a "batch request" tool that packages multiple sub-requests

**Lesson:** MCP tool calls work great for single-level orchestration (Parent → Child), but multi-level autonomous orchestration (Parent → Child → GrandChild) requires architectural changes to support nested MCP connections.

---

## Summary

Through dogfooding the llm-cli-gateway, we discovered:

1. ✅ **Fixed**: Wrong CLI flag for permission bypass
2. ⚠️ **Limitation**: Tool can't bypass its own permissions (architectural)
3. 📚 **Process**: Importance of debugging tool failures instead of manual workarounds
4. ⚠️ **Limitation**: FullAuto sessions can't spawn MCP sub-sessions (architectural)

**Proven Capabilities:**
- ✅ Single-level orchestration: Claude → Codex ✓
- ✅ Cross-tool collaboration: Codex + Claude + Gemini ✓
- ✅ Manual multi-level orchestration ✓
- ❌ Autonomous multi-level orchestration ✗

**Next Steps:**
- Document MCP connection architecture in BEST_PRACTICES.md
- Consider implementing batch/composite request patterns for multi-step workflows
- Explore MCP session management improvements for nested connections
