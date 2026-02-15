import { describe, it, expect } from "vitest";
import { createCircuitBreaker, withRetry, CircuitBreakerState } from "../retry.js";

describe("retry transient classification", () => {
  it("should not retry exit code 125 (idle timeout — non-transient)", async () => {
    const cb = createCircuitBreaker();
    let attempts = 0;

    const op = async () => {
      attempts++;
      const err = new Error("idle timeout") as Error & { code?: number };
      err.code = 125;
      throw err;
    };

    await expect(withRetry(op, cb)).rejects.toThrow("non-transient");
    expect(attempts).toBe(1);
    // Circuit breaker should NOT increment failures for non-transient errors
    expect(cb.failures).toBe(0);
    expect(cb.state).toBe(CircuitBreakerState.CLOSED);
  });

  it("should retry exit code 124 (wall-clock timeout — transient)", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    let attempts = 0;

    const op = async () => {
      attempts++;
      const err = new Error("timeout") as Error & { code?: number };
      err.code = 124;
      throw err;
    };

    await expect(withRetry(op, cb)).rejects.toThrow();
    expect(attempts).toBe(3); // retried up to failureThreshold
    expect(cb.failures).toBe(3);
    expect(cb.state).toBe(CircuitBreakerState.OPEN);
  });

  it("should not retry ENOENT (command not found — non-transient)", async () => {
    const cb = createCircuitBreaker();
    let attempts = 0;

    const op = async () => {
      attempts++;
      const err = new Error("spawn ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    };

    await expect(withRetry(op, cb)).rejects.toThrow("non-transient");
    expect(attempts).toBe(1);
  });

  it("should retry ECONNRESET (network error — transient)", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2 });
    let attempts = 0;

    const op = async () => {
      attempts++;
      const err = new Error("connection reset") as Error & { code?: string };
      err.code = "ECONNRESET";
      throw err;
    };

    await expect(withRetry(op, cb)).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it("should not retry unknown error codes (non-transient by default)", async () => {
    const cb = createCircuitBreaker();
    let attempts = 0;

    const op = async () => {
      attempts++;
      const err = new Error("something unexpected") as Error & { code?: number };
      err.code = 42;
      throw err;
    };

    await expect(withRetry(op, cb)).rejects.toThrow("non-transient");
    expect(attempts).toBe(1);
  });
});
