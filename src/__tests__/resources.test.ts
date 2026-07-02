import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResourceProvider } from "../resources.js";
import { PerformanceMetrics } from "../metrics.js";
import { FileSessionManager, type ProviderType } from "../session-manager.js";
import { CLI_TYPES } from "../provider-types.js";
import {
  getAllProviderDefinitions,
  getProviderDefinition,
  type ProviderDefinition,
} from "../provider-definitions.js";
import {
  generateResourceDescriptors,
  parseModelsResourceUri,
  parseSessionsResourceUri,
} from "../provider-surface-generator.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { registerBaseResources, type GatewayServerRuntime } from "../index.js";

// Phase-2: model and session resources are generated from the provider
// definition registry, not hand-spelled per provider. These tests pin the
// acceptance criteria: every CLI provider (including devin and cursor) is
// listed and readable, owner-scoping is preserved, and a NEW provider
// definition flows through the generation path with no resources.ts edit.

function ctx(authPrincipal?: string): GatewayRequestContext {
  return authPrincipal
    ? { transport: "http", authScopes: [], authPrincipal }
    : { transport: "stdio", authScopes: [] };
}

describe("phase-2 generated model + session resources", () => {
  let tmp: string;
  let sessions: FileSessionManager;
  let provider: ResourceProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "phase2-res-"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    provider = new ResourceProvider(sessions, new PerformanceMetrics());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function create(cli: ProviderType, principal?: string) {
    return runWithRequestContext(ctx(principal), () => sessions.createSession(cli, "s"));
  }

  async function read(uri: string, principal?: string) {
    return runWithRequestContext(ctx(principal), () => provider.readResource(uri));
  }

  // Acceptance 1: sessions://<provider> listed for EVERY CLI provider.
  it("listResources includes sessions://<provider> for every CLI provider", () => {
    const uris = new Set(provider.listResources().map(r => r.uri));
    for (const cli of CLI_TYPES) {
      expect(uris.has(`sessions://${cli}`)).toBe(true);
    }
    // Explicitly cover the previously-absent providers.
    expect(uris.has("sessions://devin")).toBe(true);
    expect(uris.has("sessions://cursor")).toBe(true);
  });

  // Acceptance 2: models://<provider> listed for EVERY CLI provider.
  it("listResources includes models://<provider> for every CLI provider", () => {
    const uris = new Set(provider.listResources().map(r => r.uri));
    for (const cli of CLI_TYPES) {
      expect(uris.has(`models://${cli}`)).toBe(true);
    }
    expect(uris.has("models://devin")).toBe(true);
    expect(uris.has("models://cursor")).toBe(true);
  });

  // FIX 2: emoji titles are restored for every provider (sessions + models),
  // using one icon per provider, and sessions://all keeps its emoji prefix.
  it("listResources titles carry the per-provider emoji icon", () => {
    const byUri = new Map(provider.listResources().map(r => [r.uri, r]));
    for (const def of getAllProviderDefinitions()) {
      expect(byUri.get(`sessions://${def.id}`)?.title?.startsWith(`${def.icon} `)).toBe(true);
      expect(byUri.get(`models://${def.id}`)?.title?.startsWith(`${def.icon} `)).toBe(true);
    }
    // sessions://all remains emoji-prefixed for a consistent surface.
    expect(byUri.get("sessions://all")?.title).toBe("📋 All Sessions");
  });

  // Acceptance 1/2 (read side): the newly-added providers are readable.
  it("readResource serves sessions:// and models:// for devin and cursor", async () => {
    for (const cli of ["devin", "cursor"] as const) {
      const sessionsRes = await read(`sessions://${cli}`);
      expect(sessionsRes).not.toBeNull();
      expect(JSON.parse(sessionsRes!.text).cli).toBe(cli);

      const modelsRes = await read(`models://${cli}`);
      expect(modelsRes).not.toBeNull();
      expect(JSON.parse(modelsRes!.text)).toHaveProperty("description");
    }
  });

  // Acceptance 3: per-provider sessions:// stays owner-scoped.
  it("sessions://<provider> is owner-scoped (a caller sees only its own rows)", async () => {
    const alice = create("cursor", "alice");
    const bob = create("cursor", "bob");

    const aliceView = JSON.parse((await read("sessions://cursor", "alice"))!.text);
    const ids = aliceView.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(alice.id);
    expect(ids).not.toContain(bob.id);
  });

  // Acceptance 3: sessions://all stays owner-scoped for a newly-generated provider.
  it("sessions://all hides another principal's rows for a generated provider", async () => {
    const alice = create("devin", "alice");
    const bob = create("devin", "bob");

    const aliceView = JSON.parse((await read("sessions://all", "alice"))!.text);
    const ids = aliceView.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(alice.id);
    expect(ids).not.toContain(bob.id);
    // active-session pointer for bob's provider must not leak either.
    runWithRequestContext(ctx("bob"), () => sessions.setActiveSession("devin", bob.id));
    const aliceAgain = JSON.parse((await read("sessions://all", "alice"))!.text);
    expect(aliceAgain.activeSessions.devin).toBeNull();
  });

  // Acceptance 5: readResource dispatch is generic (registry-driven).
  it("parse helpers derive provider ids from the registry (generic dispatch)", () => {
    for (const cli of CLI_TYPES) {
      expect(parseSessionsResourceUri(`sessions://${cli}`)).toBe(cli);
      expect(parseModelsResourceUri(`models://${cli}`)).toBe(cli);
    }
    // Unknown / API-style names do not resolve to a CLI provider.
    expect(parseSessionsResourceUri("sessions://ollama")).toBeNull();
    expect(parseModelsResourceUri("models://ollama")).toBeNull();
    expect(parseSessionsResourceUri("sessions://all")).toBeNull();
  });

  // Acceptance 6: a fake provider definition produces models://fake and
  // sessions://fake through the generation path WITHOUT editing resources.ts.
  it("a fake provider definition flows to models:// and sessions:// via the generator", () => {
    const fake: ProviderDefinition = {
      ...(JSON.parse(JSON.stringify(getProviderDefinition("claude"))) as ProviderDefinition),
      id: "fakeprov" as never,
      displayName: "Fake Provider",
      sessionLabel: "Fake Session",
      resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    };
    const defs = [...getAllProviderDefinitions(), fake];

    const descriptor = generateResourceDescriptors(defs).find(
      d => d.provider === ("fakeprov" as never)
    );
    expect(descriptor?.modelsUri).toBe("models://fakeprov");
    expect(descriptor?.sessionsUri).toBe("sessions://fakeprov");

    // The same registry projection that resources.ts consumes resolves the URIs.
    expect(parseModelsResourceUri("models://fakeprov", defs)).toBe("fakeprov");
    expect(parseSessionsResourceUri("sessions://fakeprov", defs)).toBe("fakeprov");
  });

  // FIX 4: prove the LIVE MCP server (registerBaseResources in index.ts), not
  // just ResourceProvider.listResources, registers sessions://<id> + models://<id>
  // for every provider. The actual resources/list surface comes from these
  // registerResource calls, so devin/cursor must be registered HERE. Reverting
  // index.ts to the hand-spelled 5-provider list flips this test red.
  it("registerBaseResources registers sessions:// and models:// for devin and cursor", () => {
    const registered: { name: string; uri: string }[] = [];
    const fakeServer = {
      registerResource(name: string, uri: unknown): void {
        // Static-URI registrations pass a string; templated ones pass an object.
        if (typeof uri === "string") registered.push({ name, uri });
      },
    };
    const noopLogger = { info() {}, debug() {}, warn() {}, error() {} };
    const runtime = {
      resourceProvider: provider,
      logger: noopLogger,
      // Non-sqlite persistence keeps the validation-receipt registration (an
      // unrelated branch) out of scope for this per-provider resource test.
      persistence: { backend: "none" },
    } as unknown as GatewayServerRuntime;

    registerBaseResources(fakeServer as never, runtime);

    const uris = new Set(registered.map(r => r.uri));
    for (const cli of CLI_TYPES) {
      expect(uris.has(`sessions://${cli}`)).toBe(true);
      expect(uris.has(`models://${cli}`)).toBe(true);
    }
    // The previously-absent providers must now be registered at the server layer.
    expect(uris.has("sessions://devin")).toBe(true);
    expect(uris.has("sessions://cursor")).toBe(true);
    expect(uris.has("models://devin")).toBe(true);
    expect(uris.has("models://cursor")).toBe(true);
    // Registration names are derived from the provider id (not hand-spelled).
    expect(registered.find(r => r.uri === "sessions://devin")?.name).toBe("devin-sessions");
    expect(registered.find(r => r.uri === "models://cursor")?.name).toBe("cursor-models");
  });

  // A definition that opts OUT of a resource must not be listed or resolved.
  it("a definition with exposesSessionsResource=false is neither listed nor parsed", () => {
    const optOut: ProviderDefinition = {
      ...(JSON.parse(JSON.stringify(getProviderDefinition("claude"))) as ProviderDefinition),
      id: "noresource" as never,
      resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: false },
    };
    const defs = [...getAllProviderDefinitions(), optOut];
    expect(parseSessionsResourceUri("sessions://noresource", defs)).toBeNull();
    expect(parseModelsResourceUri("models://noresource", defs)).toBe("noresource");
    expect(
      generateResourceDescriptors(defs)
        .filter(d => d.exposesSessionsResource)
        .map(d => d.provider)
    ).not.toContain("noresource");
  });
});
