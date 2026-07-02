import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProviderDefinition } from "../provider-definitions.js";
import {
  discoverProviderCapabilities,
  type DiscoveredCapabilitySet,
  type ProbeRunner,
} from "../provider-capability-discovery.js";
import { buildProviderSchema } from "../provider-schema-builder.js";
import {
  cacheKeyFields,
  capabilityCacheDir,
  computeCacheKey,
  lookupCapabilityCache,
  readCapabilityCache,
  resolveCapabilitySet,
  scrubString,
  writeCapabilityCache,
} from "../provider-capability-cache.js";

function makeRunner(config: Record<string, string>): ProbeRunner {
  return async (exe, argv) => {
    const key = `${exe} ${argv.join(" ")}`.trim();
    return { stdout: config[key] ?? "", stderr: "", code: 0 };
  };
}

const GROK_HELP = `Usage: grok [OPTIONS]

Options:
  -m, --model <MODEL>  Model ID to use

Commands:
  models  List models
  help    Print help
`;

function grokConfig(version: string): Record<string, string> {
  return {
    "grok --version": version,
    "grok --help": GROK_HELP,
    "grok agent --help": "Options:\n  -h, --help  Print help\n",
    "grok mcp --help": "Options:\n  -h, --help  Print help\n",
    "grok sessions --help": "Options:\n  -h, --help  Print help\n",
    "grok models": "grok-build-0.1\n",
    "grok agent stdio --help": JSON.stringify({
      protocolVersion: 1,
      methods: ["initialize", "session/new", "session/prompt"],
    }),
  };
}

