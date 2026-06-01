/**
 * U25 — Claude high-impact feature flags.
 *
 * Verifies that `prepareClaudeRequest` (the actual emission path, not a stub)
 * surfaces the new --agent/--agents/--fork-session/--system-prompt/
 * --append-system-prompt/--max-budget-usd/--max-turns/--effort/
 * --exclude-dynamic-system-prompt-sections flags into the argv segment, and
 * that the schema-level mutual-exclusion check between systemPrompt and
 * appendSystemPrompt fires correctly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareClaudeRequest } from "../index.js";
import {
  CLAUDE_AGENT_DEFINITION_SCHEMA,
  CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA,
  prepareClaudeHighImpactFlags,
  validateClaudeAgentsMap,
} from "../request-helpers.js";

const BASE_PARAMS = {
  prompt: "hello",
  outputFormat: "text" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};

/**
 * Pull out the args from a prepare() result, asserting it didn't bail with an
 * ExtendedToolResponse (which would surface a missing `args` key).
 */
function callPrepare(extra: Record<string, unknown>): string[] {
  const result = prepareClaudeRequest({ ...BASE_PARAMS, ...extra } as never);
  if (!("args" in result)) {
    throw new Error(
      "prepareClaudeRequest returned an ExtendedToolResponse instead of CliRequestPrep — " +
        JSON.stringify(result).slice(0, 200)
    );
  }
  return result.args;
}

