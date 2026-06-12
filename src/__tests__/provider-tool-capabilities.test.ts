import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceProvider } from "../resources.js";
import {
  clearProviderToolCapabilitiesCache,
  getProviderToolCapabilities,
  providerCapabilityIds,
} from "../provider-tool-capabilities.js";
import { SessionManager } from "../session-manager.js";
import { PerformanceMetrics } from "../metrics.js";

describe("provider tool capabilities", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalGatewayConfig: string | undefined;
  let originalXaiKey: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "provider-tools-test-"));
    originalHome = process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME;
    originalGatewayConfig = process.env.LLM_GATEWAY_CONFIG;
    originalXaiKey = process.env.XAI_API_KEY;
    process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME = tempDir;
    delete process.env.LLM_GATEWAY_CONFIG;
    delete process.env.XAI_API_KEY;
    clearProviderToolCapabilitiesCache();
  });

  afterEach(() => {
    clearProviderToolCapabilitiesCache();
    if (originalHome === undefined) {
      delete process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME;
    } else {
      process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME = originalHome;
    }
    if (originalGatewayConfig === undefined) {
      delete process.env.LLM_GATEWAY_CONFIG;
    } else {
      process.env.LLM_GATEWAY_CONFIG = originalGatewayConfig;
    }
    if (originalXaiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = originalXaiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("surfaces Grok Imagine skill tools from the local Grok skill directory", () => {
    const skillDir = join(tempDir, ".grok", "skills", "imagine");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: imagine",
        "description: Prompting and workflow guidance for Imagine image tools",
        "---",
        "",
        "# Imagine",
        "",
        "Use `image_gen` for new images and `image_edit` for edits.",
      ].join("\n")
    );

    const capabilities = getProviderToolCapabilities("grok").grok;
    const imagine = capabilities.discoveredSkills.find(skill => skill.name === "imagine");

    expect(capabilities.schemaVersion).toBe("provider-tool-capabilities.v2");
    expect(capabilities.gatewayRequestTools).toEqual(["grok_request", "grok_request_async"]);
    expect(capabilities.controls.allowlist).toMatchObject({
      supported: true,
      requestField: "allowedTools",
      cliFlag: "--tools",
    });
    expect(imagine?.description).toBe("Prompting and workflow guidance for Imagine image tools");
    expect(imagine?.declaredTools).toEqual(["image_edit", "image_gen"]);
    expect(imagine?.path).toBeUndefined();
    expect(capabilities.discoveredProviderTools.map(tool => tool.name)).toEqual([
      "image_edit",
      "image_gen",
    ]);
  });

  it("reports v2 schema and gateway tool-control differences for each provider", () => {
    const capabilities = getProviderToolCapabilities();

    expect(Object.keys(capabilities).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "grok_api",
      "mistral",
    ]);
    for (const capability of Object.values(capabilities)) {
      expect(capability?.schemaVersion).toBe("provider-tool-capabilities.v2");
      expect(capability?.generatedAt).toBeDefined();
      expect(capability?.modelInfo).toBeDefined();
      expect(capability?.features.gatewayRequestTools.supported).toBe(true);
      expect(capability?.configSurfaces).toBeDefined();
      expect(capability?.metadata.cacheTtlMs).toBe(60_000);
    }
    expect(capabilities.claude.controls.denylist.supported).toBe(true);
    expect(capabilities.codex.controls.allowlist.supported).toBe(false);
    expect(capabilities.gemini.controls.allowlist.behavior).toContain("rejected");
    expect(capabilities.grok.controls.denylist.cliFlag).toBe("--disallowed-tools");
    expect(capabilities.mistral.controls.denylist.behavior).toContain("ignored");
    expect(capabilities.grok_api.providerKind).toBe("api");
    expect(capabilities.grok_api.gatewayRequestTools).toEqual([]);
  });

  it("covers Claude, Codex, and Gemini request-schema capabilities", () => {
    const capabilities = getProviderToolCapabilities({ refresh: true });

    expect(capabilities.claude?.gatewayRequestTools).toEqual([
      "claude_request",
      "claude_request_async",
    ]);
    expect(capabilities.claude?.controls).toMatchObject({
      tools: { supported: true, requestField: "tools" },
      strictMcpConfig: { supported: true, requestField: "strictMcpConfig" },
      agents: { supported: true, requestField: "agent/agents" },
      structuredOutput: { supported: true, requestField: "outputFormat/jsonSchema" },
      session: {
        supported: true,
        requestField:
          "continueSession/sessionId/forkSession/noSessionPersistence/settings/settingSources",
      },
      loopAndBudget: {
        supported: true,
        requestField: "maxTurns/maxBudgetUsd/effort/fallbackModel",
      },
    });
    expect(capabilities.claude?.features.toolAllowDenyControls.supported).toBe(true);
    expect(capabilities.claude?.unsupportedInputs).toContainEqual(
      expect.objectContaining({ input: "dangerouslySkipPermissions", behavior: "deprecated" })
    );

    expect(capabilities.codex?.gatewayRequestTools).toEqual([
      "codex_request",
      "codex_request_async",
      "codex_fork_session",
    ]);
    expect(capabilities.codex?.controls).toMatchObject({
      sandboxMode: { supported: true, requestField: "sandboxMode" },
      askForApproval: { supported: true, requestField: "askForApproval" },
      profileAndConfig: {
        supported: true,
        requestField: "profile/configOverrides/ignoreUserConfig/ignoreRules",
      },
      structuredOutput: { supported: true, requestField: "outputFormat/outputSchema" },
      images: { supported: true, requestField: "images" },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession/ephemeral",
      },
    });
    expect(capabilities.codex?.unsupportedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: "allowedTools", behavior: "not_supported" }),
        expect.objectContaining({ input: "disallowedTools", behavior: "not_supported" }),
        expect.objectContaining({ input: "mcpServers", behavior: "approval_tracking_only" }),
      ])
    );

    expect(capabilities.gemini?.gatewayRequestTools).toEqual([
      "gemini_request",
      "gemini_request_async",
    ]);
    expect(capabilities.gemini?.controls).toMatchObject({
      approvalMode: { supported: true, requestField: "approvalMode/yolo" },
      sandbox: { supported: true, requestField: "sandbox", cliFlag: "-s" },
      workspace: { supported: true, requestField: "includeDirs/workspace/worktree" },
      session: { supported: true, requestField: "sessionId/resumeLatest/createNewSession" },
    });
    expect(capabilities.gemini?.unsupportedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: "allowedTools", behavior: "reject" }),
        expect.objectContaining({ input: "mcpServers", behavior: "reject" }),
        expect.objectContaining({ input: "outputFormat=json/stream-json", behavior: "reject" }),
        expect.objectContaining({
          input: "policyFiles/adminPolicyFiles/skipTrust",
          behavior: "not_supported",
        }),
        expect.objectContaining({ input: "attachments", behavior: "reject" }),
      ])
    );
  });

  it("covers Grok CLI, Grok API, and Mistral request-schema capabilities", () => {
    const capabilities = getProviderToolCapabilities({ refresh: true });

    expect(capabilities.grok?.controls).toMatchObject({
      allowAliases: { supported: true, requestField: "allow/deny" },
      alwaysApprove: { supported: true, requestField: "alwaysApprove" },
      permissionAndApproval: {
        supported: true,
        requestField: "permissionMode/approvalStrategy/approvalPolicy",
      },
      agents: { supported: true, requestField: "agent/agents/bestOfN/check/todoGate/noSubagents" },
      webSearch: { supported: true, requestField: "disableWebSearch" },
      memoryAndPlan: {
        supported: true,
        requestField: "experimentalMemory/noMemory/noPlan/noAltScreen",
      },
      promptControl: {
        supported: true,
        requestField: "promptFile/promptJson/single/verbatim/systemPromptOverride/rules",
      },
      outputFormat: { supported: true, requestField: "outputFormat" },
      workspace: {
        supported: true,
        requestField: "sandbox/workingDir/workspace/worktree/nativeWorktree",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession/restoreCode/leaderSocket",
      },
      loopAndCompaction: {
        supported: true,
        requestField: "maxTurns/effort/reasoningEffort/compactionMode/compactionDetail",
      },
    });
    expect(capabilities.grok?.features).toMatchObject({
      providerNativeTools: { supported: true },
      sessionContinuity: { supported: true },
      workspaceAndWorktreeControls: { supported: true },
      toolAllowDenyControls: { supported: true },
      webSearchControl: { supported: true },
      memoryControl: { supported: true },
      promptControl: { supported: true },
      compactionControls: { supported: true },
    });
    expect(capabilities.grok?.unsupportedInputs).toContainEqual(
      expect.objectContaining({ input: "mcpServers", behavior: "approval_tracking_only" })
    );

    expect(capabilities.grok_api?.controls).toMatchObject({
      reasoningEffort: { supported: true, requestField: "reasoningEffort" },
      maxOutputTokens: { supported: true, requestField: "maxOutputTokens" },
      sampling: { supported: true, requestField: "temperature/topP" },
      timeout: { supported: true, requestField: "timeoutMs" },
      session: { supported: true, requestField: "sessionId/createNewSession" },
    });
    expect(capabilities.grok_api?.unsupportedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: "allowedTools/disallowedTools",
          behavior: "not_supported",
        }),
        expect.objectContaining({ input: "workspace/worktree", behavior: "not_supported" }),
        expect.objectContaining({ input: "localSkills", behavior: "not_supported" }),
        expect.objectContaining({
          input: "Grok Imagine image generation",
          behavior: "not_supported",
        }),
      ])
    );

    expect(capabilities.mistral?.controls).toMatchObject({
      allowlist: { supported: true, requestField: "allowedTools" },
      denylist: { supported: false, requestField: "disallowedTools" },
      permissionMode: { supported: true, requestField: "permissionMode" },
      outputFormat: { supported: true, requestField: "outputFormat" },
      trust: { supported: true, requestField: "trust" },
      costAndLoop: { supported: true, requestField: "maxTurns/maxPrice/maxTokens" },
      workspace: { supported: true, requestField: "workingDir/addDir/workspace/worktree" },
      session: { supported: true, requestField: "sessionId/resumeLatest/createNewSession" },
    });
    expect(capabilities.mistral?.features).toMatchObject({
      sessionContinuity: { supported: true },
      approvalAndSandboxControls: { supported: true },
      costAndLoopControls: { supported: true },
      workspaceAndWorktreeControls: { supported: true },
      enabledToolAllowlist: { supported: true },
      trustControl: { supported: true },
    });
    expect(capabilities.mistral?.unsupportedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: "disallowedTools", behavior: "ignored" }),
        expect.objectContaining({ input: "effort/reasoningEffort", behavior: "not_supported" }),
      ])
    );
  });

  it("reports grok_api request tool only when xAI provider is enabled", () => {
    const configPath = join(tempDir, "gateway-config.toml");
    writeFileSync(configPath, ["[providers.xai]", 'api_key_env = "XAI_API_KEY"', ""].join("\n"));
    process.env.LLM_GATEWAY_CONFIG = configPath;
    process.env.XAI_API_KEY = "test-key-value";
    clearProviderToolCapabilitiesCache();

    const capabilities = getProviderToolCapabilities({ cli: "grok_api", refresh: true });
    const serialized = JSON.stringify(capabilities);

    expect(capabilities.grok_api?.gatewayRequestTools).toEqual(["grok_api_request"]);
    expect(capabilities.grok_api?.configSurfaces).toContainEqual(
      expect.objectContaining({ name: "xai_api_key_env", present: true, entries: ["XAI_API_KEY"] })
    );
    expect(serialized).not.toContain("test-key-value");
  });

  it("honors query options for filtering, omissions, and raw path inclusion", () => {
    const skillDir = join(tempDir, ".grok", "skills", "imagine");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Imagine\n\n`image_gen`\n");

    const omitted = getProviderToolCapabilities({
      cli: "grok",
      includeSkills: false,
      includeProviderTools: false,
      includeUnsupported: false,
    });

    expect(Object.keys(omitted)).toEqual(["grok"]);
    expect(omitted.grok?.discoveredSkills).toEqual([]);
    expect(omitted.grok?.discoveredProviderTools).toEqual([]);
    expect(omitted.grok?.unsupportedInputs).toEqual([]);

    const withPaths = getProviderToolCapabilities({
      cli: "grok",
      includePaths: true,
      refresh: true,
    });
    expect(withPaths.grok?.discoveredSkills[0].path).toBe(join(skillDir, "SKILL.md"));
  });

  it("caches capability discovery and refresh bypasses stale entries", () => {
    const first = getProviderToolCapabilities({ cli: "grok" });
    expect(first.grok?.discoveredSkills).toEqual([]);

    const skillDir = join(tempDir, ".grok", "skills", "imagine");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Imagine\n\n`image_gen`\n");

    const cached = getProviderToolCapabilities({ cli: "grok" });
    expect(cached.grok?.discoveredSkills).toEqual([]);

    const refreshed = getProviderToolCapabilities({ cli: "grok", refresh: true });
    expect(refreshed.grok?.discoveredSkills.map(skill => skill.name)).toEqual(["imagine"]);
  });

  it("parses folded, literal, and nested frontmatter without over-reporting noise", () => {
    const foldedDir = join(tempDir, ".grok", "skills", "folded");
    const literalDir = join(tempDir, ".grok", "skills", "literal");
    mkdirSync(foldedDir, { recursive: true });
    mkdirSync(literalDir, { recursive: true });
    writeFileSync(
      join(foldedDir, "SKILL.md"),
      [
        "---",
        "name: folded-skill",
        "description: >-",
        "  Folded description",
        "  for image tools.",
        "---",
        "",
        "## Tools",
        "- `image_gen`",
        "- image_edit: edit an image",
        "",
        "Ignore noise like `file:line`, `name:`, `max_results`, and `session_id`.",
      ].join("\n")
    );
    writeFileSync(
      join(literalDir, "SKILL.md"),
      [
        "---",
        "name: literal-skill",
        "metadata:",
        "  short-description: |-",
        "    Literal line one",
        "    Literal line two",
        "  owner: should-not-enter-description",
        "---",
        "",
        "# Literal",
        "",
        "`reference_to_video`",
      ].join("\n")
    );

    const capabilities = getProviderToolCapabilities({ cli: "grok", refresh: true }).grok;
    const folded = capabilities?.discoveredSkills.find(skill => skill.name === "folded-skill");
    const literal = capabilities?.discoveredSkills.find(skill => skill.name === "literal-skill");
    const toolNames = capabilities?.discoveredProviderTools.map(tool => tool.name);
    const imageGen = capabilities?.discoveredProviderTools.find(tool => tool.name === "image_gen");

    expect(folded?.description).toBe("Folded description for image tools.");
    expect(literal?.description).toBe("Literal line one\nLiteral line two");
    expect(toolNames).toEqual(["image_edit", "image_gen", "reference_to_video"]);
    expect(imageGen).toMatchObject({
      confidence: "high",
      reason: "exact-tool-section",
      source: "grok",
    });
    expect(toolNames).not.toContain("max_results");
    expect(toolNames).not.toContain("session_id");
  });

  it("reports redacted config surfaces without secret-bearing values", () => {
    const codexDir = join(tempDir, ".codex");
    const vibeDir = join(tempDir, ".vibe");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(vibeDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        "[profiles.review]",
        'model = "gpt-secret-model-name"',
        "[mcp_servers.local]",
        'command = "/private/bin/server"',
        'env = { API_TOKEN = "secret-token" }',
      ].join("\n")
    );
    writeFileSync(
      join(vibeDir, "config.toml"),
      ["[session_logging]", "enabled = false", "[trusted_folders]", 'home = "/secret/path"'].join(
        "\n"
      )
    );

    const codex = getProviderToolCapabilities({ cli: "codex", refresh: true }).codex;
    const mistral = getProviderToolCapabilities({ cli: "mistral", refresh: true }).mistral;
    const serialized = JSON.stringify({ codex, mistral });

    expect(codex?.configSurfaces.find(surface => surface.name === "codex_config")).toMatchObject({
      present: true,
      path: undefined,
    });
    expect(
      codex?.configSurfaces.find(surface => surface.name === "codex_profiles")?.entries
    ).toEqual(["review"]);
    expect(
      codex?.configSurfaces.find(surface => surface.name === "codex_mcp_servers")?.entries
    ).toEqual(["local"]);
    expect(
      mistral?.configSurfaces.find(surface => surface.name === "vibe_session_logging")?.details
    ).toBe("disabled");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("/private/bin/server");
    expect(serialized).not.toContain("/secret/path");
  });

  it("exposes provider tool capability resources", async () => {
    const skillDir = join(tempDir, ".grok", "skills", "imagine");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Imagine\n\n`image_gen` and `image_edit`\n");
    const provider = new ResourceProvider(new SessionManager(), new PerformanceMetrics());

    const catalog = await provider.readResource("provider-tools://catalog");
    const grok = await provider.readResource("provider-tools://grok");

    expect(catalog?.mimeType).toBe("application/json");
    const catalogJson = JSON.parse(catalog?.text ?? "{}") as Record<
      string,
      { providerKind: string; schemaVersion: string }
    >;
    expect(catalogJson.grok.schemaVersion).toBe("provider-tool-capabilities.v2");
    expect(JSON.parse(catalog?.text ?? "{}").grok.discoveredSkills[0].name).toBe("imagine");
    expect(catalogJson.grok_api.providerKind).toBe("api");
    expect(JSON.parse(grok?.text ?? "{}").discoveredSkills[0].declaredTools).toEqual([
      "image_edit",
      "image_gen",
    ]);
    for (const providerId of providerCapabilityIds()) {
      const contents = await provider.readResource(`provider-tools://${providerId}`);
      const parsed = JSON.parse(contents?.text ?? "{}") as { schemaVersion?: string };
      expect(contents?.mimeType).toBe("application/json");
      expect(parsed.schemaVersion).toBe("provider-tool-capabilities.v2");
    }
  });
});
