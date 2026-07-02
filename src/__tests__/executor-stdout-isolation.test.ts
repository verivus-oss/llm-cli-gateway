import { describe, it, expect, vi } from "vitest";
import { executeCli } from "../executor.js";

/**
 * Phase 7 (acceptance #2): provider stdout/streaming output must be buffered
 * and returned as a value, NEVER forwarded to the gateway's own stdout, which
 * is reserved exclusively for the MCP JSON-RPC protocol. Human-readable /
 * progress output goes to stderr.
 *
 * Mutation that flips these red: adding `process.stdout.write(text)` (or piping
 * the child's stdout to `process.stdout`) in executor.ts's handleOutputChunk.
 */
describe("executor stdout isolation (MCP protocol channel is not polluted)", () => {
  it("does not forward child stdout to process.stdout", async () => {
    const MARKER = "PROVIDER_STDOUT_MARKER_9f3a";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let result;
    try {
      result = await executeCli(process.execPath, [
        "-e",
        `process.stdout.write(${JSON.stringify(MARKER)})`,
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }

    // The child DID emit the marker on ITS stdout; the executor captured it.
    expect(result.stdout).toContain(MARKER);
    // But the gateway process stdout was never written with the child's output.
    const forwarded = stdoutSpy.mock.calls.some(call => String(call[0]).includes(MARKER));
    expect(forwarded).toBe(false);
  });

  it("does not forward child stderr to process.stdout either", async () => {
    const MARKER = "PROVIDER_STDERR_MARKER_c71b";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let result;
    try {
      result = await executeCli(process.execPath, [
        "-e",
        `process.stderr.write(${JSON.stringify(MARKER)})`,
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(result.stderr).toContain(MARKER);
    const forwarded = stdoutSpy.mock.calls.some(call => String(call[0]).includes(MARKER));
    expect(forwarded).toBe(false);
  });
});
