import { createHash, randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { INTERNAL_MCP_REGISTRY } from "./mcp-registry.js";
import type { ReviewIntegrityResult } from "./review-integrity.js";
import { isReviewContext } from "./review-integrity.js";

export type ApprovalPolicy = "strict" | "balanced" | "permissive";
export type ApprovalStrategy = "legacy" | "mcp_managed";
export type ApprovalCli = "claude" | "codex" | "gemini" | "grok" | "mistral" | "devin";
export type ApprovalStatus = "approved" | "denied";

export interface ApprovalRequest {
  cli: ApprovalCli;
  operation: string;
  prompt: string;
  bypassRequested: boolean;
  fullAuto: boolean;
  requestedMcpServers: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  policy?: ApprovalPolicy;
  metadata?: Record<string, unknown>;
  reviewIntegrity?: ReviewIntegrityResult;
}

export interface ApprovalRecord {
  id: string;
  ts: string;
  status: ApprovalStatus;
  policy: ApprovalPolicy;
  cli: ApprovalCli;
  operation: string;
  score: number;
  reasons: string[];
  promptPreview: string;
  promptSha256: string;
  requestedMcpServers: string[];
  bypassRequested: boolean;
  fullAuto: boolean;
  metadata?: Record<string, unknown>;
  reviewIntegrity?: ReviewIntegrityResult;
}

function parsePolicy(policy?: ApprovalPolicy): ApprovalPolicy {
  if (policy) {
    return policy;
  }
  const envPolicy = (process.env.LLM_GATEWAY_APPROVAL_POLICY || "").trim();
  if (envPolicy === "strict" || envPolicy === "balanced" || envPolicy === "permissive") {
    return envPolicy;
  }
  return "balanced";
}

// F15: under MCP-managed approval, a full permission / sandbox bypass is a
// deny-by-default escalation — the heuristic score must not be able to approve
// it. Operators opt back in explicitly. `decide()` is only ever reached on the
// `approvalStrategy:"mcp_managed"` path.
export function bypassAllowedByOperator(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function promptPreview(prompt: string): string {
  if (process.env.APPROVAL_LOG_PROMPTS === "1") {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 280);
  }
  return "[redacted]";
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function parseLogLine(line: string): ApprovalRecord | null {
  try {
    return JSON.parse(line) as ApprovalRecord;
  } catch {
    return null;
  }
}

export class ApprovalManager {
  private readonly logPath: string;

  constructor(
    customPath?: string,
    private logger: Logger = noopLogger
  ) {
    this.logPath = customPath || join(homedir(), ".llm-cli-gateway", "approvals.jsonl");
    const dir = dirname(this.logPath);
    mkdirSync(dir, { recursive: true });
  }

  decide(request: ApprovalRequest): ApprovalRecord {
    const policy = parsePolicy(request.policy);
    const reasons: string[] = [];
    let score = 0;

    if (request.bypassRequested) {
      score += 3;
      reasons.push("Request includes full permission bypass");
    }

    if (request.fullAuto) {
      score += 2;
      reasons.push("Request enables full-auto execution");
    }

    if (request.bypassRequested && request.fullAuto) {
      score += 2;
      reasons.push("Request combines full permission bypass with full-auto execution");
    }

    // Per-server approval weights live in the MCP registry (the single strip
    // target). Iterate registry entries in declaration order so scoring is
    // deterministic and each requested server is counted at most once; a
    // stripped public build has an empty registry → no per-server weight.
    for (const [name, entry] of Object.entries(INTERNAL_MCP_REGISTRY)) {
      if (entry.approval && request.requestedMcpServers.includes(name)) {
        score += entry.approval.score;
        reasons.push(entry.approval.reason);
      }
    }

    if (request.allowedTools && request.allowedTools.length === 0) {
      // Independently verify review context from the prompt — never trust caller-supplied flags alone
      const promptIsReview = isReviewContext(request.prompt);
      if (promptIsReview) {
        score += 6;
        reasons.push("Empty allowedTools in review context — reviewers need tool access");
      } else {
        // Neutral score — tool restrictions should never reduce risk score
        // (prevents gaming via review-context evasion + restrictive tools = negative score)
        reasons.push("No tool permissions requested");
      }
    }

    if (request.disallowedTools && request.disallowedTools.length > 0) {
      const promptIsReviewForDisallowed = isReviewContext(request.prompt);
      const criticalTools = ["Read", "Grep", "Glob", "Bash"];
      // Canonicalize to handle scoped forms like "Read(*)", "Bash(git:*)"
      const canonicalized = request.disallowedTools.map(s => {
        const trimmed = s.trim();
        const cut = Math.min(
          ...[trimmed.indexOf("("), trimmed.indexOf(":")]
            .filter(i => i >= 0)
            .concat([trimmed.length])
        );
        return trimmed.slice(0, cut).trim();
      });
      const blockedCritical = criticalTools.filter(t => canonicalized.includes(t));
      if (promptIsReviewForDisallowed && blockedCritical.length > 0) {
        score += 6;
        reasons.push(
          `Critical review tools disallowed: ${blockedCritical.join(", ")} — reviewers need these`
        );
      } else {
        // Neutral score — tool restrictions should never reduce risk score
        reasons.push("Has explicit disallowed tool restrictions");
      }
    }

    if (
      /\b(delete|destroy|wipe|exfiltrate|credential|token|password|secret)\b/i.test(request.prompt)
    ) {
      score += 3;
      reasons.push("Prompt contains sensitive or destructive keywords");
    }

    if (request.reviewIntegrity && request.reviewIntegrity.violations.length > 0) {
      for (const violation of request.reviewIntegrity.violations) {
        // Skip empty_allowed_tools and critical_tools_disallowed — already handled in context-dependent scoring above
        if (
          violation.type === "empty_allowed_tools" ||
          violation.type === "critical_tools_disallowed"
        )
          continue;
        score += violation.score;
        reasons.push(`Review integrity: ${violation.detail}`);
      }
    }

    // F15: deny-by-default for full permission/sandbox bypass under MCP-managed
    // approval, regardless of score, unless the operator explicitly opted in.
    // (`fullAuto` — e.g. codex `--sandbox workspace-write` — is sandboxed and
    // stays score-governed; only the unsandboxed bypass is hard-denied.)
    const bypassDeniedByDefault = request.bypassRequested && !bypassAllowedByOperator();
    if (bypassDeniedByDefault) {
      reasons.push(
        "Full permission/sandbox bypass denied by default under MCP-managed approval " +
          "(set LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1 to permit)"
      );
    }

    // Balanced policy allows routine full-auto requests with standard MCP servers,
    // while still denying bypass/sensitive combinations.
    const threshold = policy === "strict" ? 2 : policy === "balanced" ? 5 : 7;
    const status: ApprovalStatus = bypassDeniedByDefault
      ? "denied"
      : score <= threshold
        ? "approved"
        : "denied";

    const record: ApprovalRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      status,
      policy,
      cli: request.cli,
      operation: request.operation,
      score,
      reasons,
      promptPreview: promptPreview(request.prompt),
      promptSha256: promptHash(request.prompt),
      requestedMcpServers: request.requestedMcpServers,
      bypassRequested: request.bypassRequested,
      fullAuto: request.fullAuto,
      metadata: request.metadata,
      reviewIntegrity: request.reviewIntegrity,
    };

    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    this.logger.info(`Approval decision: ${status} (score=${score}, policy=${policy})`, {
      cli: request.cli,
      operation: request.operation,
    });
    return record;
  }

  list(limit = 50, cli?: ApprovalCli): ApprovalRecord[] {
    if (!existsSync(this.logPath)) {
      return [];
    }

    const content = readFileSync(this.logPath, "utf-8");
    const rows = content
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(parseLogLine)
      .filter((row): row is ApprovalRecord => row !== null);

    const filtered = cli ? rows.filter(row => row.cli === cli) : rows;
    const result = filtered.slice(Math.max(0, filtered.length - limit)).reverse();
    this.logger.debug(`Approval list retrieved: ${result.length} records`, { cli, limit });
    return result;
  }
}
