import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRemoteHttpOAuthReadiness,
  checkGeminiConfig,
  checkVibeSessionLogging,
  createDoctorReport,
  type DoctorReport,
  type RemoteHttpOAuthReadinessInput,
} from "../doctor.js";
import type { ApiProviderConfig, ProvidersConfig } from "../config.js";
import type { AuthConfig, RemoteOAuthConfig } from "../auth.js";
import type { EndpointExposureReport } from "../endpoint-exposure.js";
import type { RemoteSafeWorkspaceSummary } from "../workspace-registry.js";
import { CLI_TYPES } from "../provider-types.js";
import { knownProviderCapabilityIds } from "../provider-tool-capabilities.js";

// Layer 6 / U20: doctor JSON schema shape + secret redaction coverage.
//
// We don't pull in Ajv as a dependency for one test; instead we walk the
// schema's `required`/`enum`/`type` constraints (which is what the install-plan
// step depends on) directly against the report shape produced by
// createDoctorReport.

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "..", "setup", "status.schema.json");
type JsonSchemaNode = Record<string, unknown>;
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaNode;

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function expectTypeMatches(value: unknown, schemaType: unknown, pathLabel: string): void {
  if (Array.isArray(schemaType)) {
    expect(schemaType, `${pathLabel} schema-type list`).toContain(jsType(value));
    return;
  }
  if (schemaType === "number") {
    expect(["number", "integer"], `${pathLabel} number/integer`).toContain(jsType(value));
    return;
  }
  expect(jsType(value), `${pathLabel} type`).toBe(schemaType);
}

function validateAgainstSchema(node: unknown, schemaNode: JsonSchemaNode, pathLabel: string): void {
  if (schemaNode.const !== undefined) {
    expect(node, `${pathLabel} const`).toBe(schemaNode.const);
  }
  if (schemaNode.enum !== undefined) {
    expect(schemaNode.enum as unknown[], `${pathLabel} enum`).toContain(node);
  }
  if (schemaNode.type !== undefined) {
    expectTypeMatches(node, schemaNode.type, pathLabel);
  }
  if (
    schemaNode.type === "object" ||
    (Array.isArray(schemaNode.type) && schemaNode.type.includes("object"))
  ) {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      const required = (schemaNode.required as string[] | undefined) ?? [];
      for (const key of required) {
        expect(
          Object.prototype.hasOwnProperty.call(node, key),
          `${pathLabel}.${key} required`
        ).toBe(true);
      }
      const properties =
        (schemaNode.properties as Record<string, JsonSchemaNode> | undefined) ?? {};
      for (const [key, childSchema] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          validateAgainstSchema(
            (node as Record<string, unknown>)[key],
            childSchema,
            `${pathLabel}.${key}`
          );
        }
      }
      if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (properties[key]) continue;
          validateAgainstSchema(
            value,
            schemaNode.additionalProperties as JsonSchemaNode,
            `${pathLabel}.${key}`
          );
        }
      } else if (schemaNode.additionalProperties === false) {
        for (const key of Object.keys(node as Record<string, unknown>)) {
          expect(
            properties[key],
            `${pathLabel}.${key} not in additionalProperties=false`
          ).toBeTruthy();
        }
      }
    }
  }
  if (schemaNode.type === "array" && Array.isArray(node)) {
    const itemSchema = schemaNode.items as JsonSchemaNode | undefined;
    if (itemSchema) {
      node.forEach((item, index) =>
        validateAgainstSchema(item, itemSchema, `${pathLabel}[${index}]`)
      );
    }
  }
}

const ORIGINAL_ENV = { ...process.env };

function clearGatewayEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LLM_GATEWAY_") || key === "MCP_TRANSPORT") {
      delete process.env[key];
    }
  }
}

