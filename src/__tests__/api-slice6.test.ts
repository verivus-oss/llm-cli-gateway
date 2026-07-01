import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApiProviderStatus } from "../provider-status.js";
import { getApiProviderLoginGuidance } from "../provider-login-guidance.js";
import {
  clearProviderToolCapabilitiesCache,
  getOneProviderToolCapabilities,
  getProviderToolCapabilities,
  knownProviderCapabilityIds,
  providerCapabilityIds,
} from "../provider-tool-capabilities.js";
import { ResourceProvider } from "../resources.js";
import { SessionManager } from "../session-manager.js";
import { PerformanceMetrics } from "../metrics.js";
import { apiProviderCatalogEntry } from "../api-request.js";
import { enabledApiProviders, type ApiProviderConfig, type ProvidersConfig } from "../config.js";

// Slice 6: surface enabled [providers.<name>] (kind:"api") providers across the
// peripheral surfaces (provider-status, login-guidance, provider-tool-
// capabilities, resources). Every surface must be dormant byte-identical when
// no API providers are enabled and must never leak a resolved key.

const KEYLESS_OLLAMA: ApiProviderConfig = {
  name: "ollama",
  kind: "openai-compatible",
  apiKeyEnv: null,
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen2.5",
  models: ["qwen2.5", "llama3.3"],
};

const providersOf = (...entries: ApiProviderConfig[]): ProvidersConfig => ({
  xai: null,
  providers: Object.fromEntries(entries.map(e => [e.name, e])),
  sources: { configFile: null },
});

describe("Slice 6: provider-status getApiProviderStatus", () => {
  const KEY_ENV = "SLICE6_STATUS_KEY";
  afterEach(() => delete process.env[KEY_ENV]);

  it("reports a keyless-local provider as enabled with no key present and no key field", () => {
    const status = getApiProviderStatus(KEYLESS_OLLAMA);
    expect(status.enabled).toBe(true);
    expect(status.apiKeyPresent).toBe(false);
    expect(status.apiKeyEnv).toBeNull();
    expect(status.kind).toBe("openai-compatible");
    expect(status.defaultModel).toBe("qwen2.5");
    // No spawnable binary / version / resolved key on an API status object.
    expect(status).not.toHaveProperty("apiKey");
    expect(status).not.toHaveProperty("version");
  });

  it("reports a keyed provider as enabled only when its env var is set", () => {
    const keyed: ApiProviderConfig = {
      name: "openrouter",
      kind: "openai-compatible",
      apiKeyEnv: KEY_ENV,
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "x-ai/grok-2",
    };
    expect(getApiProviderStatus(keyed).enabled).toBe(false);
    expect(getApiProviderStatus(keyed).apiKeyPresent).toBe(false);

    process.env[KEY_ENV] = "sk-status-secret";
    const status = getApiProviderStatus(keyed);
    expect(status.enabled).toBe(true);
    expect(status.apiKeyPresent).toBe(true);
    expect(status.apiKeyEnv).toBe(KEY_ENV);
    // The status reports presence, not the value.
    expect(JSON.stringify(status)).not.toContain("sk-status-secret");
  });
});

describe("Slice 6: base_url userinfo is redacted on diagnostic surfaces", () => {
  // base_url is config-supplied and the schema permits userinfo; the status and
  // guidance projections must not echo embedded credentials.
  const withUserinfo: ApiProviderConfig = {
    name: "leakyproxy",
    kind: "openai-compatible",
    apiKeyEnv: "LEAKY_KEY",
    baseUrl: "https://leakyuser:sekretpw@proxy.example/v1",
    defaultModel: "m1",
  };

  it("getApiProviderStatus redacts userinfo from baseUrl", () => {
    const status = getApiProviderStatus(withUserinfo);
    expect(status.baseUrl).not.toContain("sekretpw");
    expect(status.baseUrl).not.toContain("leakyuser");
    expect(status.baseUrl).toContain("proxy.example");
  });

  it("getApiProviderLoginGuidance redacts userinfo from baseUrl and embedded steps", () => {
    const guidance = getApiProviderLoginGuidance(withUserinfo);
    expect(JSON.stringify(guidance)).not.toContain("sekretpw");
    expect(JSON.stringify(guidance)).not.toContain("leakyuser");
    expect(guidance.baseUrl).toContain("proxy.example");
  });
});

