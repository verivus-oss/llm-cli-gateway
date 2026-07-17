import { describe, expect, it } from "vitest";
import { assertMcpArtifactAdmissionInvariant } from "../mcp-artifact-admission.js";
import type { KitExecutionRef } from "../personal-config-types.js";

const kitExecution: KitExecutionRef = {
  version: 1,
  releaseId: "admission-release",
  configStamp: "admission-stamp",
  scopeRoot: "/workspace/admission",
  scopeHead: "admission-head",
  contextIdentity: "admission-context",
};

const validClaudeArtifact = {
  cli: "claude",
  transport: "process",
  ownerHostname: "origin-host",
  mcpArtifactPath: "/tmp/request/config.json",
  mcpArtifactScope: "artifact-scope",
};

describe("MCP artifact admission invariant", () => {
  it("accepts a complete non-Kit Claude process provenance record", () => {
    expect(() => assertMcpArtifactAdmissionInvariant(validClaudeArtifact)).not.toThrow();
  });

  it.each([
    ["Kit execution", { ...validClaudeArtifact, kitExecution }],
    ["path without scope", { ...validClaudeArtifact, mcpArtifactScope: null }],
    ["scope without path", { ...validClaudeArtifact, mcpArtifactPath: null }],
    ["blank path", { ...validClaudeArtifact, mcpArtifactPath: "  " }],
    ["blank scope", { ...validClaudeArtifact, mcpArtifactScope: "  " }],
    ["non-Claude provider", { ...validClaudeArtifact, cli: "codex" }],
    ["HTTP transport", { ...validClaudeArtifact, transport: "http" }],
    ["blank owner hostname", { ...validClaudeArtifact, ownerHostname: " " }],
  ])("rejects %s", (_name, input) => {
    expect(() => assertMcpArtifactAdmissionInvariant(input)).toThrow();
  });

  it("allows Kit execution when no MCP artifact provenance is supplied", () => {
    expect(() =>
      assertMcpArtifactAdmissionInvariant({ cli: "claude", kitExecution })
    ).not.toThrow();
  });
});
