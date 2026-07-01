/**
 * Slice 0 — ApiProvider adapters + generic [providers.<name>] config.
 *
 * Pure unit tests (no network): adapter body/parse round-trips per kind, the
 * https-or-loopback guard, usage-missing degradation, xAI wire parity, and the
 * generic config loader (keyless-local exception, malformed-provider isolation,
 * model allowlist, enabledApiProviders key resolution).
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  OpenAiCompatibleProvider,
  AnthropicProvider,
  XaiResponsesProvider,
  createApiProvider,
  runApiRequest,
  resetApiProviderBreakers,
  DEFAULT_ANTHROPIC_VERSION,
  type ApiRequest,
} from "../api-provider.js";
import { ApiHttpError, buildEndpointUrl } from "../api-http.js";
import {
  loadProvidersConfig,
  isApiProviderEnabled,
  enabledApiProviders,
  type ApiProviderConfig,
} from "../config.js";
import { noopLogger } from "../logger.js";

const baseReq = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ],
  ...over,
});

describe("Slice 0 — ApiProvider adapters", () => {
  describe("OpenAiCompatibleProvider", () => {
    const p = new OpenAiCompatibleProvider("ollama");

    it("targets /chat/completions and builds the chat body", () => {
      expect(p.endpointUrl("https://api.example.com/v1").toString()).toBe(
        "https://api.example.com/v1/chat/completions"
      );
      const body = p.buildBody(baseReq({ maxOutputTokens: 256, temperature: 0.2, topP: 0.9 }));
      expect(body).toEqual({
        model: "test-model",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hello" },
        ],
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
      });
    });

    it("normalizes repeated base/path slashes without regex trimming", () => {
      expect(
        buildEndpointUrl("https://api.example.com/v1///", "///chat/completions").toString()
      ).toBe("https://api.example.com/v1/chat/completions");
    });

    it("parses choices + usage", () => {
      const r = p.parseResult(
        200,
        JSON.stringify({
          model: "qwen2.5",
          choices: [{ message: { content: "hi there" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        })
      );
      expect(r.text).toBe("hi there");
      expect(r.usage.inputTokens).toBe(10);
      expect(r.usage.outputTokens).toBe(4);
      expect(r.httpStatus).toBe(200);
    });

    it("degrades gracefully when usage is missing (local servers)", () => {
      const r = p.parseResult(200, JSON.stringify({ choices: [{ message: { content: "x" } }] }));
      expect(r.text).toBe("x");
      expect(r.usage.inputTokens).toBeUndefined();
      expect(r.usage.outputTokens).toBeUndefined();
    });

    it("sends a Bearer header with a key, none when keyless", () => {
      expect(p.authHeaders("sk-1")).toEqual({ authorization: "Bearer sk-1" });
      expect(p.authHeaders("")).toEqual({});
    });

    it("rejects a cleartext remote base_url but allows loopback", () => {
      expect(() => p.endpointUrl("http://api.example.com/v1")).toThrow(ApiHttpError);
      expect(p.endpointUrl("http://127.0.0.1:11434/v1").toString()).toBe(
        "http://127.0.0.1:11434/v1/chat/completions"
      );
    });
  });

  describe("AnthropicProvider", () => {
    const p = new AnthropicProvider("anthropic");

    it("splits system out of messages and requires max_tokens", () => {
      const body = p.buildBody(baseReq());
      expect(body.system).toBe("be terse");
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(body.max_tokens).toBe(4096); // default when unset
      expect(p.endpointUrl("https://api.anthropic.com").toString()).toBe(
        "https://api.anthropic.com/messages"
      );
    });

    it("parses content[].text + usage", () => {
      const r = p.parseResult(
        200,
        JSON.stringify({
          model: "claude",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
        })
      );
      expect(r.text).toBe("ab");
      expect(r.usage.inputTokens).toBe(7);
      expect(r.usage.cacheReadTokens).toBe(2);
    });

    it("sets x-api-key + anthropic-version headers", () => {
      expect(p.authHeaders("k")).toEqual({
        "x-api-key": "k",
        "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
      });
    });
  });

  describe("XaiResponsesProvider", () => {
    const p = new XaiResponsesProvider("xai");

    it("maps system->instructions, rest->input, store:true (legacy wire parity)", () => {
      const body = p.buildBody(
        baseReq({
          previousResponseId: "resp_1",
          reasoningEffort: "high",
          maxOutputTokens: 100,
          topP: 0.5,
        })
      );
      expect(body).toEqual({
        model: "test-model",
        input: [{ role: "user", content: "hello" }],
        store: true,
        instructions: "be terse",
        previous_response_id: "resp_1",
        max_output_tokens: 100,
        top_p: 0.5,
        reasoning: { effort: "high" },
      });
      expect(p.endpointUrl("https://api.x.ai/v1").toString()).toBe("https://api.x.ai/v1/responses");
    });

    it("parses output[].content[].text + responseId + cost", () => {
      const r = p.parseResult(
        200,
        JSON.stringify({
          id: "resp_2",
          model: "grok",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 5, output_tokens: 2, cost_in_nano_usd: 3_000_000_000 },
        })
      );
      expect(r.text).toBe("ok");
      expect(r.responseId).toBe("resp_2");
      expect(r.usage.costUsd).toBe(3);
    });
  });

  it("createApiProvider returns the adapter for each kind", () => {
    expect(createApiProvider("a", "openai-compatible")).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(createApiProvider("b", "anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(createApiProvider("c", "xai-responses")).toBeInstanceOf(XaiResponsesProvider);
  });
});

describe("Slice 0 — runApiRequest end-to-end over loopback", () => {
  let server: Server;
  let baseUrl: string;
  let lastBody: any;
  let lastAuth: string | undefined;
  let nextStatus = 200;
  let nextPayload = "";

  beforeEach(async () => {
    resetApiProviderBreakers();
    nextStatus = 200;
    nextPayload = JSON.stringify({
      model: "m",
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        lastAuth = req.headers.authorization as string | undefined;
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(nextStatus, { "content-type": "application/json" });
        res.end(nextPayload);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("posts the built body with auth and parses the result", async () => {
    const provider = new OpenAiCompatibleProvider("loopback");
    const result = await runApiRequest(provider, {
      baseUrl,
      apiKey: "sk-loop",
      model: "m",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(lastAuth).toBe("Bearer sk-loop");
    expect(lastBody.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(result.text).toBe("pong");
    expect(result.usage.inputTokens).toBe(1);
    expect(result.httpStatus).toBe(200);
  });

  it("surfaces a non-2xx as an ApiHttpError carrying the status", async () => {
    nextStatus = 400;
    nextPayload = JSON.stringify({ error: { message: "bad request" } });
    const provider = new OpenAiCompatibleProvider("loopback");
    // A non-transient 400 is not retried; withRetry surfaces it with the
    // original ApiHttpError as `.cause` (same shape as the legacy xai path).
    const error = await runApiRequest(provider, {
      baseUrl,
      apiKey: "sk",
      model: "m",
      messages: [{ role: "user", content: "x" }],
    }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as any).cause).toMatchObject({ name: "ApiHttpError", status: 400 });
  });
});

describe("Slice 0 — generic [providers.<name>] config", () => {
  let tempDir: string;
  let stubbed: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "providers-config-"));
    stubbed = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbed === undefined) delete process.env.LLM_GATEWAY_CONFIG;
    else process.env.LLM_GATEWAY_CONFIG = stubbed;
  });

  function pointToFile(toml: string): void {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, toml);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
  }

  it("parses multiple providers and disables only the malformed one", () => {
    pointToFile(`
[providers.ollama]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5-coder:32b"
models = ["qwen2.5-coder:32b", "llama3.3:70b"]

[providers.openai]
kind = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
default_model = "gpt-4o"

[providers.broken]
kind = "not-a-real-kind"
base_url = "https://x.example.com"
default_model = "z"
`);
    const cfg = loadProvidersConfig(noopLogger);
    expect(Object.keys(cfg.providers).sort()).toEqual(["ollama", "openai"]);
    expect(cfg.providers.ollama.kind).toBe("openai-compatible");
    expect(cfg.providers.ollama.apiKeyEnv).toBeNull();
    expect(cfg.providers.ollama.models).toEqual(["qwen2.5-coder:32b", "llama3.3:70b"]);
    expect(cfg.providers.openai.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("keeps [providers.xai] back-compat (no kind required) and mirrors it into the map", () => {
    pointToFile(`
[providers.xai]
api_key_env = "XAI_API_KEY"
base_url = "https://api.x.ai/v1"
default_model = "grok-build-0.1"
`);
    const cfg = loadProvidersConfig(noopLogger);
    expect(cfg.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.providers.xai.kind).toBe("xai-responses");
  });

  it("rejects an API provider named after a spawnable CLI (name-collision guard)", () => {
    pointToFile(`
[providers.claude]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "x"

[providers.ollama]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5"
`);
    const cfg = loadProvidersConfig(noopLogger);
    // "claude" is reserved — rejected so it can't shadow the CLI on the reviewer
    // path; the legitimate "ollama" provider still loads.
    expect(cfg.providers.claude).toBeUndefined();
    expect(cfg.providers.ollama).toBeDefined();
  });

  it("rejects a cleartext remote base_url at config load", () => {
    pointToFile(`
[providers.bad]
kind = "openai-compatible"
base_url = "http://api.remote.com/v1"
default_model = "z"
`);
    const cfg = loadProvidersConfig(noopLogger);
    expect(cfg.providers.bad).toBeUndefined();
  });

  describe("isApiProviderEnabled — keyless-local exception", () => {
    const keyless = (over: Partial<ApiProviderConfig> = {}): ApiProviderConfig => ({
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "m",
      ...over,
    });

    it("allows a keyless openai-compatible provider on loopback", () => {
      expect(isApiProviderEnabled(keyless(), {})).toBe(true);
    });

    it("disables a keyless provider on a remote base_url", () => {
      expect(isApiProviderEnabled(keyless({ baseUrl: "https://api.openai.com/v1" }), {})).toBe(
        false
      );
    });

    it("disables a keyless anthropic provider even on loopback", () => {
      expect(isApiProviderEnabled(keyless({ kind: "anthropic" }), {})).toBe(false);
    });

    it("enables a keyed provider only when the env var is non-empty", () => {
      const keyed = keyless({ apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" });
      expect(isApiProviderEnabled(keyed, { OPENAI_API_KEY: "sk-x" })).toBe(true);
      expect(isApiProviderEnabled(keyed, { OPENAI_API_KEY: "  " })).toBe(false);
      expect(isApiProviderEnabled(keyed, {})).toBe(false);
    });
  });

  it("enabledApiProviders resolves keys (empty string for keyless)", () => {
    pointToFile(`
[providers.ollama]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "m"

[providers.openai]
kind = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
default_model = "gpt-4o"
`);
    const cfg = loadProvidersConfig(noopLogger);
    const enabledWithoutKey = enabledApiProviders(cfg, {});
    expect(enabledWithoutKey.map(p => p.name)).toEqual(["ollama"]);
    expect(enabledWithoutKey[0].apiKey).toBe("");

    const enabledWithKey = enabledApiProviders(cfg, { OPENAI_API_KEY: "sk-9" });
    expect(enabledWithKey.map(p => p.name).sort()).toEqual(["ollama", "openai"]);
    expect(enabledWithKey.find(p => p.name === "openai")?.apiKey).toBe("sk-9");
  });
});