describe("Layer 6 doctor report (U20)", () => {
  beforeEach(() => {
    clearGatewayEnv();
  });

  afterEach(() => {
    clearGatewayEnv();
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("produces a report that satisfies setup/status.schema.json shape", () => {
    const report = createDoctorReport({});
    validateAgainstSchema(report, schema, "doctor");

    expect(report.schema_version).toBe("1.0");
    expect(report.gateway.name).toBe("llm-cli-gateway");
    expect(report.transport.default).toBe("stdio");
    expect(report.endpoint_exposure.mode).toBe("local_only");
    for (const provider of CLI_TYPES) {
      expect(report.providers[provider]).toBeDefined();
      expect(report.providers[provider].cli_available).toBeDefined();
    }
    expect(report.provider_capabilities.schema_version).toBe("provider-tool-capabilities.v2");
    expect(report.provider_capabilities.providers.grok_api.provider_kind).toBe("api");
    expect(report.client_config.vibe_session_logging).toBeDefined();
    expect(typeof report.client_config.vibe_session_logging.session_logging_enabled).toBe(
      "boolean"
    );
  });

  it("includes a compact provider capability summary without raw discovery paths", () => {
    const report: DoctorReport = createDoctorReport({});

    expect(report.provider_capabilities.tool).toBe("provider_tool_capabilities");
    expect(report.provider_capabilities.resources.catalog).toBe("provider-tools://catalog");
    for (const provider of knownProviderCapabilityIds()) {
      expect(report.provider_capabilities.resources.providers[provider]).toBe(
        `provider-tools://${provider}`
      );
    }
    expect(report.provider_capabilities.providers.grok.supported_features).toEqual(
      expect.arrayContaining(["toolAllowDenyControls", "promptControl", "compactionControls"])
    );
    expect(report.provider_capabilities.providers.grok_api.gateway_request_tools).toEqual([]);
    expect(report.provider_capabilities.providers.grok_api.unsupported_inputs).toEqual(
      expect.arrayContaining(["allowedTools/disallowedTools", "workspace/worktree"])
    );
    expect(report.provider_capabilities.providers.mistral.supported_features).toEqual(
      expect.arrayContaining(["enabledToolAllowlist", "trustControl"])
    );
    expect(JSON.stringify(report.provider_capabilities)).not.toContain(`${tmpdir()}/`);
    expect(JSON.stringify(report.provider_capabilities)).not.toContain("/home/");
  });

  it("flags HTTP transport without auth token as not ok and surfaces an actionable next action", () => {
    const env = { LLM_GATEWAY_TRANSPORT: "http" } as NodeJS.ProcessEnv;
    const report = createDoctorReport(env);

    expect(report.transport.default).toBe("http");
    expect(report.transport.http.enabled).toBe(true);
    expect(report.auth.token_configured).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.next_actions).toEqual(
      expect.arrayContaining([expect.stringContaining("LLM_GATEWAY_AUTH_TOKEN")])
    );
  });

  it("redacts sensitive tokens from the diagnostic public URL", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_GATEWAY_PUBLIC_URL:
        "https://test.example.com/mcp?token=SECRET_ABC&authorization=DEF&safe=ok",
    };
    const report = createDoctorReport(env);

    expect(report.transport.http.public_url).toBeDefined();
    expect(report.transport.http.public_url).not.toContain("SECRET_ABC");
    expect(report.transport.http.public_url).not.toContain("DEF");
    expect(report.transport.http.public_url).toContain("<redacted>");
    expect(report.endpoint_exposure.public_url).not.toContain("SECRET_ABC");
    expect(report.endpoint_exposure.public_url).toContain("<redacted>");
    // Non-sensitive query keys retain their values.
    expect(report.endpoint_exposure.public_url).toContain("safe=ok");
  });

  it("redacts deprecated ChatGPT no-auth connector paths from doctor output", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_GATEWAY_PUBLIC_URL: "https://test.example.com/mcp",
      LLM_GATEWAY_NO_AUTH_PATHS: "/chatgpt/SECRET123/mcp",
    };
    const report = createDoctorReport(env);

    expect(report.transport.http.chatgpt_connector_url).toBe("<redacted>");
    expect(JSON.stringify(report)).not.toContain("SECRET123");
  });

  it("redacts credentials embedded in the URL userinfo component", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_GATEWAY_PUBLIC_URL: "https://user:hunter2@tunnel.example.com/mcp",
    };
    const report = createDoctorReport(env);
    expect(report.endpoint_exposure.public_url).not.toContain("hunter2");
    expect(report.endpoint_exposure.public_url).toContain("<redacted>");
  });

  it("marks LAN-host public URLs misclassified, not web-supported", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_GATEWAY_PUBLIC_URL: "https://10.0.0.5/mcp",
    };
    const report = createDoctorReport(env);
    expect(report.endpoint_exposure.mode).toBe("lan");
    expect(report.endpoint_exposure.web_clients_supported).toBe(false);
  });

  it("does not emit raw bearer tokens in any output field", () => {
    process.env.LLM_GATEWAY_AUTH_TOKEN = "super-secret-token-value-XYZ";
    const env = { ...process.env, LLM_GATEWAY_TRANSPORT: "http" } as NodeJS.ProcessEnv;
    const report = createDoctorReport(env);
    const flattened = JSON.stringify(report);
    expect(flattened).not.toContain("super-secret-token-value-XYZ");
    expect(report.auth.token_configured).toBe(true);
  });

  it("cache_awareness block is present and zeroed when flight recorder + config absent", () => {
    const report = createDoctorReport({ env: process.env });
    expect(report.cache_awareness).toBeDefined();
    expect(report.cache_awareness.enabled_features).toEqual([]);
    expect(report.cache_awareness.last_24h.total_requests).toBe(0);
    expect(report.cache_awareness.last_24h.hit_rate).toBe(0);
    expect(report.cache_awareness.last_24h.total_hits).toBe(0);
    expect(report.cache_awareness.last_24h.estimated_savings_usd).toBe(0);
    expect(report.cache_awareness.per_cli).toEqual({});
  });

  it("cache_awareness.enabled_features lists active flags only", () => {
    const report = createDoctorReport({
      env: process.env,
      cacheAwareness: {
        emitAnthropicCacheControl: true,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: true,
        minStableTokensForCacheControl: {
          sonnet: 1024,
          opus: 4096,
          haiku: 4096,
          default: 4096,
        },
        sources: { configFile: null },
      },
    });
    expect(report.cache_awareness.enabled_features).toEqual([
      "anthropic_cache_control",
      "ttl_warnings",
    ]);
  });

  it("cache_awareness.enabled_features stays empty (NOT omitted) when all flags off", () => {
    const report = createDoctorReport({
      env: process.env,
      cacheAwareness: {
        emitAnthropicCacheControl: false,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: false,
        minStableTokensForCacheControl: {
          sonnet: 1024,
          opus: 4096,
          haiku: 4096,
          default: 4096,
        },
        sources: { configFile: null },
      },
    });
    expect(report.cache_awareness.enabled_features).toEqual([]);
    expect(Array.isArray(report.cache_awareness.enabled_features)).toBe(true);
  });

  it("provides at least one next_action so LLM assistants never see an empty queue", () => {
    const report: DoctorReport = createDoctorReport({});
    expect(report.next_actions.length).toBeGreaterThanOrEqual(1);
    for (const action of report.next_actions) {
      expect(typeof action).toBe("string");
      expect(action.length).toBeGreaterThan(0);
    }
  });
});

