import type { KitExecutionRef } from "./personal-config-types.js";

/** Inputs that decide whether a job can own a Claude MCP request artifact. */
export interface McpArtifactAdmissionInput {
  cli: string;
  transport?: string | null;
  ownerHostname?: string | null;
  mcpArtifactPath?: string | null;
  mcpArtifactScope?: string | null;
  kitExecution?: KitExecutionRef | null;
}

function hasNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Enforce the durable ownership boundary for generated Claude MCP artifacts.
 * A Kit job and an MCP-artifact-owning Claude process job are distinct modes.
 */
export function assertMcpArtifactAdmissionInvariant(input: McpArtifactAdmissionInput): void {
  const hasArtifactPath = input.mcpArtifactPath !== null && input.mcpArtifactPath !== undefined;
  const hasArtifactScope = input.mcpArtifactScope !== null && input.mcpArtifactScope !== undefined;

  if (input.kitExecution && (hasArtifactPath || hasArtifactScope)) {
    throw new Error("Personal Agent Config Kit jobs cannot carry Claude MCP artifact provenance");
  }
  if (!hasArtifactPath && !hasArtifactScope) return;
  if (!hasNonEmptyString(input.mcpArtifactPath) || !hasNonEmptyString(input.mcpArtifactScope)) {
    throw new Error("Claude MCP artifact provenance requires non-empty path and scope");
  }
  if (input.cli !== "claude") {
    throw new Error("Claude MCP artifact provenance requires the Claude provider");
  }
  if ((input.transport ?? "process") !== "process") {
    throw new Error("Claude MCP artifact provenance requires process transport");
  }
  if (!hasNonEmptyString(input.ownerHostname)) {
    throw new Error("Claude MCP artifact provenance requires an origin hostname");
  }
}