async function discoverGrok(version: string): Promise<DiscoveredCapabilitySet> {
  return discoverProviderCapabilities(getProviderDefinition("grok"), {
    runner: makeRunner(grokConfig(version)),
    gatewayVersion: "test-gw-1.0.0",
    resolveExecutablePath: () => "/abs/bin/grok",
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "gw-capcache-"));
  process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("provider-capability-cache", () => {
  it("honors the LLM_GATEWAY_CAPABILITY_CACHE_DIR override under the state dir", () => {
    expect(capabilityCacheDir()).toBe(tmpDir);
    delete process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR;
    expect(capabilityCacheDir()).toBe(
      path.join(os.homedir(), ".llm-cli-gateway", "capability-cache")
    );
    process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR = tmpDir;
  });

  // Acceptance 2: discovered capabilities cached by all cache-key fields; the
  // lookup exposes age, source, version, and checksum.
  it("caches a set and exposes age/source/version/checksum on lookup", async () => {
    const set = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    writeCapabilityCache(set);

    const lookup = lookupCapabilityCache(set);
    expect(lookup.hit).toBe(true);
    expect(lookup.source).toBe("discovery");
    expect(lookup.version).toBe("grok 0.2.77 (44e77bec3a)");
    expect(lookup.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(lookup.ageMs).not.toBeNull();
    expect(lookup.ageMs).toBeGreaterThanOrEqual(0);
    expect(lookup.cachedAt).not.toBeNull();
  });

  it("the composite cache key changes when ANY key field changes", async () => {
    const set = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    const base = computeCacheKey(set);

    const mutations: DiscoveredCapabilitySet[] = [
      // B4: providerId is one of the 8 DAG key fields; changing it must change
      // the key (a broken impl that drops providerId from the key fails here).
      { ...set, providerId: "codex" },
      { ...set, executablePath: "/different/grok" },
      { ...set, version: "grok 0.3.0" },
      { ...set, checksums: { ...set.checksums, rootHelp: "changed" } },
      {
        ...set,
        checksums: { ...set.checksums, subcommandHelp: { "agent --help": "changed" } },
      },
      { ...set, checksums: { ...set.checksums, acpInitialize: "changed" } },
      { ...set, checksums: { ...set.checksums, modelCatalog: "changed" } },
      { ...set, gatewayVersion: "other-gw" },
    ];
    for (const mutated of mutations) {
      expect(computeCacheKey(mutated)).not.toBe(base);
    }
    // The key fields cover exactly the DAG cache_key_fields.
    const fields = cacheKeyFields(set);
    expect(Object.keys(fields).sort()).toEqual(
      [
        "acpInitializeChecksum",
        "executablePath",
        "gatewayVersion",
        "modelCatalogChecksum",
        "providerId",
        "rootHelpChecksum",
        "subcommandHelpChecksums",
        "version",
      ].sort()
    );
  });

  // Acceptance 3: changing ONLY the fake provider version invalidates the old
  // cache and rebuilds projected surfaces without source edits.
  it("changing only the version invalidates the cache and reprojects", async () => {
    const v1 = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    writeCapabilityCache(v1);
    expect(lookupCapabilityCache(v1).hit).toBe(true);

    // Same config except the version output. Nothing else in the source changed.
    const v2 = await discoverGrok("grok 0.3.0 (deadbeef)");
    const missLookup = lookupCapabilityCache(v2);
    expect(missLookup.hit).toBe(false); // automatic invalidation

    // Rebuild: resolve writes the new set; the projected schema is derived from
    // the discovered set, so it reprojects with zero source edits.
    const resolved = resolveCapabilitySet(v2);
    expect(resolved.source).toBe("discovery");
    expect(lookupCapabilityCache(v2).hit).toBe(true);
    const schema = buildProviderSchema(resolved.set);
    expect(schema.fields.some(f => f.flag === "--model")).toBe(true);
  });

  it("degrades to the last valid cached set when discovery fails but exe+version match", async () => {
    const good = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    writeCapabilityCache(good);

    // An error set (version-probe failure) that nonetheless resolves the same
    // exe path; force a matching version to model the exe+version-match branch.
    const errorSet: DiscoveredCapabilitySet = {
      ...good,
      version: good.version,
      status: "error",
      degradedReason: "version probe failed: ENOENT",
    };
    const resolved = resolveCapabilitySet(errorSet);
    expect(resolved.source).toBe("cache");
    expect(resolved.degraded).toBe(true);
    expect(resolved.set.status).toBe("ok"); // the cached (valid) set
  });

  it("falls back to a minimal surface when discovery fails and no cache matches", async () => {
    const errorSet: DiscoveredCapabilitySet = {
      ...(await discoverGrok("grok 0.2.77 (44e77bec3a)")),
      status: "error",
      degradedReason: "version probe failed: ENOENT",
      version: "",
    };
    const resolved = resolveCapabilitySet(errorSet);
    expect(resolved.source).toBe("minimal");
    expect(resolved.degraded).toBe(true);
  });

  // B1 SECURITY (generic categories, not an enumerated allowlist). Every rule
  // category is represented by a `{ label, secret }` case. Each secret is
  // smuggled through a real probe field (version / model-catalog raw / a
  // discovered-unmapped raw help excerpt) and asserted ABSENT from the raw cache
  // FILE, with [REDACTED] present.
  const SECRET_CASES: readonly { label: string; line: string; secret: string }[] = [
    // (1) known token prefixes
    {
      label: "sk-",
      line: "sk-supersecretABCDEF1234567890",
      secret: "sk-supersecretABCDEF1234567890",
    },
    {
      label: "gsk_",
      line: "gsk_GroqSecretKey1234567890abcd",
      secret: "gsk_GroqSecretKey1234567890abcd",
    },
    {
      label: "ghp_",
      line: "ghp_abcdefGHIJKL1234567890mnop",
      secret: "ghp_abcdefGHIJKL1234567890mnop",
    },
    {
      label: "github_pat_",
      line: "github_pat_11ABCDEFG0abcdefghijkl_zyxwvutsrqpONMLKJ1234567890",
      secret: "github_pat_11ABCDEFG0abcdefghijkl_zyxwvutsrqpONMLKJ1234567890",
    },
    {
      label: "ya29.",
      line: "ya29.A0ARrdaM-secretgoogletoken12345",
      secret: "A0ARrdaM-secretgoogletoken12345",
    },
    {
      label: "1//",
      line: "1//0gWXYZsecretrefreshtoken98765",
      secret: "0gWXYZsecretrefreshtoken98765",
    },
    { label: "AKIA", line: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
    { label: "ASIA", line: "ASIAY34FZKBOKMUTVV7A", secret: "ASIAY34FZKBOKMUTVV7A" },
    // (2) JSON sensitive values (matched by key substring, not enumeration)
    {
      label: "json access_token",
      line: '{"access_token": "AT-secretvalue-abc123456"}',
      secret: "AT-secretvalue-abc123456",
    },
    {
      label: "json refresh_token",
      line: '{"refresh_token": "RT-secretvalue-def654321"}',
      secret: "RT-secretvalue-def654321",
    },
    {
      label: "json id_token",
      line: '{"id_token": "IT-secretvalue-000111aaa"}',
      secret: "IT-secretvalue-000111aaa",
    },
    {
      label: "json auth_token",
      line: '{"auth_token": "AUTHsecretzzz99988"}',
      secret: "AUTHsecretzzz99988",
    },
    {
      label: "json client_secret",
      line: '{"client_secret": "CS-secretvalue-mnopqr000"}',
      secret: "CS-secretvalue-mnopqr000",
    },
    {
      label: "json api_key",
      line: '{"api_key": "AK-secretvalue-ghijkl789"}',
      secret: "AK-secretvalue-ghijkl789",
    },
    {
      label: "json secret_key",
      line: '{"secret_key": "SK-secretvalue-qqqwww11"}',
      secret: "SK-secretvalue-qqqwww11",
    },
    {
      label: "json password",
      line: '{"password": "hunter2secretpw88"}',
      secret: "hunter2secretpw88",
    },
    // (3) KV sensitive / account-identifier values
    {
      label: "kv access_key=",
      line: "access_key=AKZSECRETVALUE12345",
      secret: "AKZSECRETVALUE12345",
    },
    { label: "kv account=", line: "account=acctsecretvalue12345", secret: "acctsecretvalue12345" },
    { label: "kv account_id=", line: "account_id=1234509876", secret: "1234509876" },
    { label: "kv user_id=", line: "user_id=user-secret-99887", secret: "user-secret-99887" },
    {
      label: "kv client_id=",
      line: "client_id=client-secret-abc12345",
      secret: "client-secret-abc12345",
    },
    { label: "kv org_id=", line: "org_id=org-secret-778899aa", secret: "org-secret-778899aa" },
    // (FIX 2) camelCase / separator-agnostic KV keys must also match.
    { label: "kv userId=", line: "userId=12345678", secret: "12345678" },
    { label: "kv accountId=", line: "accountId=acctcamel987654", secret: "acctcamel987654" },
    { label: "kv clientId=", line: "clientId=client-camel-12345", secret: "client-camel-12345" },
    { label: "kv user-id= (kebab)", line: "user-id=kebabsecret12345", secret: "kebabsecret12345" },
    // (FIX 2) camelCase JSON keys must also match.
    {
      label: "json accessToken (camel)",
      line: '{"accessToken": "AT-camelsecret-123abc"}',
      secret: "AT-camelsecret-123abc",
    },
    {
      label: "json apiKey (camel)",
      line: '{"apiKey": "AK-camelsecret-456def"}',
      secret: "AK-camelsecret-456def",
    },
    // (FIX 1) whole-value redaction: a value with an in-class-excluded char
    // (colon) must be redacted ENTIRELY, leaving no tail on disk.
    {
      label: "kv value with colon tail",
      line: "password=abcd:tailSecret98765",
      secret: "abcd:tailSecret98765",
    },
    // (4) bare prefixed numeric identifier (>=6 digits)
    { label: "bare user_12345678", line: "user_12345678", secret: "user_12345678" },
    // (5) Authorization headers (Bearer AND Basic)
    {
      label: "Auth Bearer",
      line: "Authorization: Bearer BEARERsecretabc123456",
      secret: "BEARERsecretabc123456",
    },
    {
      label: "Auth Basic",
      line: "Authorization: Basic dXNlcjpwYXNzd29yZHNlY3JldA==",
      secret: "dXNlcjpwYXNzd29yZHNlY3JldA==",
    },
    // (6) email
    { label: "email", line: "contact ops@example.com now", secret: "ops@example.com" },
  ];

  it("never persists secrets to the cache file (every generic rule category)", async () => {
    // Pack every category into the model-catalog stdout, plus legit survivors.
    const modelCatalog = [
      "grok-build-0.1",
      ...SECRET_CASES.map(c => c.line),
      // Over-redaction survivors: enum text and bare numerics are not secrets.
      "--sandbox=enabled",
      "--model=grok-build",
      "max_tokens 128000",
      "budget 250000",
      "user_config",
      "org_name",
      "duration=1500ms",
      "--max-turns=250",
    ].join("\n");
    // A secret in the version string AND in a discovered-unmapped raw help
    // excerpt proves the deep walk covers those fields too.
    const secretVersion = "grok 0.2.77 token=sk-versionsecretABCDEF1234567890";
    const rootHelpWithSecret = GROK_HELP.replace(
      "  -m, --model <MODEL>  Model ID to use",
      "  -m, --model <MODEL>  Model ID to use\n  --\u{1F4A5}token=sk-inflagline1234567890  weird"
    );
    const set = await discoverProviderCapabilities(getProviderDefinition("grok"), {
      runner: makeRunner({
        ...grokConfig(secretVersion),
        "grok --help": rootHelpWithSecret,
        "grok models": modelCatalog,
      }),
      gatewayVersion: "test-gw-1.0.0",
      resolveExecutablePath: () => "/abs/bin/grok",
    });

    const entry = writeCapabilityCache(set);
    const raw = readFileSync(path.join(tmpDir, "grok.json"), "utf8");

    for (const testCase of SECRET_CASES) {
      expect(raw, `${testCase.label} must be redacted`).not.toContain(testCase.secret);
    }
    expect(raw).not.toContain("sk-versionsecretABCDEF1234567890"); // version field
    expect(raw).not.toContain("sk-inflagline1234567890"); // discovered-unmapped excerpt
    // FIX 1: whole-value redaction leaves NO tail after an in-class-excluded char.
    expect(raw).not.toContain(":tailSecret98765");
    expect(raw).not.toContain("tailSecret");
    expect(raw).toContain("[REDACTED]");

    // Over-redaction guard: legit content MUST survive on disk.
    expect(raw).toContain("--sandbox=enabled");
    expect(raw).toContain("--model=grok-build");
    expect(raw).toContain("128000");
    expect(raw).toContain("250000");
    expect(raw).toContain("user_config");
    expect(raw).toContain("org_name");
    expect(raw).toContain("duration=1500ms"); // non-sensitive key survives
    expect(raw).toContain("--max-turns=250"); // non-sensitive key survives

    // The returned + re-read entry is scrubbed too.
    expect(JSON.stringify(entry.capabilitySet)).not.toContain("sk-versionsecret");
    expect(JSON.stringify(readCapabilityCache("grok"))).not.toContain("ops@example.com");
  });

  it("scrubString: generic categories redact; keys, enum text, and numbers survive", () => {
    // (1) prefixes
    expect(scrubString("sk-abcdef12345678")).toBe("[REDACTED]");
    expect(scrubString("gsk_abcdef12345678")).toBe("[REDACTED]");
    expect(scrubString("github_pat_abcdefGHIJKL0123456789")).toBe("[REDACTED]");
    expect(scrubString("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
    // (2) JSON sensitive value by key substring (auth_token, not enumerated)
    expect(scrubString('{"auth_token": "secretvalue123"}')).toBe('{"auth_token": "[REDACTED]"}');
    // (2) JSON value containing an escaped quote must be consumed whole (no tail leak).
    expect(scrubString('{"password": "abcd\\"tailSecret98765"}')).toBe(
      '{"password": "[REDACTED]"}'
    );
    // (3) KV sensitive/account value
    expect(scrubString("access_key=SECRETVALUE12345")).toBe("access_key=[REDACTED]");
    expect(scrubString("account_id=987654321")).toBe("account_id=[REDACTED]");
    // FIX 2: camelCase + kebab keys resolve to the same sensitive class.
    expect(scrubString("userId=12345678")).toBe("userId=[REDACTED]");
    expect(scrubString("accountId=abc123456")).toBe("accountId=[REDACTED]");
    expect(scrubString("clientId=xyz789012")).toBe("clientId=[REDACTED]");
    expect(scrubString("user-id=kebab12345")).toBe("user-id=[REDACTED]");
    expect(scrubString('{"apiKey": "AK-camel-1234"}')).toBe('{"apiKey": "[REDACTED]"}');
    expect(scrubString('{"accessToken": "AT-camel-5678"}')).toBe('{"accessToken": "[REDACTED]"}');
    // FIX 1: whole-value redaction leaves no tail after an in-class-excluded char.
    expect(scrubString("password=abcd:tailSecret98765")).toBe("password=[REDACTED]");
    // (4) bare prefixed numeric id
    expect(scrubString("user_12345678")).toBe("[REDACTED]");
    // (5) Authorization (scheme + token redacted as one unit)
    expect(scrubString("Authorization: Basic dXNlcjpwdw==")).toBe("[REDACTED]");
    expect(scrubString("Authorization: Bearer abcdef123456")).toBe("[REDACTED]");
    // (6) email
    expect(scrubString("contact bob@example.org now")).toBe("contact [REDACTED] now");
    // Survivors: enum text, dictionary-word identifiers, bare numerics.
    expect(scrubString("--sandbox=enabled")).toBe("--sandbox=enabled");
    expect(scrubString("--model=grok-build")).toBe("--model=grok-build");
    expect(scrubString("user_config")).toBe("user_config");
    expect(scrubString("org_name")).toBe("org_name");
    expect(scrubString("max_tokens 128000 default")).toBe("max_tokens 128000 default");
    expect(scrubString("version 2.1.198")).toBe("version 2.1.198");
    expect(scrubString("duration=1500ms")).toBe("duration=1500ms");
    expect(scrubString("--max-turns=250")).toBe("--max-turns=250");
    expect(scrubString("plain text with no secret")).toBe("plain text with no secret");
  });

  // B2: a corrupt/truncated cache whose schemaVersion+providerId happen to match
  // must be treated as a MISS (rediscover), never a crash or an invalid entry.
  it("treats a malformed cache body as a miss (Zod validation at the read boundary)", async () => {
    const set = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    writeCapabilityCache(set);

    // Overwrite with a body that keeps the matching header but a broken
    // capabilitySet (missing required fields / wrong types).
    const corrupt = {
      schemaVersion: "provider-capability-cache.v1",
      providerId: "grok",
      cacheKey: "deadbeef",
      keyFields: {},
      capabilitySet: { providerId: "grok", version: 42 /* wrong type + missing fields */ },
      cachedAt: new Date().toISOString(),
      source: "discovery",
    };
    writeFileSync(path.join(tmpDir, "grok.json"), JSON.stringify(corrupt), "utf8");

    expect(readCapabilityCache("grok")).toBeNull();
    expect(lookupCapabilityCache(set).hit).toBe(false);

    // A totally truncated file is also a miss, not a throw.
    writeFileSync(path.join(tmpDir, "grok.json"), '{"schemaVersion":"provider-capab', "utf8");
    expect(readCapabilityCache("grok")).toBeNull();
  });

  // B2 continued: the failure policy must not resurrect an invalid cache. An
  // error discovery with no VALID matching cache falls back to minimal.
  it("does not degrade to a corrupt cache; falls back to minimal", async () => {
    const set = await discoverGrok("grok 0.2.77 (44e77bec3a)");
    writeCapabilityCache(set);
    writeFileSync(
      path.join(tmpDir, "grok.json"),
      JSON.stringify({
        schemaVersion: "provider-capability-cache.v1",
        providerId: "grok",
        cacheKey: "x",
        keyFields: { executablePath: "/abs/bin/grok", version: "grok 0.2.77 (44e77bec3a)" },
        capabilitySet: { broken: true },
        cachedAt: new Date().toISOString(),
        source: "discovery",
      }),
      "utf8"
    );
    const errorSet: DiscoveredCapabilitySet = {
      ...set,
      status: "error",
      degradedReason: "version probe failed: ENOENT",
    };
    const resolved = resolveCapabilitySet(errorSet);
    expect(resolved.source).toBe("minimal"); // corrupt cache is NOT a valid fallback
  });
});