describe("Mistral Vibe session logging probe", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "vibe-doctor-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("treats missing config as enabled because current Vibe defaults session logging on", () => {
    const status = checkVibeSessionLogging(home);

    expect(status.config_present).toBe(false);
    expect(status.session_logging_enabled).toBe(true);
    expect(status.note).toContain("defaults session_logging.enabled to true");
  });

  it("treats a config without session_logging override as enabled", () => {
    mkdirSync(join(home, ".vibe"), { recursive: true });
    writeFileSync(join(home, ".vibe", "config.toml"), 'active_model = "local"\n');

    const status = checkVibeSessionLogging(home);

    expect(status.config_present).toBe(true);
    expect(status.session_logging_enabled).toBe(true);
  });

  it("flags explicit session_logging.enabled=false", () => {
    mkdirSync(join(home, ".vibe"), { recursive: true });
    writeFileSync(join(home, ".vibe", "config.toml"), "[session_logging]\nenabled = false\n");

    const status = checkVibeSessionLogging(home);

    expect(status.config_present).toBe(true);
    expect(status.session_logging_enabled).toBe(false);
    expect(status.note).toContain("enabled = false");
  });
});

describe("U27 checkGeminiConfig", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "u27-doc-cwd-"));
    home = mkdtempSync(join(tmpdir(), "u27-doc-home-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("detects ./GEMINI.md in cwd", () => {
    writeFileSync(join(cwd, "GEMINI.md"), "# project");
    const status = checkGeminiConfig(cwd, home, []);
    expect(status.project_gemini_md_present).toBe(true);
    expect(status.user_gemini_md_present).toBe(false);
  });

  it("detects ~/.gemini/GEMINI.md", () => {
    writeFileSync(join(home, ".gemini", "GEMINI.md"), "# user");
    const status = checkGeminiConfig(cwd, home, []);
    expect(status.user_gemini_md_present).toBe(true);
  });

  it("parses ~/.gemini/settings.json mcpServers names", () => {
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { sqry: {}, exa: {} } })
    );
    const status = checkGeminiConfig(cwd, home, ["sqry", "exa", "ref_tools"]);
    expect(status.settings_json_present).toBe(true);
    expect(status.mcp_servers_registered.sort()).toEqual(["exa", "sqry"]);
  });

  it("reports a next_action when a whitelisted MCP server is missing from settings.json", () => {
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { sqry: {} } })
    );
    const status = checkGeminiConfig(cwd, home, ["sqry", "exa"]);
    expect(status.mcp_reconciliation.missing_from_settings).toEqual(["exa"]);
    const reconcileAction = status.next_actions.find(a => a.includes("`exa`"));
    expect(reconcileAction).toBeDefined();
    expect(reconcileAction).toContain("not registered");
  });

  it("suggests creating GEMINI.md when neither project nor user file is present", () => {
    const status = checkGeminiConfig(cwd, home, []);
    expect(status.next_actions.some(a => a.includes("GEMINI.md"))).toBe(true);
  });

  it("suggests creating settings.json when it is absent", () => {
    const status = checkGeminiConfig(cwd, home, []);
    expect(status.next_actions.some(a => a.includes("settings.json"))).toBe(true);
  });

  it("surfaces gemini_config under the report's client_config (stable key)", () => {
    const report = createDoctorReport({});
    expect(report.client_config.gemini_config).toBeDefined();
    expect(report.client_config.gemini_config.mcp_reconciliation).toBeDefined();
    expect(report.client_config.gemini_config.mcp_reconciliation.whitelisted).toEqual(
      expect.any(Array)
    );
  });
});