describe("Slice 6: provider-login-guidance getApiProviderLoginGuidance", () => {
  it("guides a keyless-local provider without asking for a key", () => {
    const guidance = getApiProviderLoginGuidance(KEYLESS_OLLAMA);
    expect(guidance.apiKeyEnv).toBeNull();
    expect(guidance.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(guidance.summary.toLowerCase()).toContain("keyless");
    expect(guidance.steps.join(" ")).toContain("http://127.0.0.1:11434/v1");
  });

  it("names the env var and base_url for a keyed provider, never a key value", () => {
    const keyed: ApiProviderConfig = {
      name: "openrouter",
      kind: "openai-compatible",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "x-ai/grok-2",
    };
    const guidance = getApiProviderLoginGuidance(keyed);
    expect(guidance.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(guidance.summary).toContain("OPENROUTER_API_KEY");
    expect(guidance.steps.some(s => s.includes("OPENROUTER_API_KEY"))).toBe(true);
    expect(guidance.steps).toContain(
      "Obtain an API key from the provider that serves https://openrouter.ai/api/v1."
    );
    expect(guidance.credentialHandling.toLowerCase()).toContain("do not paste");
  });
});

describe("Slice 6: provider-tool-capabilities api-kind metadata", () => {
  let tempDir: string;
  let originalConfig: string | undefined;
  const XAI_KEY = "SLICE6_MYXAI_KEY";

  const writeConfig = (toml: string): void => {
    const configPath = join(tempDir, "gateway-config.toml");
    writeFileSync(configPath, toml);
    process.env.LLM_GATEWAY_CONFIG = configPath;
    clearProviderToolCapabilitiesCache();
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "slice6-caps-"));
    originalConfig = process.env.LLM_GATEWAY_CONFIG;
    delete process.env.LLM_GATEWAY_CONFIG;
    delete process.env[XAI_KEY];
    clearProviderToolCapabilitiesCache();
  });

  afterEach(() => {
    clearProviderToolCapabilitiesCache();
    if (originalConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
    else process.env.LLM_GATEWAY_CONFIG = originalConfig;
    delete process.env[XAI_KEY];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is byte-identical to the static known set when no API providers are enabled", () => {
    const map = getProviderToolCapabilities();
    expect(Object.keys(map).sort()).toEqual([...knownProviderCapabilityIds()].sort());
    expect([...providerCapabilityIds()].sort()).toEqual([...knownProviderCapabilityIds()].sort());
  });

  it("does not throw and builds api-kind metadata for an enabled openai-compatible provider", () => {
    writeConfig(
      [
        "[providers.localproxy]",
        'kind = "openai-compatible"',
        'base_url = "http://127.0.0.1:11434/v1"',
        'default_model = "qwen2.5"',
        'models = ["qwen2.5", "llama3.3"]',
        "",
      ].join("\n")
    );

    const caps = getOneProviderToolCapabilities("localproxy", { refresh: true });
    expect(caps.providerKind).toBe("api");
    expect(caps.cli).toBe("localproxy");
    expect(caps.gatewayRequestTools).toEqual(["api_localproxy_request"]);
    // Supports model/sampling/reasoning-shaped controls; never CLI-only controls.
    expect(caps.controls.allowlist.supported).toBe(false);
    expect(caps.controls.denylist.supported).toBe(false);
    expect(caps.controls.mcpServers.supported).toBe(false);
    expect(caps.controls.nativeSkills.supported).toBe(false);
    expect(caps.controls.sampling.supported).toBe(true);
    expect(caps.controls.maxOutputTokens.supported).toBe(true);
    // openai-compatible does not forward reasoning.effort.
    expect(caps.controls.reasoningEffort.supported).toBe(false);
    // stateless-resend is continuity tracked.
    expect(caps.controls.session.supported).toBe(true);
    expect(caps.unsupportedInputs.map(i => i.input)).toEqual(
      expect.arrayContaining(["allowedTools/disallowedTools", "workspace/worktree"])
    );
    expect(caps.acp.status).toBe("not_applicable");
    expect(caps.modelInfo.defaultModel).toBe("qwen2.5");

    // The widened id surfaces in the dynamic set but NOT the static known set.
    expect([...providerCapabilityIds()]).toContain("localproxy");
    expect([...knownProviderCapabilityIds()]).not.toContain("localproxy");
    // The unfiltered map now includes it alongside the known providers.
    expect(getProviderToolCapabilities().localproxy?.providerKind).toBe("api");
  });

  it("uses a supplied providersConfig instead of reloading global config", () => {
    const runtimeOnly: ApiProviderConfig = {
      name: "runtimeonly",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen2.5",
    };
    const providersConfig = providersOf(runtimeOnly);

    expect([...providerCapabilityIds(providersConfig)]).toContain("runtimeonly");
    const caps = getOneProviderToolCapabilities("runtimeonly", {
      refresh: true,
      providersConfig,
    });
    expect(caps.providerKind).toBe("api");
    expect(caps.gatewayRequestTools).toEqual(["api_runtimeonly_request"]);
    expect(getProviderToolCapabilities({ providersConfig }).runtimeonly?.providerKind).toBe("api");
  });

  it("forwards reasoning.effort only for the xai-responses kind", () => {
    process.env[XAI_KEY] = "sk-xai-caps-secret";
    writeConfig(
      [
        "[providers.myxai]",
        'kind = "xai-responses"',
        `api_key_env = "${XAI_KEY}"`,
        'base_url = "https://api.x.ai/v1"',
        'default_model = "grok-4"',
        "",
      ].join("\n")
    );
    const caps = getOneProviderToolCapabilities("myxai", { refresh: true });
    expect(caps.providerKind).toBe("api");
    expect(caps.controls.reasoningEffort.supported).toBe(true);
    expect(caps.controls.session.supported).toBe(true);
    expect(caps.configSurfaces.find(s => s.name === "api_key_env")).toMatchObject({
      entries: [XAI_KEY],
      present: true,
    });
    // No resolved key value anywhere in the serialized capability record.
    expect(JSON.stringify(caps)).not.toContain("sk-xai-caps-secret");
  });

  it("still throws for a genuinely unknown / disabled provider id", () => {
    expect(() => getOneProviderToolCapabilities("not-a-real-provider", { refresh: true })).toThrow(
      /No tool-capability metadata/
    );
  });
});