describe("U25 — Claude high-impact feature flags", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Sandbox HOME so the MCP-config write side-effect lands in /tmp.
    testHome = mkdtempSync(join(tmpdir(), "u25-claude-handler-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  describe("CLAUDE_AGENT_DEFINITION_SCHEMA", () => {
    it("accepts a minimal valid agent definition", () => {
      const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse({
        description: "desc",
        prompt: "pr",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts optional tools and model", () => {
      const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse({
        description: "d",
        prompt: "p",
        tools: ["Read", "Edit"],
        model: "sonnet",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects a missing description", () => {
      const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse({ prompt: "p" });
      expect(parsed.success).toBe(false);
    });

    it("rejects a missing prompt", () => {
      const parsed = CLAUDE_AGENT_DEFINITION_SCHEMA.safeParse({ description: "d" });
      expect(parsed.success).toBe(false);
    });
  });

  describe("flag emission via prepareClaudeRequest", () => {
    it("emits --agent <name>", () => {
      const args = callPrepare({ agent: "code-reviewer" });
      const idx = args.indexOf("--agent");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("code-reviewer");
    });

    it("emits --agents <json> with the validated agent map", () => {
      const agents = { reviewer: { description: "X", prompt: "Y" } };
      const args = callPrepare({ agents });
      const idx = args.indexOf("--agents");
      expect(idx).toBeGreaterThan(-1);
      const payload = JSON.parse(args[idx + 1] as string);
      expect(payload).toEqual(agents);
    });

    it("rejects an agents map with a malformed entry via createErrorResponse", () => {
      // Missing required `description` key on the "broken" agent.
      const result = prepareClaudeRequest({
        ...BASE_PARAMS,
        agents: { broken: { prompt: "only-prompt" } },
      } as never);
      expect("args" in result).toBe(false);
      const err = result as { isError?: boolean; content: { text: string }[] };
      expect(err.isError).toBe(true);
      expect(err.content[0].text).toContain("broken");
    });

    it("emits --fork-session when forkSession=true", () => {
      const args = callPrepare({ forkSession: true });
      expect(args).toContain("--fork-session");
    });

    it("omits --fork-session when forkSession is undefined or false", () => {
      expect(callPrepare({})).not.toContain("--fork-session");
      expect(callPrepare({ forkSession: false })).not.toContain("--fork-session");
    });

    it("emits --system-prompt <value>", () => {
      const args = callPrepare({ systemPrompt: "be terse" });
      const idx = args.indexOf("--system-prompt");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("be terse");
    });

    it("emits --append-system-prompt <value>", () => {
      const args = callPrepare({ appendSystemPrompt: "also: cite sources" });
      const idx = args.indexOf("--append-system-prompt");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("also: cite sources");
    });

    it("emits --max-budget-usd <value>", () => {
      const args = callPrepare({ maxBudgetUsd: 2.5 });
      const idx = args.indexOf("--max-budget-usd");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("2.5");
    });

    it("emits --max-turns <value>", () => {
      const args = callPrepare({ maxTurns: 10 });
      const idx = args.indexOf("--max-turns");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("10");
    });

    it("emits --effort <value>", () => {
      const args = callPrepare({ effort: "high" });
      const idx = args.indexOf("--effort");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("high");
    });

    it("emits --exclude-dynamic-system-prompt-sections when set", () => {
      const args = callPrepare({ excludeDynamicSystemPromptSections: true });
      expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    });

    it("emits --verbose alongside --output-format stream-json (Claude CLI 2.x requires it with --print)", () => {
      const args = callPrepare({ outputFormat: "stream-json" });
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--include-partial-messages");
      expect(args).toContain("--verbose");
    });

    it("does NOT emit --verbose for text or json output formats", () => {
      expect(callPrepare({ outputFormat: "text" })).not.toContain("--verbose");
      expect(callPrepare({ outputFormat: "json" })).not.toContain("--verbose");
    });

    it("does NOT emit any U25 flag when no new params are supplied (backwards compat)", () => {
      const args = callPrepare({});
      const u25Flags = [
        "--agent",
        "--agents",
        "--fork-session",
        "--system-prompt",
        "--append-system-prompt",
        "--max-budget-usd",
        "--max-turns",
        "--effort",
        "--exclude-dynamic-system-prompt-sections",
      ];
      for (const flag of u25Flags) {
        expect(args).not.toContain(flag);
      }
    });
  });

  describe("CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA mutual exclusion", () => {
    it("fails when both systemPrompt and appendSystemPrompt are set", () => {
      const parsed = CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
        systemPrompt: "a",
        appendSystemPrompt: "b",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toMatch(/mutually exclusive/i);
      }
    });

    it("succeeds when only systemPrompt is set", () => {
      const parsed = CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({ systemPrompt: "a" });
      expect(parsed.success).toBe(true);
    });

    it("succeeds when only appendSystemPrompt is set", () => {
      const parsed = CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
        appendSystemPrompt: "b",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects non-positive maxBudgetUsd", () => {
      expect(CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({ maxBudgetUsd: 0 }).success).toBe(false);
      expect(CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({ maxBudgetUsd: -1 }).success).toBe(false);
    });

    it("rejects non-positive / non-integer maxTurns", () => {
      expect(CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({ maxTurns: 0 }).success).toBe(false);
      expect(CLAUDE_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({ maxTurns: 1.5 }).success).toBe(false);
    });
  });

  describe("validateClaudeAgentsMap", () => {
    it("returns the validated map on success", () => {
      const result = validateClaudeAgentsMap({
        a: { description: "d", prompt: "p" },
        b: { description: "d2", prompt: "p2", tools: ["Read"] },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.value)).toEqual(["a", "b"]);
    });

    it("reports the failing agent key on schema violation", () => {
      const result = validateClaudeAgentsMap({
        good: { description: "d", prompt: "p" },
        bad: { prompt: "p-only" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.agentKey).toBe("bad");
        expect(result.message).toContain("bad");
      }
    });
  });

  describe("prepareClaudeHighImpactFlags (pure helper)", () => {
    it("returns an empty argv segment when nothing is set", () => {
      expect(prepareClaudeHighImpactFlags({})).toEqual([]);
    });

    it("emits everything in order when every flag is set", () => {
      const args = prepareClaudeHighImpactFlags({
        agent: "rev",
        agents: { x: { description: "d", prompt: "p" } },
        forkSession: true,
        systemPrompt: "sp",
        maxBudgetUsd: 1.5,
        maxTurns: 3,
        effort: "max",
        excludeDynamicSystemPromptSections: true,
      });
      expect(args).toContain("--agent");
      expect(args).toContain("--agents");
      expect(args).toContain("--fork-session");
      expect(args).toContain("--system-prompt");
      expect(args).toContain("--max-budget-usd");
      expect(args).toContain("--max-turns");
      expect(args).toContain("--effort");
      expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    });
  });

  describe("prepareClaudeHighImpactFlags: session/settings/tools (2.x)", () => {
    it("emits --no-session-persistence only when the flag is true", () => {
      expect(prepareClaudeHighImpactFlags({ noSessionPersistence: true })).toContain(
        "--no-session-persistence"
      );
      expect(prepareClaudeHighImpactFlags({ noSessionPersistence: false })).not.toContain(
        "--no-session-persistence"
      );
      expect(prepareClaudeHighImpactFlags({})).not.toContain("--no-session-persistence");
    });

    it("emits --setting-sources <value> verbatim", () => {
      const args = prepareClaudeHighImpactFlags({ settingSources: "project,local" });
      const idx = args.indexOf("--setting-sources");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("project,local");
    });

    it("emits --settings <value> verbatim", () => {
      const args = prepareClaudeHighImpactFlags({ settings: '{"model":"x"}' });
      const idx = args.indexOf("--settings");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('{"model":"x"}');
    });

    it("emits --tools as a single variadic flag with all values", () => {
      const args = prepareClaudeHighImpactFlags({ tools: ["Read", "Edit"] });
      const idx = args.indexOf("--tools");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("Read");
      expect(args[idx + 2]).toBe("Edit");
    });

    it('emits --tools "" to disable all tools when tools=[""]', () => {
      const args = prepareClaudeHighImpactFlags({ tools: [""] });
      const idx = args.indexOf("--tools");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("");
    });

    it("emits no --tools for an empty array", () => {
      expect(prepareClaudeHighImpactFlags({ tools: [] })).not.toContain("--tools");
    });
  });
});
