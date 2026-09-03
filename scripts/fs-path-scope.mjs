/**
 * Which modules answer the question `security/detect-non-literal-fs-filename`
 * asks, and which only look like they do.
 *
 * The rule fires on every `readFileSync(somePath)` in a program whose job is
 * reading paths. Left on everywhere it produced 580 warnings across 70 files,
 * which is a list nobody reads: measured on 2026-09-03, a genuine finding of my
 * own sat inside it unseen.
 *
 * The question the rule is a proxy for is narrower: does a value the CALLER
 * supplied reach the filesystem. A gateway tool parameter (correlationId,
 * sessionId, workingDir, a workspace alias, a worktree name, promptFile,
 * agentConfig, an export path, a skill name) crossing into a path is worth
 * looking at. An operator's own config file, a bundled data file, or a
 * gateway-owned cache directory is not, and neither is any of `scripts/`, which
 * a developer runs against their own checkout.
 *
 * Both lists are checked against the tree by
 * `scripts/check-fs-path-scope.mjs`, so a new module reaching the filesystem
 * with a computed path has to be classified here deliberately rather than
 * joining a warning count nobody reads.
 */

/** Caller-supplied input reaches a path here. The rule stays on. */
export const CALLER_INFLUENCED_FS_MODULES = [
  "src/claude-mcp-config.ts",
  "src/codex-kit-isolation.ts",
  "src/devin-transcript.ts",
  "src/executor.ts",
  "src/index.ts",
  "src/job-replay-context.ts",
  "src/mistral-kit-isolation.ts",
  "src/mistral-meta-json-parser.ts",
  "src/personal-config.ts",
  "src/request-helpers.ts",
  "src/review-scope.ts",
  "src/session-manager.ts",
  "src/skill-loader.ts",
  "src/workspace-registry.ts",
  "src/worktree-manager.ts",
];

/**
 * Reaches the filesystem with a computed path that no caller can influence:
 * an operator's configuration, a bundled data file, a gateway-owned cache or
 * database path, or a CLI entrypoint the operator invokes directly. Each entry
 * is an assertion about provenance, not about safety.
 */
export const GATEWAY_OWNED_FS_MODULES = [
  "src/approval-manager.ts",
  "src/async-job-manager.ts",
  "src/config.ts",
  "src/doctor.ts",
  "src/entrypoint-url.ts",
  "src/flight-recorder.ts",
  "src/job-store.ts",
  "src/mcp-registry.ts",
  "src/migrate-sessions.ts",
  "src/migrate.ts",
  "src/model-registry.ts",
  "src/process-monitor.ts",
  "src/provider-admin-tools.ts",
  "src/provider-capability-cache.ts",
  "src/provider-capability-discovery.ts",
  "src/provider-status.ts",
  "src/provider-surface.ts",
  "src/provider-tool-capabilities.ts",
  "src/sqlite-driver.ts",
  "src/storage-cli.ts",
];