describe("Slice 6: resources models:// and sessions:// for API providers", () => {
  let sessionManager: SessionManager;
  let sessionDir: string;

  const makeProvider = (providers: ProvidersConfig | null): ResourceProvider =>
    new ResourceProvider(
      sessionManager,
      new PerformanceMetrics(),
      { queryRequests: () => [] },
      null,
      providers
    );

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "slice6-sessions-"));
    sessionManager = new SessionManager(join(sessionDir, "sessions.json"));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("is byte-identical when no API providers are configured", async () => {
    const provider = makeProvider(null);
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).not.toContain("models://ollama");
    expect(uris).not.toContain("sessions://ollama");
    expect(await provider.readResource("models://ollama")).toBeNull();
    expect(await provider.readResource("sessions://ollama")).toBeNull();
  });

  it("lists and reads models://<provider> for an enabled API provider", async () => {
    const provider = makeProvider(providersOf(KEYLESS_OLLAMA));
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).toContain("models://ollama");

    const resource = await provider.readResource("models://ollama");
    expect(resource).not.toBeNull();
    const runtime = enabledApiProviders(providersOf(KEYLESS_OLLAMA))[0];
    expect(JSON.parse(resource!.text)).toEqual(apiProviderCatalogEntry(runtime));
    // CLI model resources remain intact.
    expect(await provider.readResource("models://claude")).not.toBeNull();
  });

  it("lists and reads sessions://<provider> for a continuity-tracked API provider", async () => {
    const provider = makeProvider(providersOf(KEYLESS_OLLAMA));
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).toContain("sessions://ollama");

    const session = sessionManager.createSession("ollama", "Ollama session");
    const resource = await provider.readResource("sessions://ollama");
    expect(resource).not.toBeNull();
    const parsed = JSON.parse(resource!.text) as { cli: string; sessions: Array<{ id: string }> };
    expect(parsed.cli).toBe("ollama");
    expect(parsed.sessions.map(s => s.id)).toContain(session.id);
  });

  it("keeps API providers out of the CLI-only provider-subcommands resources", async () => {
    const provider = makeProvider(providersOf(KEYLESS_OLLAMA));
    // The CLI_TYPES guard must still reject an API provider name here.
    expect(await provider.readResource("provider-subcommands://ollama/run")).toBeNull();
  });

  it("lists and reads provider-tools://<provider> from injected providers config", async () => {
    const runtimeOnly: ApiProviderConfig = {
      name: "runtimeonly",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen2.5",
    };
    const provider = makeProvider(providersOf(runtimeOnly));
    const uris = provider.listResources().map(r => r.uri);
    expect(uris).toContain("provider-tools://runtimeonly");

    const resource = await provider.readResource("provider-tools://runtimeonly");
    expect(resource).not.toBeNull();
    expect(JSON.parse(resource!.text)).toMatchObject({
      cli: "runtimeonly",
      providerKind: "api",
      gatewayRequestTools: ["api_runtimeonly_request"],
    });

    const catalog = await provider.readResource("provider-tools://catalog");
    expect(JSON.parse(catalog!.text).runtimeonly.providerKind).toBe("api");
  });
});
