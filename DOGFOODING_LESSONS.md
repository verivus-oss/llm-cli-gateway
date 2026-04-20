# Dogfooding Lessons Learned

## Issue #1: Wrong Permission Bypass Flag

**Discovered:** 2026-01-24 during correlation ID implementation

**Problem:** `dangerouslySkipPermissions` used `--dangerously-skip-permissions` flag, which doesn't work.

**Fix:** Changed to `--permission-mode bypassPermissions` (line 238 in src/index.ts)

**Test:**
```bash
# Doesn't work:
claude -p "create file" --dangerously-skip-permissions

# Works:
claude -p "create file" --permission-mode bypassPermissions
```

**Lesson:** Always test CLI flags directly.

---

## Issue #2: Subprocess Permissions Don't Affect Parent

**Discovered:** 2026-01-24 during correlation ID implementation attempt

**Problem:** `dangerouslySkipPermissions=true` only affects subprocess Claude, not parent executing the tool call.

**Scenario:**
1. Parent Claude (the one responding to user) needs permission to use Edit tool
2. `dangerouslySkipPermissions=true` is passed to subprocess Claude via `claude_request`
3. Subprocess gets permission bypass, but parent still asks for permission
4. Parent can't proceed without approval

**Why This Happens:**
- The tool spawns a subprocess: `executeCli("claude", args, ...)`
- The subprocess runs with `--permission-mode bypassPermissions`
- But parent Claude (handling MCP tool call) has its own permission system
- Subprocess permissions don't propagate to parent

**Architectural Issue:**
`claude_request` cannot bypass its own permissions for file modifications. Chicken-and-egg:
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
Use codex_request or gemini_request — no self-referential permission issue.

**Lesson:** Tool cannot recursively bypass its own permissions via subprocess.

---

## Issue #3: Manual Implementation Defeats Dogfooding Purpose

**Discovered:** Multiple times during session

**Problem:** When tools fail, temptation to implement manually instead of debugging.

**Why This Is Bad:**
- Prevents finding real bugs (Issues #1, #2)
- Defeats dogfooding purpose
- Doesn't improve tool for future use
- Misses UX issues

**Correct Approach:**
1. Try to use the tool
2. When it fails, DEBUG why it failed
3. Fix the underlying issue
4. Try again
5. Repeat until it works OR document the limitation

**Lesson:** Resist bypassing the tool. Bugs found are valuable.

---

## Issue #4: FullAuto Sessions Cannot Spawn MCP Sub-Sessions

**Discovered:** 2026-01-24 during performance metrics implementation

**Problem:** FullAuto LLM using MCP tools (`claude_request`, `gemini_request`) to spawn sub-sessions fails: "MCP error -32000: Connection closed".

**Scenario:**
1. User asks Claude to orchestrate Codex with instructions to use MCP tools
2. Claude calls `codex_request` with fullAuto=true and instructions to call `claude_request` and `gemini_request` for code reviews
3. Codex implements the feature successfully
4. Codex tries to call `claude_request` for review
5. **MCP connection closes** - sub-session fails

**Why This Happens:**
- MCP server lifecycle tied to fullAuto context
- Codex in fullAuto executes within subprocess
- Spawning MCP tool call from subprocess creates nested connection
- MCP server doesn't support nested/recursive connections

**Architectural Issue:**
Multi-level autonomous orchestration not supported. FullAuto LLMs cannot orchestrate via MCP.

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
- Requires human/top-level LLM to coordinate steps
- Cannot delegate orchestration to child LLMs

**Future Consideration:**
- Could be addressed with MCP session management improvements
- Requires nested/concurrent MCP connection support
- Or: design a "batch request" tool that packages multiple sub-requests

**Lesson:** MCP works for single-level (Parent→Child). Multi-level (Parent→Child→GrandChild) requires nested connection support.

---

## Summary

Dogfooding discovered:

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
- Consider batch/composite request patterns for multi-step workflows
- Explore MCP session improvements for nested connections
