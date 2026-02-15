/**
 * A module for adding retry and circuit breaker logic to asynchronous operations.
 *
 * @module retry
 */

/**
 * Defines the possible states of the circuit breaker.
 */
export enum CircuitBreakerState {
  /** The circuit is closed and allows operations to execute. */
  CLOSED = 'CLOSED',
  /** The circuit is open and fails operations immediately. */
  OPEN = 'OPEN',
  /** The circuit is half-open and allows a single trial operation. */
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Represents the state and configuration of a circuit breaker.
 */
export interface CircuitBreaker {
  state: CircuitBreakerState;
  failures: number;
  lastFailureTime: number | null;
  readonly resetTimeout: number; // ms
  readonly failureThreshold: number;
  onStateChange?: (newState: CircuitBreakerState, error?: Error) => void;
}

/**
 * Configuration options for the retry logic.
 */
export interface RetryOptions {
  /** The initial delay in milliseconds before the first retry. */
  initialDelay: number;
  /** The maximum delay in milliseconds between retries. */
  maxDelay: number;
  /** The exponential backoff factor. */
  factor: number;
  /**
   * A function that determines if an error is transient and should be retried.
   * @param error The error to check.
   * @returns `true` if the error is transient, otherwise `false`.
   */
  isTransient: (error: any) => boolean;
  /**
   * A callback function executed on each retry attempt.
   * @param error The error that caused the retry.
   * @param attempt The current retry attempt number.
   * @param delay The delay in milliseconds before the next attempt.
   */
  onRetry: (error: any, attempt: number, delay: number) => void;
}

/**
 * Default function to determine if an error is transient.
 * Retries on timeout (exit code 124) and common network errors.
 * Does not retry on file-not-found (ENOENT) or other errors.
 * @param error The error object.
 * @returns True if the error is considered transient.
 */
const isDefaultTransient = (error: any): boolean => {
  if (!error) {
    return false;
  }

  // Shell command-related errors
  if (error.code === 124) { // wall-clock timeout (explicit, caller-set) — transient
    return true;
  }
  // Note: exit code 125 = idle timeout (stuck process) — intentionally non-transient
  if (error.code === 'ENOENT') { // command not found
    return false;
  }

  // Node.js network errors
  const transientErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'];
  if (transientErrorCodes.includes(error.code)) {
    return true;
  }

  return false;
};

/**
 * Creates a new CircuitBreaker instance with default settings.
 * @param options Partial options to override defaults.
 * @returns A new CircuitBreaker instance.
 */
export function createCircuitBreaker(options?: {
  resetTimeout?: number,
  failureThreshold?: number,
  onStateChange?: (newState: CircuitBreakerState, error?: Error) => void
}): CircuitBreaker {
  return {
    state: CircuitBreakerState.CLOSED,
    failures: 0,
    lastFailureTime: null,
    resetTimeout: options?.resetTimeout ?? 60000, // 60 seconds
    failureThreshold: options?.failureThreshold ?? 5,
    onStateChange: options?.onStateChange,
  };
}

/**
 * Wraps an asynchronous operation with retry and circuit breaker logic.
 *
 * @template T The return type of the operation.
 * @param {() => Promise<T>} operation The asynchronous operation to execute.
 * @param {CircuitBreaker} circuitBreaker The circuit breaker instance to use.
 * @param {Partial<RetryOptions>} [retryOptions] Options for retry behavior.
 * @returns {Promise<T>} A promise that resolves with the result of the operation.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  circuitBreaker: CircuitBreaker,
  retryOptions?: Partial<RetryOptions>,
): Promise<T> {
  const wrapError = (message: string, error?: any): Error => {
    const wrapped = new Error(message) as Error & { code?: any; result?: any; cause?: any };
    if (error) {
      wrapped.cause = error;
      if ("code" in error) {
        wrapped.code = error.code;
      }
      if ("result" in error) {
        wrapped.result = error.result;
      }
    }
    return wrapped;
  };

  const options: RetryOptions = {
    initialDelay: 1000, // 1s
    maxDelay: 30000, // 30s
    factor: 2,
    isTransient: isDefaultTransient,
    onRetry: (error, attempt, delay) => {
      console.warn(
        `[Retry] Attempt ${attempt} failed with transient error. Retrying in ${delay}ms...`,
        error.message,
      );
    },
    ...retryOptions,
  };

  if (circuitBreaker.state === CircuitBreakerState.OPEN) {
    const timeSinceFailure = Date.now() - (circuitBreaker.lastFailureTime ?? 0);
    if (timeSinceFailure > circuitBreaker.resetTimeout) {
      circuitBreaker.state = CircuitBreakerState.HALF_OPEN;
      circuitBreaker.onStateChange?.(CircuitBreakerState.HALF_OPEN);
    } else {
      const remaining = Math.ceil((circuitBreaker.resetTimeout - timeSinceFailure) / 1000);
      throw wrapError(
        `[CircuitBreaker] Circuit is open. Failing fast. Will not try for another ${remaining}s.`,
      );
    }
  }

  const maxAttempts = circuitBreaker.failureThreshold;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();

      if (circuitBreaker.failures > 0 || circuitBreaker.state === CircuitBreakerState.HALF_OPEN) {
        const oldState = circuitBreaker.state;
        circuitBreaker.failures = 0;
        circuitBreaker.lastFailureTime = null;
        circuitBreaker.state = CircuitBreakerState.CLOSED;
        if(oldState !== CircuitBreakerState.CLOSED) {
            circuitBreaker.onStateChange?.(CircuitBreakerState.CLOSED);
        }
      }

      return result;
    } catch (error: any) {
      if (!options.isTransient(error)) {
        throw wrapError(`[CircuitBreaker] Operation failed with non-transient error: ${error.message}`, error);
      }

      circuitBreaker.failures++;
      circuitBreaker.lastFailureTime = Date.now();

      if (circuitBreaker.state === CircuitBreakerState.HALF_OPEN) {
        circuitBreaker.state = CircuitBreakerState.OPEN;
        circuitBreaker.onStateChange?.(CircuitBreakerState.OPEN, error);
        throw wrapError(
          `[CircuitBreaker] Circuit re-opened after failed attempt in HALF_OPEN state. Last error: ${error.message}`,
          error,
        );
      }

      if (circuitBreaker.failures >= circuitBreaker.failureThreshold) {
        const oldState = circuitBreaker.state;
        circuitBreaker.state = CircuitBreakerState.OPEN;
        if(oldState === CircuitBreakerState.CLOSED) {
            circuitBreaker.onStateChange?.(CircuitBreakerState.OPEN, error);
        }
        throw wrapError(
          `[CircuitBreaker] Circuit opened after ${circuitBreaker.failures} consecutive failures. Last error: ${error.message}`,
          error,
        );
      }

      if (attempt === maxAttempts) {
        throw error;
      }

      const delay = Math.min(options.initialDelay * options.factor ** (attempt - 1), options.maxDelay);
      options.onRetry(error, attempt, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('[Retry] Operation failed after all retry attempts.');
}
