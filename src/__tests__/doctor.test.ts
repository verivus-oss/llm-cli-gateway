import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGeminiConfig, createDoctorReport, type DoctorReport } from "../doctor.js";

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
    expect(report.providers.claude.cli_available).toBeDefined();
    expect(report.providers.codex).toBeDefined();
    expect(report.providers.gemini).toBeDefined();
    expect(report.providers.grok).toBeDefined();
    expect(report.providers.mistral).toBeDefined();
    expect(report.client_config.vibe_session_logging).toBeDefined();
    expect(typeof report.client_config.vibe_session_logging.session_logging_enabled).toBe(
      "boolean"
    );
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

  it("provides at least one next_action so LLM assistants never see an empty queue", () => {
    const report: DoctorReport = createDoctorReport({});
    expect(report.next_actions.length).toBeGreaterThanOrEqual(1);
    for (const action of report.next_actions) {
      expect(typeof action).toBe("string");
      expect(action.length).toBeGreaterThan(0);
    }
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
