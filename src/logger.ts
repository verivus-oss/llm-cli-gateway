export interface Logger {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
  /** Optional: callers that want explicit WARN routing can implement this. */
  warn?(message: string, meta?: unknown): void;
}

export const noopLogger: Logger = {
  info: () => {},
  error: () => {},
  debug: () => {},
  warn: () => {},
};

/**
 * Emit a warning through whichever logger surface is available. Some Logger
 * implementations (legacy) only provide `info`/`error`/`debug`; in that case
 * the message is prefixed with `[WARN]` and routed through `info` so it still
 * reaches stderr.
 */
export function logWarn(logger: Logger, message: string, meta?: unknown): void {
  if (typeof logger.warn === "function") {
    logger.warn(message, meta);
    return;
  }
  logger.info(`[WARN] ${message}`, meta);
}
