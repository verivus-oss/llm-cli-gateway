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

## Summary

Through attempting to use `claude_request` to implement correlation ID tracking, we discovered:

1. ✅ **Fixed**: Wrong CLI flag for permission bypass
2. ⚠️ **Limitation**: Tool can't bypass its own permissions (architectural)
3. 📚 **Process**: Importance of debugging tool failures instead of manual workarounds

**Next Steps:**
- Consider adding a note in tool documentation about the permission limitation
- Implement correlation ID manually (since dogfooding revealed this isn't possible via self-referential tool use)
- OR use codex/gemini to implement it (proving cross-tool usage works)