// Slice 6: doctor api_providers health block. Dormant byte-identical (omitted
// when no API providers are enabled); reports key presence + endpoint shape +
// login guidance, never the key value. Reachability is null unless the opt-in
// probe ran.
describe("Slice 6 — doctor api_providers block", () => {
  const ORIGINAL = { ...process.env };
  const KEY_ENV = "OPENROUTER_API_KEY_SLICE6";

  afterEach(() => {
    delete process.env[KEY_ENV];
    Object.assign(process.env, ORIGINAL);
  });

  const keyless: ApiProviderConfig = {
    name: "ollama",
    kind: "openai-compatible",
    apiKeyEnv: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5",
    models: ["qwen2.5", "llama3.3"],
  };
  const keyed: ApiProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    apiKeyEnv: KEY_ENV,
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "x-ai/grok-2",
    models: ["x-ai/grok-2"],
  };
  const providersOf = (...entries: ApiProviderConfig[]): ProvidersConfig => ({
    xai: null,
    providers: Object.fromEntries(entries.map(e => [e.name, e])),
    sources: { configFile: null },
  });

  it("omits api_providers entirely when no providersConfig is supplied (byte-identical)", () => {
    const report = createDoctorReport({});
    expect("api_providers" in report).toBe(false);
    validateAgainstSchema(report, schema, "doctor");
  });

  it("omits api_providers when a providersConfig has no enabled providers", () => {
    const report = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(),
    });
    expect("api_providers" in report).toBe(false);
    // A keyed provider whose env var is unset is disabled, so still omitted.
    const report2 = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(keyed),
    });
    expect("api_providers" in report2).toBe(false);
  });

  it("surfaces an enabled keyless-local provider with reachable=null by default", () => {
    const report = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(keyless),
    });
    validateAgainstSchema(report, schema, "doctor");
    expect(report.api_providers?.enabled_count).toBe(1);
    const entry = report.api_providers?.providers.ollama;
    expect(entry?.kind).toBe("openai-compatible");
    expect(entry?.api_key_env).toBeNull();
    expect(entry?.api_key_present).toBe(false);
    expect(entry?.reachable).toBeNull();
    expect(entry?.login_guidance.apiKeyEnv).toBeNull();
    expect(entry?.models).toEqual(["qwen2.5", "llama3.3"]);
  });

  it("reports api_key_present and never leaks the key value for a keyed provider", () => {
    process.env[KEY_ENV] = "sk-secret-slice6-doctor";
    const report = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(keyed),
    });
    validateAgainstSchema(report, schema, "doctor");
    const entry = report.api_providers?.providers.openrouter;
    expect(entry?.api_key_present).toBe(true);
    expect(entry?.api_key_env).toBe(KEY_ENV);
    expect(entry?.login_guidance.summary).toContain(KEY_ENV);
    expect(JSON.stringify(report)).not.toContain("sk-secret-slice6-doctor");
  });

  it("redacts userinfo embedded in base_url across the whole api_providers block", () => {
    process.env[KEY_ENV] = "sk-secret-slice6-doctor";
    const leaky: ApiProviderConfig = {
      name: "leaky",
      kind: "openai-compatible",
      apiKeyEnv: KEY_ENV,
      baseUrl: "https://leakyuser:sekretpw@proxy.example/v1",
      defaultModel: "m1",
    };
    const report = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(leaky),
    });
    validateAgainstSchema(report, schema, "doctor");
    const blob = JSON.stringify(report.api_providers);
    expect(blob).not.toContain("sekretpw");
    expect(blob).not.toContain("leakyuser");
    expect(report.api_providers?.providers.leaky.base_url).toContain("proxy.example");
    expect(report.api_providers?.providers.leaky.login_guidance.baseUrl).toContain("proxy.example");
  });

  it("honours precomputed reachability from the opt-in probe", () => {
    const report = createDoctorReport({
      env: process.env,
      providersConfig: providersOf(keyless),
      apiReachability: { ollama: { reachable: false, error: "ECONNREFUSED" } },
    });
    validateAgainstSchema(report, schema, "doctor");
    expect(report.api_providers?.providers.ollama.reachable).toBe(false);
    expect(report.api_providers?.providers.ollama.reachability_error).toBe("ECONNREFUSED");
  });
});

