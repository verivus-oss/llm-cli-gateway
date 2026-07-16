import { hostname as localHostname } from "os";
import { proveClaudeMcpArtifactAbsent, removeClaudeMcpArtifact } from "./claude-mcp-config.js";
import type { JobRecord, JobStore } from "./job-store.js";

/**
 * Required literal for the local CLI recovery command. It makes an absent-file
 * acknowledgement an intentional operator action instead of a retry side
 * effect, because automatic reconciliation deliberately remains fail-closed.
 */
export const MCP_ARTIFACT_RECOVERY_ACKNOWLEDGEMENT = "acknowledge-local-mcp-artifact-proof";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RecoveryRefusalReason =
  | "invalid_job_id"
  | "acknowledgement_required"
  | "not_found"
  | "store_does_not_support_exact_acknowledgement"
  | "not_terminal_claude_process_job"
  | "foreign_or_unknown_host"
  | "missing_captured_artifact_provenance"
  | "artifact_not_safely_recoverable"
  | "acknowledgement_compare_and_set_missed";

export interface McpArtifactRecoveryResult {
  ok: boolean;
  jobId: string;
  outcome: "removed_and_acknowledged" | "verified_absent_and_acknowledged" | "refused";
  reason?: RecoveryRefusalReason;
}

export interface RecoverMcpArtifactCleanupPinOptions {
  store: JobStore;
  jobId: string;
  acknowledgement: string;
}

function isTerminalClaudeProcessArtifactPin(row: JobRecord): boolean {
  return (
    row.cli === "claude" &&
    row.transport === "process" &&
    row.kitExecution === null &&
    row.mcpArtifactCleanupPending &&
    (row.status === "completed" ||
      row.status === "failed" ||
      row.status === "canceled" ||
      row.status === "orphaned")
  );
}

function refused(jobId: string, reason: RecoveryRefusalReason): McpArtifactRecoveryResult {
  return { ok: false, jobId, outcome: "refused", reason };
}

/**
 * Recover one retention-pinned Claude MCP request artifact from a local shell.
 *
 * The caller cannot choose a filesystem path, host, or scope. All three are
 * read from a single durable job row, then the remover/proof routine applies
 * the same generated-path and descriptor-pinned scope checks used by normal
 * lifecycle cleanup. The final acknowledgement is the JobStore's exact
 * compare-and-set over id, host, scope, path, terminal state, and pending bit.
 */
export function recoverMcpArtifactCleanupPin(
  options: RecoverMcpArtifactCleanupPinOptions
): McpArtifactRecoveryResult {
  const { store, jobId, acknowledgement } = options;
  const hostname = localHostname();
  if (!JOB_ID.test(jobId)) return refused(jobId, "invalid_job_id");
  if (acknowledgement !== MCP_ARTIFACT_RECOVERY_ACKNOWLEDGEMENT) {
    return refused(jobId, "acknowledgement_required");
  }

  const acknowledge = store.acknowledgeMcpArtifactCleanup;
  if (typeof acknowledge !== "function") {
    return refused(jobId, "store_does_not_support_exact_acknowledgement");
  }

  const row = store.getById(jobId);
  if (!row) return refused(jobId, "not_found");
  if (!isTerminalClaudeProcessArtifactPin(row)) {
    return refused(jobId, "not_terminal_claude_process_job");
  }
  if (!row.ownerHostname || row.ownerHostname !== hostname) {
    return refused(jobId, "foreign_or_unknown_host");
  }
  if (!row.mcpArtifactPath || !row.mcpArtifactScope) {
    return refused(jobId, "missing_captured_artifact_provenance");
  }

  const removed = removeClaudeMcpArtifact(row.mcpArtifactPath, row.mcpArtifactScope);
  let outcome: McpArtifactRecoveryResult["outcome"];
  if (removed === "removed") {
    outcome = "removed_and_acknowledged";
  } else if (removed === "absent") {
    // `removeClaudeMcpArtifact` intentionally treats a generic ENOENT as
    // non-acknowledgement-worthy. Re-prove the exact scoped namespace before
    // this explicit operator path may clear the pin.
    if (
      proveClaudeMcpArtifactAbsent(row.mcpArtifactPath, row.mcpArtifactScope) !== "verified_absent"
    ) {
      return refused(jobId, "artifact_not_safely_recoverable");
    }
    outcome = "verified_absent_and_acknowledged";
  } else {
    return refused(jobId, "artifact_not_safely_recoverable");
  }

  const acknowledged = acknowledge.call(
    store,
    row.id,
    hostname,
    row.mcpArtifactScope,
    row.mcpArtifactPath
  );
  if (!acknowledged) {
    return refused(jobId, "acknowledgement_compare_and_set_missed");
  }
  return { ok: true, jobId, outcome };
}
