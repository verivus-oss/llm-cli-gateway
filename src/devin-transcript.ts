/**
 * Where a devin run's conversation export goes, and why it is on by default.
 *
 * Measured in docs/evidence/c1-capture-ceiling-2026-09-02.md: for a one-line
 * task devin wrote 23 bytes to stdout and 92,093 bytes to `--export`. The
 * export is an ATIF document carrying the system prompt, the tool definitions,
 * the token totals, and the instruction files in force VERBATIM with their
 * paths. It is the only devin record a run can be reconstructed from, and the
 * gateway was not asking for it.
 *
 * A bare `--export` was measured to produce no file this gateway could find, so
 * the path is supplied rather than left to the CLI's default.
 *
 * The async job manager harvests the exact correlation-keyed file after close,
 * copies it into the bounded durable record, and removes the source only after
 * the owner-fenced store write succeeds.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEVIN_TRANSCRIPT_DIRNAME = "devin-transcripts";

/** The gateway-owned directory devin exports are written into. */
export function devinTranscriptDirectory(home: string = homedir()): string {
  return join(home, ".llm-cli-gateway", DEVIN_TRANSCRIPT_DIRNAME);
}

/**
 * A correlation id is caller-supplied, so it is never used as a path segment
 * unaltered: the readable part is reduced to a safe alphabet for a human
 * looking for one file, and a digest of the ORIGINAL carries the identity that
 * the reduction would otherwise collide away.
 */
export function devinTranscriptFilename(correlationId: string): string {
  const readable = correlationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(correlationId).digest("hex").slice(0, 12);
  return `${readable}-${digest}.json`;
}

export function devinTranscriptPath(correlationId: string, home: string = homedir()): string {
  return join(devinTranscriptDirectory(home), devinTranscriptFilename(correlationId));
}

/**
 * Create the directory, 0o700. Returns the path, or null when the directory
 * cannot be made: a transcript is evidence, not a precondition, so a request
 * still runs without one rather than failing on a filesystem problem.
 */
export function ensureDevinTranscriptPath(
  correlationId: string,
  home: string = homedir()
): string | null {
  try {
    mkdirSync(devinTranscriptDirectory(home), { recursive: true, mode: 0o700 });
    return devinTranscriptPath(correlationId, home);
  } catch {
    return null;
  }
}

/**
 * Canonicalise the export path out of the dedup identity.
 *
 * The path contains the correlation id, which is different on every request, so
 * leaving it in argv would make two identical requests look different and
 * silently disable dedup for devin. Same reasoning as the Claude MCP config
 * path, and the same shape of fix: replace that ONE argv element, keep the
 * rest, and keep the launched argv untouched.
 */
export function devinTranscriptDedupArgs(args: readonly string[], path: string | null): string[] {
  if (!path) return [...args];
  const at = args.indexOf(path);
  if (at < 0) return [...args];
  const canonical = [...args];
  canonical[at] = "[gateway-devin-transcript]";
  return canonical;
}