// Remote HTTP + OAuth readiness projection (this slice). The stage decision
// tree is tested against the pure builder so it is hermetic (no fs/env) and the
// first-blocking-action ordering is exercised directly.
describe("remote_http_oauth readiness projection", () => {
  const READY_PUBLIC_URL = "https://gw.example.trycloudflare.com";

  function endpoint(overrides: Partial<EndpointExposureReport> = {}): EndpointExposureReport {
    return {
      mode: "tunnel",
      local_url: "http://127.0.0.1:3333/mcp",
      public_url_configured: true,
      public_url: READY_PUBLIC_URL,
      https_required_for_web: true,
      https_configured: true,
      web_clients_supported: true,
      tunnel_provider: "gw.example.trycloudflare.com",
      reachable_from_web: "reachable",
      verification: { method: "not_checked", checked_url: null, status_code: null, error: null },
      next_actions: [],
      ...overrides,
    };
  }

  function oauthCfg(overrides: Partial<RemoteOAuthConfig> = {}): RemoteOAuthConfig {
    return {
      enabled: true,
      issuer: "auto",
      requirePkce: true,
      allowPlainPkce: false,
      registrationPolicy: "static_clients",
      allowPublicClients: false,
      tokenTtlSeconds: 3600,
      requireConsent: false,
      consentSecretHash: null,
      clients: [
        {
          clientId: "chatgpt",
          clientSecretHash: "scrypt:N=32768,r=8,p=1:c2FsdA:aGFzaA",
          allowedRedirectUris: ["https://chatgpt.com/connector/callback"],
          scopes: ["mcp"],
        },
      ],
      sharedSecret: null,
      sources: { configFile: null, envOverrides: [] },
      ...overrides,
    };
  }

  const READY_AUTH: AuthConfig = { required: true, tokenConfigured: true, source: "env" };

  const READY_WORKSPACE: RemoteSafeWorkspaceSummary = {
    ready: true,
    default: "gateway",
    aliases: ["gateway"],
    repo_count: 1,
    allowed_root_count: 0,
  };

  function readyInput(
    overrides: Partial<RemoteHttpOAuthReadinessInput> = {}
  ): RemoteHttpOAuthReadinessInput {
    return {
      oauthDiag: { status: "enabled", config: oauthCfg(), issues: [] },
      workspace: READY_WORKSPACE,
      auth: READY_AUTH,
      transport: "http",
      publicUrl: READY_PUBLIC_URL,
      endpoint: endpoint(),
      mcpPath: "/mcp",
      ...overrides,
    };
  }

  it("is not_started with no public URL, stdio transport, and no OAuth config", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: {
          status: "absent",
          config: oauthCfg({ enabled: false, clients: [] }),
          issues: [],
        },
        transport: "stdio",
        publicUrl: null,
        endpoint: endpoint({
          mode: "local_only",
          public_url_configured: false,
          public_url: null,
          https_configured: false,
          web_clients_supported: false,
          tunnel_provider: null,
          reachable_from_web: "not_checked",
        }),
      })
    );
    expect(r.stage).toBe("not_started");
    expect(r.ready).toBe(false);
    expect(r.mcp_url).toBeNull();
  });

  it("is missing_public_url when OAuth is plausible but no public URL is known", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        publicUrl: null,
        endpoint: endpoint({
          mode: "local_only",
          public_url_configured: false,
          public_url: null,
          https_configured: false,
          web_clients_supported: false,
          tunnel_provider: null,
        }),
      })
    );
    expect(r.stage).toBe("missing_public_url");
    // No base origin, so no URLs are emitted (never a partial/malformed URL).
    expect(r.mcp_url).toBeNull();
    expect(r.oauth.authorization_url).toBeNull();
  });

  it("is endpoint_unreachable when a valid public URL fails the reachability probe", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({ endpoint: endpoint({ reachable_from_web: "unreachable" }) })
    );
    expect(r.stage).toBe("endpoint_unreachable");
  });

  it("is oauth_disabled when a public endpoint exists but OAuth is disabled", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: { status: "disabled", config: oauthCfg({ enabled: false }), issues: [] },
      })
    );
    expect(r.stage).toBe("oauth_disabled");
    expect(r.auth_mode).not.toBe("oauth");
    expect(r.oauth.authorization_url).toBeNull();
  });

  it("is unsafe_oauth_config when the OAuth config is malformed", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: {
          status: "malformed",
          config: oauthCfg({ enabled: false, clients: [] }),
          issues: ["An OAuth client is missing a client_secret_hash."],
        },
      })
    );
    expect(r.stage).toBe("unsafe_oauth_config");
    expect(r.next_actions.join(" ")).toContain("client_secret_hash");
  });

  it("is unsafe_oauth_config when public clients are enabled on a public endpoint", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: {
          status: "enabled",
          config: oauthCfg({ allowPublicClients: true }),
          issues: [],
        },
      })
    );
    expect(r.stage).toBe("unsafe_oauth_config");
    expect(r.next_actions.join(" ").toLowerCase()).toContain("public");
  });

  it("is missing_oauth_client when OAuth is enabled with static clients but none configured", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: { status: "enabled", config: oauthCfg({ clients: [] }), issues: [] },
      })
    );
    expect(r.stage).toBe("missing_oauth_client");
    // URLs still resolve (the endpoint + OAuth are up); only a client is missing.
    expect(r.oauth.authorization_url).toBe(`${READY_PUBLIC_URL}/oauth/authorize`);
  });

  it("is missing_workspace when OAuth is ready but no workspace is available", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        workspace: {
          ready: false,
          default: null,
          aliases: [],
          repo_count: 0,
          allowed_root_count: 0,
        },
      })
    );
    expect(r.stage).toBe("missing_workspace");
    expect(r.next_actions.join(" ")).toContain("workspace add");
  });

  it("is ready only when endpoint, OAuth, client, and workspace all pass", () => {
    const r = buildRemoteHttpOAuthReadiness(readyInput());
    expect(r.stage).toBe("ready");
    expect(r.ready).toBe(true);
    expect(r.auth_mode).toBe("oauth");
    expect(r.mcp_url).toBe(`${READY_PUBLIC_URL}/mcp`);
    expect(r.oauth.issuer).toBe(READY_PUBLIC_URL);
    expect(r.oauth.authorization_url).toBe(`${READY_PUBLIC_URL}/oauth/authorize`);
    expect(r.oauth.token_url).toBe(`${READY_PUBLIC_URL}/oauth/token`);
    expect(r.oauth.consent_required).toBe(false);
    expect(r.workspace.default).toBe("gateway");
    expect(r.workspace.aliases).toEqual(["gateway"]);
  });

  it("reports consent_required from runtime OAuth config", () => {
    const r = buildRemoteHttpOAuthReadiness(
      readyInput({
        oauthDiag: {
          status: "enabled",
          config: oauthCfg({
            requireConsent: true,
            consentSecretHash: "scrypt:N=32768,r=8,p=1:c2FsdA:aGFzaA",
          }),
          issues: [],
        },
      })
    );
    expect(r.oauth.consent_required).toBe(true);
  });

  it("produces deterministic, secret-free next_actions for every stage", () => {
    const scenarios: RemoteHttpOAuthReadinessInput[] = [
      readyInput({
        oauthDiag: {
          status: "absent",
          config: oauthCfg({ enabled: false, clients: [] }),
          issues: [],
        },
        transport: "stdio",
        publicUrl: null,
        endpoint: endpoint({
          mode: "local_only",
          public_url_configured: false,
          public_url: null,
          https_configured: false,
        }),
      }),
      readyInput({
        publicUrl: null,
        endpoint: endpoint({
          mode: "local_only",
          public_url_configured: false,
          public_url: null,
          https_configured: false,
        }),
      }),
      readyInput({ endpoint: endpoint({ reachable_from_web: "unreachable" }) }),
      readyInput({
        oauthDiag: { status: "disabled", config: oauthCfg({ enabled: false }), issues: [] },
      }),
      readyInput({
        oauthDiag: {
          status: "enabled",
          config: oauthCfg({ allowPublicClients: true }),
          issues: [],
        },
      }),
      readyInput({
        oauthDiag: { status: "enabled", config: oauthCfg({ clients: [] }), issues: [] },
      }),
      readyInput({
        workspace: {
          ready: false,
          default: null,
          aliases: [],
          repo_count: 0,
          allowed_root_count: 0,
        },
      }),
      readyInput(),
    ];
    // OAuth access tokens are `oauth_` + 43-char base64url; require a long token
    // body so the readiness stage names (oauth_disabled, unsafe_oauth_config) do
    // not falsely trip the secret detector.
    const secretPattern =
      /scrypt:|Bearer\s|oauth_[A-Za-z0-9_-]{20,}|client_secret=|consent_secret=/;
    for (const input of scenarios) {
      const r = buildRemoteHttpOAuthReadiness(input);
      // Determinism: identical inputs yield identical output.
      expect(buildRemoteHttpOAuthReadiness(input)).toEqual(r);
      expect(r.next_actions.length).toBeGreaterThan(0);
      for (const action of r.next_actions) {
        expect(typeof action).toBe("string");
        expect(action).not.toMatch(secretPattern);
      }
      // The whole projection never carries secret material.
      expect(JSON.stringify(r)).not.toMatch(secretPattern);
    }
  });

  it("schema rejects an unknown readiness stage value", () => {
    const stageSchema = (
      (schema.properties as Record<string, JsonSchemaNode>).remote_http_oauth.properties as Record<
        string,
        JsonSchemaNode
      >
    ).stage;
    expect(() => validateAgainstSchema("bogus_stage", stageSchema, "stage")).toThrow();
    // And accepts every declared stage.
    for (const stage of stageSchema.enum as string[]) {
      expect(() => validateAgainstSchema(stage, stageSchema, "stage")).not.toThrow();
    }
  });
});
