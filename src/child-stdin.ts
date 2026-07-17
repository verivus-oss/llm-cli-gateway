import type { Writable } from "node:stream";

/** Stable, payload-safe metadata for a provider pipe that closes mid-request. */
export const CHILD_STDIN_INCOMPLETE_CODE = "ERR_CHILD_STDIN_INCOMPLETE";
export const CHILD_STDIN_INCOMPLETE_EXIT_CODE = 126;
export const CHILD_STDIN_INCOMPLETE_MESSAGE =
  "Provider stdin closed before the complete request payload was delivered";
export const CHILD_STDIN_WRITE_FAILED_CODE = "ERR_CHILD_STDIN_WRITE_FAILED";
export const CHILD_STDIN_WRITE_FAILED_MESSAGE =
  "Provider stdin failed before the complete request payload was delivered";

/** A provider exited cleanly without accepting the complete stdin request. */
export class ChildStdinIncompleteError extends Error {
  readonly code = CHILD_STDIN_INCOMPLETE_CODE;
  readonly retryable = false;

  constructor() {
    super(CHILD_STDIN_INCOMPLETE_MESSAGE);
    this.name = "ChildStdinIncompleteError";
  }
}

/** A payload-safe replacement for every non-closure child stdin failure. */
export class ChildStdinWriteFailedError extends Error {
  readonly code = CHILD_STDIN_WRITE_FAILED_CODE;
  readonly retryable = false;

  constructor() {
    super(CHILD_STDIN_WRITE_FAILED_MESSAGE);
    this.name = "ChildStdinWriteFailedError";
  }
}

/** Pipe-closure failures that are expected when the child exits or is killed. */
export function isBenignChildStdinClosureError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";
}

export type ChildStdinDeliveryError = ChildStdinIncompleteError | ChildStdinWriteFailedError;

/**
 * Replace a native stream failure with a fresh bounded diagnostic. Native
 * messages, names, stacks, causes, and attached fields can contain request or
 * provider-controlled bytes, so none of them may cross this boundary.
 */
export function normalizeChildStdinDeliveryError(error: unknown): ChildStdinDeliveryError {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === CHILD_STDIN_INCOMPLETE_CODE || isBenignChildStdinClosureError(error)) {
    return new ChildStdinIncompleteError();
  }
  return new ChildStdinWriteFailedError();
}

export type ChildStdinDeliveryState = "pending" | "succeeded" | "failed";

/** Request-owned observation of one child stdin delivery attempt. */
export interface ChildStdinDelivery {
  /**
   * `succeeded` means the complete payload write callback ran without error.
   * `pending` at child close is incomplete, even if a callback arrives later.
   */
  readonly state: ChildStdinDeliveryState;
  /** Remove owned stream listeners. Idempotent. */
  cleanup(): void;
}

/** Fail closed when child termination races ahead of the write callback. */
export function isChildStdinDeliveryIncomplete(
  delivery: ChildStdinDelivery | null | undefined
): boolean {
  return delivery !== null && delivery !== undefined && delivery.state !== "succeeded";
}

/**
 * Write one complete provider payload and close its stdin without exposing an
 * asynchronous Writable `error` event to the process-level uncaught handler.
 *
 * `Writable.write()` reports buffered failures through both its callback and a
 * later `error` event. The callback drives request/job failure handling, while
 * the listener remains installed long enough to consume that later event. The
 * listener remains installed through stream `close` (or explicit owner
 * cleanup), including the interval after `finish` where a child pipe can still
 * report a late asynchronous error. The returned observation exposes explicit
 * pending/succeeded/failed state and owns an idempotent cleanup.
 */
export function writeAndCloseChildStdin(
  stdin: Writable,
  payload: string,
  onError: (error: Error) => void
): ChildStdinDelivery {
  let cleaned = false;
  let reported = false;
  let state: ChildStdinDeliveryState = "pending";

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    stdin.off("error", handleError);
    stdin.off("close", cleanup);
  };
  const handleError = (error: Error): void => {
    state = "failed";
    if (reported) return;
    reported = true;
    onError(normalizeChildStdinDeliveryError(error));
  };

  stdin.on("error", handleError);
  stdin.once("close", cleanup);
  try {
    stdin.write(payload, error => {
      if (error) {
        handleError(error);
      } else if (state === "pending") {
        state = "succeeded";
      }
    });
    stdin.end();
  } catch (error) {
    handleError(normalizeChildStdinDeliveryError(error));
  }

  return {
    get state(): ChildStdinDeliveryState {
      return state;
    },
    cleanup,
  };
}
